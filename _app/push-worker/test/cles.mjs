// Test de la clé du contenu des voyages, gardée par le Worker : wrangler dev + faux GitHub local.
// Vérifie : remise réservée aux comptes assignés, première remise (migration d'un voyage à phrase), chiffrement au repos,
// publication avec la clé actuelle ou une nouvelle, enveloppe pour le voyageur approuvé, renouvellement automatique.
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRIPS_TEST, premierAdmin, accompagnateur, chiffrerVoyage, nouvelleCle, CLE_MAITRE_TEST } from "./outils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GH_PORT = 9916, WORKER_PORT = 8794;
const W = `http://127.0.0.1:${WORKER_PORT}`;
const ORIGIN = "https://monaccompagnateur.ca";
const A = "solden-voyage-2027", B = "st-anton-mars2027";
const ADMIN_TOKEN = "adm-" + crypto.randomBytes(8).toString("hex");
const GH_TOKEN = "github_pat_test_" + crypto.randomBytes(6).toString("hex");
const REPO = "Matlavigne/matlavigne.github.io";
const subtle = crypto.webcrypto.subtle;

let failures = 0;
const check = (c, l) => { console.log(`${c ? "  ok " : "  ÉCHEC"}  ${l}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- contenu de départ : Sölden chiffré avec la clé K1 (comme un voyage à phrase), St. Anton avec K9 ----------
const { cle: K1, contenu: c1 } = await chiffrerVoyage({ titre: "Sölden", programme: [1] });
const { cle: K9, contenu: c9 } = await chiffrerVoyage({ titre: "St. Anton", programme: [9] });

// ---------- faux GitHub (API contents) ----------
const files = new Map();
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
files.set(`${A}/voyage.json`, { content: c1, sha: sha1(c1) });
files.set(`${B}/voyage.json`, { content: c9, sha: sha1(c9) });
for (const t of [A, B]) { const f = JSON.stringify({ id: t, station: "soelden", titre: t }); files.set(`_app/voyages/${t}.json`, { content: f, sha: sha1(f) }); }
const gh = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
    const m = req.url.match(new RegExp(`^/repos/${REPO}/contents/([^?]+)`));
    if (!m) return send(404, { message: "Not Found" });
    const p = decodeURIComponent(m[1]);
    if (req.method === "GET") { const f = files.get(p); return f ? send(200, { sha: f.sha, content: Buffer.from(f.content).toString("base64") }) : send(404, { message: "Not Found" }); }
    if (req.method === "PUT") {
      const j = JSON.parse(body); const f = files.get(p);
      if (f && j.sha !== f.sha) return send(409, { message: "sha mismatch" });
      const content = Buffer.from(j.content, "base64").toString("utf8");
      const nf = { content, sha: sha1(content) }; files.set(p, nf);
      return send(200, { content: { sha: nf.sha }, commit: { sha: sha1("c" + content) } });
    }
    send(405, {});
  });
});
await new Promise((r) => gh.listen(GH_PORT, "127.0.0.1", r));

// ---------- Worker ----------
fs.writeFileSync(path.join(root, ".dev.vars"), ["VAPID_PUBLIC_KEY=x", CLE_MAITRE_TEST, `ADMIN_TOKEN=${ADMIN_TOKEN}`, TRIPS_TEST, `GITHUB_TOKEN=${GH_TOKEN}`, `GITHUB_API=http://127.0.0.1:${GH_PORT}`].join("\n") + "\n");
fs.rmSync(path.join(root, ".wrangler"), { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
execFileSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--local", "--file=schema.sql"], { cwd: root, env, stdio: "pipe" });
const wr = spawn("npx", ["wrangler", "dev", "--local", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let wrOut = "";
wr.stdout.on("data", (d) => (wrOut += d)); wr.stderr.on("data", (d) => (wrOut += d));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${W}/api/vapid`)).ok) break; } catch {}
  if (i > 60) throw new Error("wrangler dev ne démarre pas :\n" + wrOut);
  await sleep(500);
}
const call = async (method, p, body, key) => {
  const r = await fetch(W + p, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--local", "--json", "--command", sql], { cwd: root, env, stdio: "pipe" }).toString())[0].results;

// Téléphone d'un voyageur : paire ECDH; ouvre l'enveloppe reçue comme l'app
async function telephone() {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const j = await subtle.exportKey("jwk", kp.publicKey);
  return { kp, pub: { kty: "EC", crv: "P-256", x: j.x, y: j.y } };
}
async function ouvrir(tel, c) {
  const epk = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: c.epk.x, y: c.epk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const k = await subtle.deriveKey({ name: "ECDH", public: epk }, tel.kp.privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return JSON.parse(Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(c.iv, "base64url") }, k, Buffer.from(c.data, "base64url"))).toString());
}

try {
  const adm = await premierAdmin(call, ADMIN_TOKEN);
  const julie = await accompagnateur(call, adm, "julie.b", [A]);
  const marc = await accompagnateur(call, adm, "marc.g", [B]);
  const sha = (t) => files.get(`${t}/voyage.json`).sha;

  console.log("\nRemise de la clé");
  let r = await call("GET", `/api/voyage/cle?trip=${A}`);
  check(r.status === 401, `sans compte : refusée (${r.status})`);
  r = await call("GET", `/api/voyage/cle?trip=${A}`, null, marc);
  check(r.status === 403, `compte d'un autre voyage : refusée (${r.status})`);
  r = await call("GET", `/api/voyage/cle?trip=${A}`, null, julie);
  check(r.status === 200 && r.json.sel === null, "voyage pas encore migré : aucune clé sur le serveur");

  console.log("\nPremière remise (voyage chiffré autrefois avec une phrase)");
  r = await call("POST", "/api/voyage/cle", { trip: A, cle: K1 }, marc);
  check(r.status === 403, `compte d'un autre voyage : refusée (${r.status})`);
  r = await call("POST", "/api/voyage/cle", { trip: A, cle: { sel: K1.sel, k: nouvelleCle().k } }, julie);
  check(r.status === 400, `clé qui n'ouvre pas le contenu en ligne : refusée (${r.status})`);
  r = await call("POST", "/api/voyage/cle", { trip: A, cle: { sel: "court", k: "x" } }, julie);
  check(r.status === 400, `clé mal formée : refusée (${r.status})`);
  r = await call("POST", "/api/voyage/cle", { trip: A, cle: K1 }, julie);
  check(r.status === 200, `bonne clé : gardée (${r.status} ${r.json.erreur || ""})`);
  check((await call("POST", "/api/voyage/cle", { trip: A, cle: K1 }, julie)).status === 200, "même clé remise de nouveau : accepté sans changement");
  check((await call("POST", "/api/voyage/cle", { trip: A, cle: nouvelleCle() }, julie)).status === 409, "une autre clé par cette route : refusée (le changement passe par la publication)");
  r = await call("GET", `/api/voyage/cle?trip=${A}`, null, julie);
  check(r.status === 200 && r.json.sel === K1.sel && r.json.k === K1.k, "l'accompagnateur assigné reçoit la clé");
  r = await call("GET", `/api/voyage/cle?trip=${A}`, null, adm);
  check(r.status === 200 && r.json.k === K1.k, "l'administrateur aussi");
  const rangée = d1(`SELECT * FROM cles_voyage WHERE trip = '${A}'`)[0];
  const kHex = Buffer.from(K1.k, "base64").toString("hex");
  check(rangée && !JSON.stringify(rangée).includes(K1.k) && !Buffer.from(rangée.data, "base64").toString("hex").includes(kHex), "dans la base, la clé est chiffrée (rien en clair)");

  console.log("\nAccompagnateur assigné plus tard");
  const luc = await accompagnateur(call, adm, "luc.t", []);
  check((await call("GET", `/api/voyage/cle?trip=${A}`, null, luc)).status === 403, "pas encore assigné : refusée");
  r = await call("POST", "/api/admin/acces", { trip: A, comptes: ["julie.b", "luc.t"] }, adm);
  check(r.status === 200, `l'administrateur assigne Luc (${r.status} ${r.json.erreur || ""})`);
  r = await call("GET", `/api/voyage/cle?trip=${A}`, null, luc);
  check(r.status === 200 && r.json.k === K1.k, "dès qu'il est assigné, il reçoit la clé (aucune phrase)");
  await call("POST", "/api/admin/acces", { trip: A, comptes: ["julie.b"] }, adm);
  check((await call("GET", `/api/voyage/cle?trip=${A}`, null, luc)).status === 403, "retiré du voyage : plus de clé");

  console.log("\nVoyageur approuvé");
  const tel = await telephone(), tel2 = await telephone();
  r = await call("POST", "/api/acces/demande", { trip: A, nom: "Paul Tremblay", pub: tel.pub });
  const dem = r.json;
  r = await call("POST", "/api/acces/demande", { trip: A, nom: "Anne Roy", pub: tel2.pub });
  const dem2 = r.json;
  r = await call("POST", "/api/acces/decision", { trip: A, decisions: [{ id: dem.id, ok: true }, { id: dem2.id, ok: true }] }, julie);
  check(r.status === 200 && r.json.approuvees === 2, `approbation sans enveloppe envoyée par l'app (${r.status} ${r.json.erreur || ""})`);
  r = await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton);
  let recu = r.json.cle ? await ouvrir(tel, r.json.cle) : null;
  check(recu && recu.salt === K1.sel && recu.k === K1.k, "le téléphone du voyageur ouvre la clé que le serveur a chiffrée pour lui");
  r = await call("POST", "/api/acces/decision", { trip: A, decisions: [{ id: dem2.id, retirer: true }] }, julie);
  check(r.json.retirees === 1, "accès d'Anne retiré");

  console.log("\nPublication");
  const { contenu: c1b } = await chiffrerVoyage({ titre: "Sölden", programme: [2] }, K1);
  r = await call("POST", "/api/publier", { trip: A, content: c1b, sha: sha(A) }, julie);
  check(r.status === 200 && !r.json.cleChangee, `publication avec la clé actuelle (${r.status} ${r.json.erreur || ""})`);
  const { cle: K2, contenu: c2 } = await chiffrerVoyage({ titre: "Sölden", programme: [3] });
  r = await call("POST", "/api/publier", { trip: A, content: c2, sha: sha(A) }, julie);
  check(r.status === 409, `contenu chiffré avec une autre clé, sans la donner : refusé (${r.status})`);
  r = await call("POST", "/api/publier", { trip: A, content: c2, sha: sha(A), cle: nouvelleCle() }, julie);
  check(r.status === 400, `nouvelle clé qui n'ouvre pas le contenu : refusée (${r.status})`);
  r = await call("POST", "/api/publier", { trip: A, content: c2, sha: sha(A), cle: K2 }, julie);
  check(r.status === 200 && r.json.cleChangee && r.json.renouveles === 1, `changement de clé publié; 1 voyageur approuvé renouvelé (${r.status} ${r.json.erreur || ""} ${r.json.renouveles})`);
  r = await call("GET", `/api/voyage/cle?trip=${A}`, null, julie);
  check(r.json.sel === K2.sel && r.json.k === K2.k, "le serveur garde la nouvelle clé");
  r = await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton);
  recu = r.json.cle ? await ouvrir(tel, r.json.cle) : null;
  check(recu && recu.salt === K2.sel && recu.k === K2.k, "le voyageur approuvé reçoit la nouvelle clé, sans rien faire");
  r = await call("GET", "/api/acces/etat?id=" + dem2.id, null, dem2.jeton);
  check(r.json.statut === "retire" && !r.json.cle, "le voyageur retiré ne la reçoit pas");
  r = await call("POST", "/api/publier", { trip: A, content: c1b, sha: sha(A) }, julie);
  check(r.status === 409, `republier l'ancien contenu (ancienne clé) : refusé (${r.status})`);

  console.log("\nVoyage sans clé sur le serveur (ancien fonctionnement)");
  r = await call("POST", "/api/publier", { trip: B, content: (await chiffrerVoyage({ programme: [] }, K9)).contenu, sha: sha(B) }, marc);
  check(r.status === 200, `publication encore possible avant la migration (${r.status} ${r.json.erreur || ""})`);
} finally {
  wr.kill("SIGINT");
  gh.close();
  fs.rmSync(path.join(root, ".dev.vars"), { force: true });
}
console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
process.exit(failures ? 1 : 0);

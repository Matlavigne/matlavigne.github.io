// Test de l'administration : création d'un voyage (un seul commit), clé d'éditeur, clôture.
// wrangler dev + faux GitHub local (API contents et Git Data).
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GH_PORT = 9914, WORKER_PORT = 8796;
const W = `http://127.0.0.1:${WORKER_PORT}`;
const ORIGIN = "https://monaccompagnateur.ca";
const ADMIN_TOKEN = "adm-" + crypto.randomBytes(8).toString("hex");
let ADMIN = null; // session administrateur (créée après le démarrage)
const GH_TOKEN = "github_pat_test";
const REPO = "Matlavigne/matlavigne.github.io";

let failures = 0;
const check = (c, l) => { console.log(`${c ? "  ok " : "  ÉCHEC"}  ${l}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");

// ---------- faux GitHub ----------
const files = new Map(); // chemin -> Buffer
const put = (p, s) => files.set(p, Buffer.from(s));
put("_app/stations/stanton.json", JSON.stringify({ id: "stanton", nom: "St. Anton", lieu: "Ski Arlberg · Autriche", pays: "Autriche", fuseau: "Europe/Vienna" }));
put("_app/voyages/st-anton-mars2027.json", JSON.stringify({ id: "st-anton-mars2027", station: "stanton", titre: "Gendronski St. Anton", dates: "6 au 14 mars 2027", appCourt: "St. Anton" }));
put("st-anton-mars2027/voyage.json", "{}");
put("voyages.json", JSON.stringify({ site: {}, voyages: [{ titre: "Ancien" }] }));
const blobs = new Map(), trees = new Map(), commits = new Map();
let head = "c0"; commits.set("c0", { tree: "t0" });
let commitCount = 0;
const gh = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, {});
    const u = new URL(req.url, "http://x"); const p = u.pathname.replace(`/repos/${REPO}`, "");
    let m;
    if (req.method === "GET" && (m = p.match(/^\/contents\/(.+)$/))) {
      const fp = decodeURIComponent(m[1]);
      if (files.has(fp)) return send(200, { sha: sha1(files.get(fp)), content: files.get(fp).toString("base64") });
      const kids = [...files.keys()].filter((k) => k.startsWith(fp + "/") && !k.slice(fp.length + 1).includes("/"));
      return kids.length ? send(200, kids.map((k) => ({ name: k.split("/").pop(), path: k, type: "file" }))) : send(404, {});
    }
    if (req.method === "GET" && p === "/git/ref/heads/main") return send(200, { object: { sha: head } });
    if (req.method === "GET" && (m = p.match(/^\/git\/commits\/(.+)$/))) return send(200, { sha: m[1], tree: { sha: commits.get(m[1]).tree } });
    const j = body ? JSON.parse(body) : {};
    if (req.method === "POST" && p === "/git/blobs") { const b = j.encoding === "base64" ? Buffer.from(j.content, "base64") : Buffer.from(j.content); const s = sha1(b); blobs.set(s, b); return send(201, { sha: s }); }
    if (req.method === "POST" && p === "/git/trees") { const s = "t" + trees.size + 1; trees.set(s, j.tree); return send(201, { sha: s }); }
    if (req.method === "POST" && p === "/git/commits") { const s = "c" + (commits.size); commits.set(s, { tree: j.tree, message: j.message, parents: j.parents }); return send(201, { sha: s }); }
    if (req.method === "PATCH" && p === "/git/refs/heads/main") {
      const c = commits.get(j.sha); if (c.parents[0] !== head) return send(422, {});
      for (const e of trees.get(c.tree)) files.set(e.path, blobs.get(e.sha));
      head = j.sha; commitCount++; return send(200, { object: { sha: head } });
    }
    send(404, {});
  });
});
await new Promise((r) => gh.listen(GH_PORT, "127.0.0.1", r));

// ---------- Worker ----------
fs.writeFileSync(path.join(root, ".dev.vars"), [
  "VAPID_PUBLIC_KEY=x", ...(process.env.SERVIR ? ["ALLOWED_ORIGINS=http://127.0.0.1:8092"] : []), `ADMIN_TOKEN=${ADMIN_TOKEN}`, `GITHUB_TOKEN=${GH_TOKEN}`, `GITHUB_API=http://127.0.0.1:${GH_PORT}`, `EDITOR_TOKENS={}`,
].join("\n") + "\n");
fs.rmSync(path.join(root, ".wrangler"), { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
execFileSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--local", "--file=schema.sql"], { cwd: root, env, stdio: "pipe" });
const wr = spawn("npx", ["wrangler", "dev", "--local", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let wrOut = ""; wr.stdout.on("data", (d) => (wrOut += d)); wr.stderr.on("data", (d) => (wrOut += d));
for (let i = 0; ; i++) { try { if ((await fetch(`${W}/api/vapid`)).ok) break; } catch {} if (i > 60) throw new Error(wrOut); await sleep(500); }
const call = async (method, p, body, key) => {
  const r = await fetch(W + p, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const chiffre = JSON.stringify({ titre: "T", debut: "2028-02-05", fin: "2028-02-12", chiffre: { v: 1, salt: "c2Fs", iv: "aXY=", data: "ZGF0YQ==" } });
const photo = "data:image/jpeg;base64," + Buffer.from("faux jpeg").toString("base64");
const nv = { id: "st-anton-fevrier2028", station: "stanton", titre: "Gendronski St. Anton", appCourt: "St. Anton 2028", dates: "5 au 12 février 2028", debut: "2028-02-05", fin: "2028-02-12", contenu: chiffre, photo, credit: "Photo : <b>moi</b>", accueil: true };

if (process.env.SERVIR) {
  console.log("PRET " + ADMIN_TOKEN + " " + W);
  process.on("SIGTERM", () => { wr.kill("SIGINT"); gh.close(); fs.rmSync(path.join(root, ".dev.vars"), { force: true }); process.exit(0); });
  await new Promise(() => {});
}
{ // administrateur avec double authentification
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const dec = (s) => { let bits = 0, v = 0; const o = []; for (const c of s) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
  const totp = (sec) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = crypto.createHmac("sha1", dec(sec)).update(m).digest(); const o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0"); };
  let r = await call("POST", "/api/auth/premier-admin", { jeton: ADMIN_TOKEN, username: "admin", password: "mot-de-passe-test" });
  ADMIN = r.json.session;
  r = await call("POST", "/api/auth/2fa/debut", {}, ADMIN);
  await call("POST", "/api/auth/2fa/activer", { code: totp(r.json.secret) }, ADMIN);
}
try {
  console.log("\nAccès");
  check([401, 403].includes((await call("GET", "/api/admin/etat")).status), "sans session : refusé");
  check([401, 403].includes((await call("GET", "/api/admin/etat", null, "s.mauvaise")).status), "mauvaise session : refusée");
  let r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(r.status === 200 && r.json.stations[0].id === "stanton" && r.json.voyages[0].id === "st-anton-mars2027", `état : stations et voyages lus (${r.status} ${r.json.erreur || ""})`);

  console.log("\nCréation");
  r = await call("POST", "/api/admin/voyages", { ...nv, id: "../x" }, ADMIN);
  check(r.status === 400, "adresse invalide refusée");
  r = await call("POST", "/api/admin/voyages", { ...nv, id: "st-anton-mars2027" }, ADMIN);
  check(r.status === 409, "adresse déjà prise refusée");
  r = await call("POST", "/api/admin/voyages", { ...nv, contenu: JSON.stringify({ programme: [] }) }, ADMIN);
  check(r.status === 400, "contenu en clair refusé");
  r = await call("POST", "/api/admin/voyages", { ...nv, station: "inconnue" }, ADMIN);
  check(r.status === 400, "station inconnue refusée");
  const before = commitCount;
  r = await call("POST", "/api/admin/voyages", nv, ADMIN);
  check(r.status === 200 && r.json.cle && r.json.id === nv.id, `voyage créé, clé reçue (${r.status} ${r.json.erreur || ""})`);
  const cle = r.json.cle;
  check(commitCount === before + 1, "un seul commit");
  const conf = JSON.parse(files.get(`_app/voyages/${nv.id}.json`));
  check(conf.station === "stanton" && conf.appCourt === "St. Anton 2028" && conf.affiche?.bagages?.soute?.length === 3, "fiche du voyage écrite, avec l'affiche par défaut");
  check(conf.credit === "Photo : &lt;b&gt;moi&lt;/b&gt;", "crédit de la photo échappé");
  check(JSON.parse(files.get(`${nv.id}/voyage.json`)).chiffre, "contenu chiffré écrit");
  check(files.get(`_app/voyages/photos/${nv.id}.jpg`)?.toString() === "faux jpeg", "photo écrite");
  check(JSON.parse(files.get("voyages.json")).voyages[0].app === `https://monaccompagnateur.ca/${nv.id}/`, "voyage ajouté en tête de la page d'accueil");

  console.log("\nClé d'éditeur et alertes du nouveau voyage");
  r = await call("GET", `/api/voyage?trip=${nv.id}`, null, cle);
  check(r.status === 200 && JSON.parse(r.json.content).chiffre, "la clé ouvre le nouveau voyage dans l'éditeur");
  check((await call("GET", `/api/voyage?trip=st-anton-mars2027`, null, cle)).status === 403, "la clé n'ouvre pas un autre voyage");
  r = await call("POST", "/api/schedule", { trip: nv.id, items: [] }, cle);
  check(r.status === 200, "programmation des alertes acceptée pour le nouveau voyage");
  r = await call("POST", "/api/admin/cle", { trip: nv.id }, ADMIN);
  check(r.status === 200 && r.json.cle && r.json.cle !== cle, "nouvelle clé générée");
  check((await call("GET", `/api/voyage?trip=${nv.id}`, null, cle)).status === 403, "l'ancienne clé ne fonctionne plus");
  check((await call("GET", `/api/voyage?trip=${nv.id}`, null, r.json.cle)).status === 200, "la nouvelle clé fonctionne");
  const cle2 = r.json.cle;
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  const v = r.json.voyages.find((x) => x.id === nv.id);
  check(v && v.cle === "admin" && !v.clos, "le nouveau voyage apparaît dans la liste");

  console.log("\nClôture");
  r = await call("POST", "/api/admin/clore", { trip: nv.id }, ADMIN);
  check(r.status === 200, "voyage clos");
  check((await call("GET", `/api/voyage?trip=${nv.id}`, null, cle2)).status === 403, "après la clôture, la clé ne fonctionne plus");
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(r.json.voyages.find((x) => x.id === nv.id)?.clos === true, "marqué clos dans la liste");
} finally {
  wr.kill("SIGINT"); gh.close(); fs.rmSync(path.join(root, ".dev.vars"), { force: true });
}
console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
process.exit(failures ? 1 : 0);

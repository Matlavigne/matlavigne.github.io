// Test de l'administration : création d'un voyage (un seul commit), clé d'éditeur, clôture.
// wrangler dev + faux GitHub local (API contents et Git Data).
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRIPS_TEST, accompagnateur } from "./outils.mjs";

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
    if (req.method === "GET" && /^\/git\/trees\//.test(p)) return send(200, { truncated: false, tree: [...files.keys()].map((k) => ({ path: k, type: "blob" })) });
    if (req.method === "GET" && (m = p.match(/^\/git\/commits\/(.+)$/))) return send(200, { sha: m[1], tree: { sha: commits.get(m[1]).tree } });
    const j = body ? JSON.parse(body) : {};
    if (req.method === "POST" && p === "/git/blobs") { const b = j.encoding === "base64" ? Buffer.from(j.content, "base64") : Buffer.from(j.content); const s = sha1(b); blobs.set(s, b); return send(201, { sha: s }); }
    if (req.method === "POST" && p === "/git/trees") { const s = "t" + trees.size + 1; trees.set(s, j.tree); return send(201, { sha: s }); }
    if (req.method === "POST" && p === "/git/commits") { const s = "c" + (commits.size); commits.set(s, { tree: j.tree, message: j.message, parents: j.parents }); return send(201, { sha: s }); }
    if (req.method === "PATCH" && p === "/git/refs/heads/main") {
      const c = commits.get(j.sha); if (c.parents[0] !== head) return send(422, {});
      for (const e of trees.get(c.tree)) { if (e.sha === null) files.delete(e.path); else files.set(e.path, blobs.get(e.sha)); }
      head = j.sha; commitCount++; return send(200, { object: { sha: head } });
    }
    send(404, {});
  });
});
await new Promise((r) => gh.listen(GH_PORT, "127.0.0.1", r));

// ---------- Worker ----------
fs.writeFileSync(path.join(root, ".dev.vars"), [
  "VAPID_PUBLIC_KEY=x", ...(process.env.SERVIR ? ["ALLOWED_ORIGINS=http://127.0.0.1:8092"] : []), `ADMIN_TOKEN=${ADMIN_TOKEN}`, TRIPS_TEST, `GITHUB_TOKEN=${GH_TOKEN}`, `GITHUB_API=http://127.0.0.1:${GH_PORT}`,
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
  var totp = (sec) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = crypto.createHmac("sha1", dec(sec)).update(m).digest(); const o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, "0"); };
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
  check(r.status === 200 && r.json.id === nv.id && !("cle" in r.json), `voyage créé, sans clé d'éditeur (${r.status} ${r.json.erreur || ""})`);
  check(commitCount === before + 1, "un seul commit");
  const conf = JSON.parse(files.get(`_app/voyages/${nv.id}.json`));
  check(conf.station === "stanton" && conf.appCourt === "St. Anton 2028" && conf.affiche?.bagages?.soute?.length === 3, "fiche du voyage écrite, avec l'affiche par défaut");
  check(conf.credit === "Photo : &lt;b&gt;moi&lt;/b&gt;", "crédit de la photo échappé");
  check(JSON.parse(files.get(`${nv.id}/voyage.json`)).chiffre, "contenu chiffré écrit");
  check(files.get(`_app/voyages/photos/${nv.id}.jpg`)?.toString() === "faux jpeg", "photo écrite");
  check(JSON.parse(files.get("voyages.json")).voyages[0].app === `https://monaccompagnateur.ca/${nv.id}/`, "voyage ajouté en tête de la page d'accueil");

  console.log("\nÉditeur et alertes du nouveau voyage (compte accompagnateur)");
  const paul = await accompagnateur(call, ADMIN, "paul.r", [nv.id]);
  r = await call("GET", `/api/voyage?trip=${nv.id}`, null, paul);
  check(r.status === 200 && JSON.parse(r.json.content).chiffre, "le compte de l'accompagnateur ouvre le nouveau voyage dans l'éditeur");
  check((await call("GET", `/api/voyage?trip=st-anton-mars2027`, null, paul)).status === 403, "il n'ouvre pas un autre voyage");
  r = await call("POST", "/api/schedule", { trip: nv.id, items: [] }, paul);
  check(r.status === 200, "programmation des alertes acceptée pour le nouveau voyage");
  check((await call("POST", "/api/admin/cle", { trip: nv.id }, ADMIN)).status === 404, "plus de clé d'éditeur à générer");
  check((await call("GET", `/api/voyage?trip=${nv.id}`, null, "cle-editeur-ancienne-xyz")).status === 401, "une clé sans compte est refusée");
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  const v = r.json.voyages.find((x) => x.id === nv.id);
  check(v && !v.clos && !("cle" in v), "le nouveau voyage apparaît dans la liste");

  console.log("\nClôture");
  r = await call("POST", "/api/admin/clore", { trip: nv.id }, ADMIN);
  check(r.status === 200, "voyage clos");
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(r.json.voyages.find((x) => x.id === nv.id)?.clos === true, "marqué clos dans la liste");

  console.log("\nPhoto d'en-tête");
  put("_app/voyages/photos/st-anton-mars2027.png", "ancienne"); put("_app/voyages/photos/st-anton-mars2027.fait", "sha");
  r = await call("POST", "/api/admin/photo", { trip: "st-anton-mars2027", photo, credit: "Photo : Mathieu" });
  check([401, 403].includes(r.status), "sans session : refusé");
  r = await call("POST", "/api/admin/photo", { trip: "st-anton-mars2027", photo: "data:text/plain;base64,eA==" }, ADMIN);
  check(r.status === 400, "fichier qui n'est pas une image : refusé");
  r = await call("POST", "/api/admin/photo", { trip: "st-anton-mars2027", photo, credit: "Photo : <b>Mathieu</b>" }, ADMIN);
  check(r.status === 200, `photo enregistrée (${r.status} ${r.json.erreur || ""})`);
  check(files.get("_app/voyages/photos/st-anton-mars2027.jpg")?.toString() === "faux jpeg" && !files.has("_app/voyages/photos/st-anton-mars2027.png") && !files.has("_app/voyages/photos/st-anton-mars2027.fait"), "nouvelle photo écrite, l'ancienne et sa marque retirées");
  check(JSON.parse(files.get("_app/voyages/st-anton-mars2027.json")).credit === "Photo : &lt;b&gt;Mathieu&lt;/b&gt;", "crédit mis à jour et échappé");

  console.log("\nApp de l'accompagnateur");
  check((await call("GET", "/api/mes-voyages")).status === 401, "sans session : refusé");
  r = await call("GET", "/api/mes-voyages", null, ADMIN);
  check(r.status === 200 && r.json.voyages.length === 2 && r.json.voyages.find((x) => x.id === "st-anton-mars2027")?.station?.nom === "St. Anton", `administrateur : tous les voyages, avec la station (${r.status} ${r.json.erreur || ""})`);
  r = await call("POST", "/api/admin/comptes", { username: "julie.b", nom: "Julie B.", role: "accompagnateur", trips: ["st-anton-mars2027"] }, ADMIN);
  const tmp = r.json.motDePasse;
  r = await call("POST", "/api/auth/connexion", { username: "julie.b", password: tmp });
  const julie = r.json.session;
  check((await call("GET", "/api/mes-voyages", null, julie)).status === 428, "mot de passe temporaire : il faut d'abord le changer");
  await call("POST", "/api/auth/mdp", { ancien: tmp, nouveau: "julie-nouveau-mdp" }, julie);
  { const sec = (await call("POST", "/api/auth/2fa/debut", {}, julie)).json.secret; await call("POST", "/api/auth/2fa/activer", { code: totp(sec) }, julie); }
  r = await call("GET", "/api/mes-voyages", null, julie);
  check(r.status === 200 && r.json.voyages.length === 1 && r.json.voyages[0].id === "st-anton-mars2027" && r.json.profil.nom === "Julie B.", "accompagnateur : seulement ses voyages");

  console.log("\nAccompagnateurs d'un voyage");
  await call("POST", "/api/admin/comptes", { username: "marc.g", nom: "Marc G.", role: "accompagnateur", trips: [] }, ADMIN);
  r = await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["julie.b", "marc.g"] }, ADMIN);
  check(r.status === 200 && r.json.comptes.length === 2, `deux accompagnateurs sur le même voyage (${r.status} ${r.json.erreur || ""})`);
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(JSON.stringify(r.json.voyages.find((x) => x.id === "st-anton-mars2027").accompagnateurs.sort()) === '["julie.b","marc.g"]', "les deux apparaissent dans la liste des voyages");
  r = await call("POST", "/api/auth/profil", { nom: "Julie Bouchard", cellulaire: "514 555-0101", courriel: "julie@example.com" }, julie);
  check(r.status === 200 && r.json.profil.cellulaire === "514 555-0101", `profil : cellulaire et courriel enregistrés (${r.status} ${r.json.erreur || ""})`);
  check((await call("POST", "/api/auth/profil", { courriel: "pas-un-courriel" }, julie)).status === 400, "courriel invalide refusé");
  r = await call("GET", "/api/voyage/accompagnateurs?trip=st-anton-mars2027", null, julie);
  check(r.status === 200 && r.json.accompagnateurs.some((x) => x.compte === "julie.b" && x.courriel === "julie@example.com") && r.json.accompagnateurs.length === 2, "l'éditeur reçoit les coordonnées des accompagnateurs du voyage");
  check((await call("GET", "/api/voyage/accompagnateurs?trip=st-anton-mars2027")).status === 401, "coordonnées : pas sans connexion");
  r = await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["julie.b", "marc.g", "admin"] }, ADMIN);
  check(r.status === 200 && r.json.comptes.includes("admin"), "l'administrateur peut aussi être accompagnateur d'un voyage");
  r = await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["marc.g"] }, ADMIN);
  check((await call("GET", "/api/mes-voyages", null, julie)).json.voyages.length === 0, "accompagnatrice retirée : elle ne voit plus le voyage");
  check((await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["inconnu"] }, ADMIN)).status === 400, "un compte inconnu est refusé");
  check((await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: [] }, julie)).status === 403, "réservé à l'administrateur");

  console.log("\nAccès par approbation");
  const b64u = (n, first) => { const x = crypto.randomBytes(n); if (first != null) x[0] = first; return x.toString("base64url"); };
  const pub = { kty: "EC", crv: "P-256", x: b64u(32), y: b64u(32) };
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/essai-" + b64u(8), keys: { p256dh: b64u(65, 4), auth: b64u(16) } };
  check((await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nom: "X", pub })).status === 400, "nom trop court refusé");
  check((await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nom: "Paul Ancien", pub: { kty: "EC" } })).status === 400, "clé d'appareil invalide refusée");
  r = await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nom: "Paul Tremblay", pub, sub });
  check(r.status === 200 && r.json.id && r.json.jeton, `demande créée (${r.status} ${r.json.erreur || ""})`);
  const dem = r.json;
  r = await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nom: "Inconnu Suspect", pub });
  const dem2 = r.json;
  r = await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton);
  check(r.status === 200 && r.json.statut === "attente" && !r.json.cle, "le voyageur voit « en attente »");
  check((await call("GET", "/api/acces/etat?id=" + dem.id, null, dem2.jeton)).status === 404, "le jeton d'une autre demande ne fonctionne pas");
  check((await call("GET", "/api/acces/demandes?trip=st-anton-mars2027")).status === 401, "liste des demandes : pas sans connexion");
  r = await call("GET", "/api/acces/demandes?trip=st-anton-mars2027", null, ADMIN);
  check(r.status === 200 && r.json.demandes.length === 2 && r.json.demandes.some((d) => d.nom === "Paul Tremblay" && d.notif && d.pub.x === pub.x), "l'accompagnateur voit les demandes, avec la clé publique");
  r = await call("GET", "/api/mes-voyages", null, ADMIN);
  check(r.json.voyages.find((v) => v.id === "st-anton-mars2027").demandes === 2, "pastille : 2 demandes en attente");
  const cleCh = { epk: { kty: "EC", crv: "P-256", x: b64u(32), y: b64u(32) }, iv: b64u(12), data: b64u(60) };
  r = await call("POST", "/api/acces/decision", { trip: "st-anton-mars2027", decisions: [{ id: dem.id, ok: true, cle: cleCh }, { id: dem2.id, ok: false }] }, ADMIN);
  check(r.status === 200 && r.json.approuvees === 1 && r.json.refusees === 1, `approbation et refus (${r.status} ${r.json.erreur || ""})`);
  r = await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton);
  check(r.json.statut === "ok" && r.json.cle && r.json.cle.data === cleCh.data, "le voyageur reçoit la clé chiffrée pour son téléphone");
  check((await call("GET", "/api/acces/etat?id=" + dem2.id, null, dem2.jeton)).json.statut === "refus", "demande refusée");
  r = await call("GET", "/api/status?trip=st-anton-mars2027", null, ADMIN);
  check(r.status === 200 && r.json.abonnements >= 1, `approuvé : abonné aux alertes du voyage (${r.json.abonnements})`);
  // Alertes des demandes pour l'accompagnateur
  const subAcc = { endpoint: "https://fcm.googleapis.com/fcm/send/acc-" + b64u(8), keys: { p256dh: b64u(65, 4), auth: b64u(16) } };
  check((await call("POST", "/api/acces/alertes", { sub: subAcc })).status === 401, "alertes des demandes : pas sans connexion");
  r = await call("POST", "/api/acces/alertes", { sub: subAcc }, ADMIN);
  check(r.status === 200 && r.json.actif, `l'accompagnateur active les alertes des demandes (${r.status} ${r.json.erreur || ""})`);
  r = await call("GET", "/api/acces/alertes?endpoint=" + encodeURIComponent(subAcc.endpoint), null, ADMIN);
  check(r.json.actif === true, "alertes actives sur ce téléphone");
  r = await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nom: "Julie Nouvelle", pub });
  check(r.status === 200, "une nouvelle demande passe même si l'alerte ne peut pas partir (essai hors ligne)");
  r = await call("POST", "/api/acces/alertes", { actif: false, endpoint: subAcc.endpoint }, ADMIN);
  check((await call("GET", "/api/acces/alertes?endpoint=" + encodeURIComponent(subAcc.endpoint), null, ADMIN)).json.actif === false, "alertes coupées");
  // Nouvelle clé (phrase changée) puis retrait de l'accès
  const cleNv = { ...cleCh, data: b64u(60) };
  r = await call("POST", "/api/acces/decision", { trip: "st-anton-mars2027", decisions: [{ id: dem.id, ok: true, cle: cleNv, sel: "nouveauSel123=" }] }, ADMIN);
  check(r.json.renouvelees === 1 && r.json.approuvees === 0, "nouvelle clé envoyée à un voyageur déjà approuvé");
  r = await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton);
  check(r.json.statut === "ok" && r.json.cle.data === cleNv.data, "le voyageur reprend la nouvelle clé");
  r = await call("GET", "/api/acces/demandes?trip=st-anton-mars2027", null, ADMIN);
  check(r.json.demandes.find((d) => d.id === dem.id).sel === "nouveauSel123=", "la liste indique pour quelle phrase la clé a été envoyée");
  r = await call("POST", "/api/acces/decision", { trip: "st-anton-mars2027", decisions: [{ id: dem.id, retirer: true }] }, ADMIN);
  check(r.status === 200 && r.json.retirees === 1, "accès retiré");
  r = await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton);
  check(r.json.statut === "retire" && !r.json.cle, "le téléphone voit l'accès retiré, sans clé");
  r = await call("GET", "/api/status?trip=st-anton-mars2027", null, ADMIN);
  check(r.json.abonnements === 0, `retiré : plus abonné aux alertes du voyage (${r.json.abonnements})`);
  r = await call("POST", "/api/acces/decision", { trip: "st-anton-mars2027", decisions: [{ id: dem.id, ok: true, cle: cleCh }] }, ADMIN);
  check(r.json.approuvees === 1 && (await call("GET", "/api/acces/etat?id=" + dem.id, null, dem.jeton)).json.statut === "ok", "accès redonné");

  console.log("\nMon groupe partagé (clé d'équipe)");
  r = await call("POST", "/api/admin/comptes", { username: "luc.t", nom: "Luc T.", role: "accompagnateur", trips: [] }, ADMIN);
  { const tmpL = r.json.motDePasse; r = await call("POST", "/api/auth/connexion", { username: "luc.t", password: tmpL }); var luc = r.json.session;
    await call("POST", "/api/auth/mdp", { ancien: tmpL, nouveau: "luc-nouveau-mdp-1" }, luc); const sec = (await call("POST", "/api/auth/2fa/debut", {}, luc)).json.secret; await call("POST", "/api/auth/2fa/activer", { code: totp(sec) }, luc); }
  await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["julie.b", "luc.t"] }, ADMIN);
  const pk = () => ({ x: b64u(32), y: b64u(32) });
  const envl = () => ({ epk: { x: b64u(32), y: b64u(32) }, iv: b64u(12), data: b64u(80) });
  const pJ = pk(), pL = pk();
  check((await call("GET", "/api/equipe?trip=st-anton-mars2027")).status === 401, "équipe : pas sans connexion");
  check((await call("GET", "/api/equipe?trip=st-anton-mars2027", null, ADMIN)).status === 403, "administrateur non assigné : pas accès à la liste");
  r = await call("POST", "/api/equipe/appareil", { pub: pJ, nom: "iPhone" }, julie); const aJ = r.json.id;
  check(r.status === 200 && /^[0-9a-f]{32}$/.test(aJ), `téléphone de Julie enregistré (${r.status} ${r.json.erreur || ""})`);
  check((await call("POST", "/api/equipe/appareil", { pub: pJ }, luc)).status === 409, "le même téléphone ne peut pas passer à un autre compte");
  const aL = (await call("POST", "/api/equipe/appareil", { pub: pL, nom: "Android" }, luc)).json.id;
  r = await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aJ, null, julie);
  check(r.status === 200 && r.json.kid === null && r.json.membres.length === 2 && r.json.appareils.length === 2, "équipe : 2 accompagnateurs, 2 téléphones, pas encore de clé");
  const blob = { iv: b64u(12), data: b64u(300), z: 1 };
  check((await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 0, kid: "a".repeat(16), blob, epub: pk(), cles: [{ appareil: aL, env: envl() }] }, julie)).status === 400, "nouvelle clé sans son propre téléphone : refusée");
  check((await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 0, kid: "a".repeat(16), blob, cles: [{ appareil: aJ, env: envl() }] }, julie)).status === 400, "nouvelle clé sans partie publique : refusée");
  const ePub = pk();
  r = await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 0, kid: "a".repeat(16), blob, epub: ePub, cles: [{ appareil: aJ, env: envl() }] }, julie);
  check(r.status === 200 && r.json.version === 1 && /^[0-9a-f]{32}$/.test(r.json.ekid), `Julie crée la liste chiffrée (${r.status} ${r.json.erreur || ""})`);
  const ekid1 = r.json.ekid;
  // Demandes d'accès : le nom arrive chiffré pour l'équipe
  r = await call("GET", "/api/acces/cle-equipe?trip=st-anton-mars2027");
  check(r.status === 200 && r.json.ekid === ekid1 && r.json.pub.x === ePub.x, "clé publique d'équipe offerte aux voyageurs, sans connexion");
  const nomc = { epk: { x: b64u(32), y: b64u(32) }, iv: b64u(12), data: b64u(40) };
  check((await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nom: "Paul En-Clair", pub })).status === 409, "nom en clair refusé une fois la clé d'équipe en place");
  check((await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nomc, ekid: "0".repeat(32), pub })).status === 409, "nom chiffré pour une ancienne clé : à refaire");
  r = await call("POST", "/api/acces/demande", { trip: "st-anton-mars2027", nomc, ekid: ekid1, pub });
  check(r.status === 200, `demande avec nom chiffré (${r.status} ${r.json.erreur || ""})`);
  const demC = r.json.id;
  r = await call("GET", "/api/acces/demandes?trip=st-anton-mars2027", null, julie);
  { const d = r.json.demandes.find((x) => x.id === demC); check(d && d.nom === "" && d.nomc.data === nomc.data && d.ekid === ekid1, "le service ne garde que le nom chiffré"); }
  r = await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aJ, null, julie);
  check(r.json.kid === "a".repeat(16) && r.json.cle && r.json.appareils.find((a) => a.id === aJ).cle && !r.json.appareils.find((a) => a.id === aL).cle, "Julie a sa clé; Luc pas encore");
  r = await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aL, null, luc);
  check(r.json.cle === null, "Luc attend la clé");
  r = await call("GET", "/api/groupe?trip=st-anton-mars2027", null, luc);
  check(r.json.blob && r.json.blob.data === blob.data, "Luc reçoit le bloc chiffré (illisible sans la clé)");
  check((await call("GET", "/api/groupe?trip=st-anton-mars2027&depuis=1", null, luc)).json.inchange === true, "rien de nouveau : réponse courte");
  check((await call("POST", "/api/equipe/cles", { trip: "st-anton-mars2027", kid: "b".repeat(16), cles: [{ appareil: aL, env: envl() }] }, julie)).status === 409, "enveloppe pour une ancienne clé : refusée");
  r = await call("POST", "/api/equipe/cles", { trip: "st-anton-mars2027", kid: "a".repeat(16), cles: [{ appareil: aL, env: envl() }] }, julie);
  check(r.status === 200, "Julie donne la clé au téléphone de Luc");
  check((await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aL, null, luc)).json.cle, "Luc a la clé");
  check((await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 0, kid: "a".repeat(16), blob }, luc)).status === 409, "version dépassée : conflit (il faut fusionner)");
  r = await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 1, kid: "a".repeat(16), blob: { ...blob, data: b64u(310) } }, luc);
  check(r.status === 200 && r.json.version === 2, "Luc enregistre ses présences");
  // Luc retiré du voyage : il faut changer de clé, et il ne reçoit plus rien
  await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["julie.b"] }, ADMIN);
  check((await call("GET", "/api/groupe?trip=st-anton-mars2027", null, luc)).status === 403, "accompagnateur retiré : plus de liste");
  r = await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aJ, null, julie);
  check(r.json.rotation === true, "le téléphone de Julie voit qu'il faut changer la clé");
  r = await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 2, kid: "c".repeat(16), blob, epub: pk(), cles: [{ appareil: aJ, env: envl() }, { appareil: aL, env: envl() }] }, julie);
  check(r.status === 400, "la nouvelle clé ne peut pas aller à un téléphone retiré");
  r = await call("PUT", "/api/groupe", { trip: "st-anton-mars2027", base: 2, kid: "c".repeat(16), blob, epub: pk(), cles: [{ appareil: aJ, env: envl() }] }, julie);
  check(r.status === 200 && r.json.ekid !== ekid1, "nouvelle clé : liste rechiffrée, nouvelle clé publique d'équipe");
  r = await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aJ, null, julie);
  check(r.json.rotation === false && r.json.kid === "c".repeat(16) && r.json.cle, "plus besoin de changer la clé");
  await call("POST", "/api/admin/acces", { trip: "st-anton-mars2027", comptes: ["julie.b", "luc.t"] }, ADMIN);
  r = await call("GET", "/api/equipe?trip=st-anton-mars2027&appareil=" + aL, null, luc);
  check(r.json.cle === null, "Luc réassigné : l'ancienne clé ne lui sert plus, il doit recevoir la nouvelle");

  console.log("\nSuppression");
  put(`_app/icones/${nv.id}.svg`, "<svg/>"); put(`_app/i18n/voyages/${nv.id}.json`, "{}"); put(`${nv.id}/index.html`, "x");
  r = await call("POST", "/api/admin/supprimer", { trip: nv.id }, ADMIN);
  check(r.status === 400, "sans confirmation : refusé");
  r = await call("POST", "/api/admin/supprimer", { trip: nv.id, confirmer: nv.id });
  check([401, 403].includes(r.status), "sans session : refusé");
  const avant = commitCount;
  r = await call("POST", "/api/admin/supprimer", { trip: nv.id, confirmer: nv.id }, ADMIN);
  check(r.status === 200 && commitCount === avant + 1, `voyage supprimé en un commit (${r.status} ${r.json.erreur || ""})`);
  check(![...files.keys()].some((k) => k.includes(nv.id)), "fichiers de l'app, fiche, photo, icône et dictionnaire retirés");
  check(files.has("st-anton-mars2027/voyage.json") && files.has("_app/voyages/st-anton-mars2027.json"), "les autres voyages sont intacts");
  check(!JSON.parse(files.get("voyages.json")).voyages.some((x) => String(x.app || "").includes(nv.id)) && JSON.parse(files.get("voyages.json")).voyages.length === 1, "retiré de la page d'accueil");
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(!r.json.voyages.some((x) => x.id === nv.id), "n'apparaît plus dans la liste");
  check((await call("POST", "/api/admin/supprimer", { trip: nv.id, confirmer: nv.id }, ADMIN)).status === 404, "deuxième suppression : introuvable");
  put(`_app/voyages/${nv.id}.json`, JSON.stringify({ id: nv.id, station: "stanton", titre: "Fantôme", dates: "x" })); // GitHub en retard
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(!r.json.voyages.some((x) => x.id === nv.id), "même si GitHub liste encore la fiche, le voyage n'apparaît plus");
  files.delete(`_app/voyages/${nv.id}.json`);
  r = await call("POST", "/api/admin/voyages", nv, ADMIN);
  check(r.status === 200, `la même adresse peut resservir pour un nouveau voyage (${r.status} ${r.json.erreur || ""})`);
  r = await call("GET", "/api/admin/etat", null, ADMIN);
  check(r.json.voyages.some((x) => x.id === nv.id && !x.clos), "le nouveau voyage réapparaît, actif");
} finally {
  wr.kill("SIGINT"); gh.close(); fs.rmSync(path.join(root, ".dev.vars"), { force: true });
}
console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
process.exit(failures ? 1 : 0);

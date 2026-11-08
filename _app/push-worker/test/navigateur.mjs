// Banc d'essai pour le navigateur (pas dans « npm test ») : Worker local + faux GitHub + site servi en local,
// avec l'adresse de l'API réécrite vers le Worker local. Le voyage de Sölden y est chiffré avec la phrase
// « marmotte-fondue-glacier » (ancien format), pour essayer la remise de la clé au serveur.
// Usage : node test/navigateur.mjs   → affiche « PRET <json> » puis reste en marche (Ctrl+C pour arrêter).
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRIPS_TEST, premierAdmin, accompagnateur, CLE_MAITRE_TEST } from "./outils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.resolve(root, "..", "..");
const GH_PORT = 9918, WORKER_PORT = 8792, SITE_PORT = 8092;
const W = `http://127.0.0.1:${WORKER_PORT}`, SITE = `http://127.0.0.1:${SITE_PORT}`;
const ADMIN_TOKEN = "adm-" + crypto.randomBytes(8).toString("hex");
const GH_TOKEN = "github_pat_test";
const REPO = "Matlavigne/matlavigne.github.io";
const A = "solden-voyage-2027";
const PHRASE = "marmotte-fondue-glacier";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Contenu de départ : le vrai voyage.json public, avec un contenu de test chiffré par la phrase (PBKDF2, comme avant)
const pub = JSON.parse(fs.readFileSync(path.join(site, A, "voyage.json"), "utf8"));
delete pub.chiffre;
const secret = { programme: [{ date: "2027-03-05", titre: "Départ de Montréal", items: [{ heure: "17:00", titre: "Rendez-vous YUL" }] }], annonces: [], hotel: { nom: "Hotel Test", adresse: "Rue 1" }, accompagnateur: { nom: "Test", role: "Accompagnateur" } };
const salt = crypto.randomBytes(16);
const kPhrase = crypto.pbkdf2Sync(Buffer.from(PHRASE), salt, 600000, 32, "sha256");
const iv = crypto.randomBytes(12);
const ciph = crypto.createCipheriv("aes-256-gcm", kPhrase, iv);
const ct = Buffer.concat([ciph.update(JSON.stringify(secret)), ciph.final(), ciph.getAuthTag()]);
const depart = JSON.stringify({ ...pub, chiffre: { v: 1, kdf: "PBKDF2-SHA256", iter: 600000, salt: salt.toString("base64"), iv: iv.toString("base64"), data: ct.toString("base64") } }, null, 2) + "\n";

const files = new Map();
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
files.set(`${A}/voyage.json`, { content: depart, sha: sha1(depart) });
for (const t of [A]) { const f = JSON.stringify({ id: t, station: "soelden", titre: t, appCourt: "Sölden 2027" }); files.set(`_app/voyages/${t}.json`, { content: f, sha: sha1(f) }); }
const gh = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const m = req.url.match(new RegExp(`^/repos/${REPO}/contents/([^?]*)`));
    if (!m) return send(404, { message: "Not Found" });
    const p = decodeURIComponent(m[1]).replace(/\/$/, "");
    if (req.method === "GET") {
      const f = files.get(p);
      if (f) return send(200, { sha: f.sha, content: Buffer.from(f.content).toString("base64") });
      const dir = [...files.keys()].filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map((k) => ({ name: k.split("/").pop(), path: k, type: "file" }));
      return dir.length ? send(200, dir) : send(404, { message: "Not Found" });
    }
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

// Site : fichiers du dépôt, API réécrite; voyage.json servi depuis le faux GitHub (ce que publie l'éditeur)
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, SITE).pathname);
  const fg = files.get(p.slice(1));
  if (fg) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end(fg.content); }
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(site, p);
  if (!f.startsWith(site) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("404"); }
  const ext = path.extname(f);
  let data = fs.readFileSync(f);
  if ([".html", ".js"].includes(ext)) data = Buffer.from(data.toString("utf8").replaceAll("https://api.monaccompagnateur.ca", W));
  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(data);
});
await new Promise((r) => srv.listen(SITE_PORT, "127.0.0.1", r));

fs.writeFileSync(path.join(root, ".dev.vars"), ["VAPID_PUBLIC_KEY=x", CLE_MAITRE_TEST, `ALLOWED_ORIGINS=${SITE}`, `ADMIN_TOKEN=${ADMIN_TOKEN}`, TRIPS_TEST, `GITHUB_TOKEN=${GH_TOKEN}`, `GITHUB_API=http://127.0.0.1:${GH_PORT}`].join("\n") + "\n");
fs.rmSync(path.join(root, ".wrangler"), { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
execFileSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--local", "--file=schema.sql"], { cwd: root, env, stdio: "pipe" });
const wr = spawn("npx", ["wrangler", "dev", "--local", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let wrOut = ""; wr.stdout.on("data", (d) => (wrOut += d)); wr.stderr.on("data", (d) => (wrOut += d));
for (let i = 0; ; i++) { try { if ((await fetch(`${W}/api/vapid`)).ok) break; } catch {} if (i > 60) throw new Error(wrOut); await sleep(500); }
const call = async (method, p, body, key) => {
  const r = await fetch(W + p, { method, headers: { "Content-Type": "application/json", Origin: SITE, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const adm = await premierAdmin(call, ADMIN_TOKEN);
const julie = await accompagnateur(call, adm, "julie.b", [A]);
const luc = await accompagnateur(call, adm, "luc.t", []);
const stop = () => { wr.kill("SIGINT"); gh.close(); srv.close(); fs.rmSync(path.join(root, ".dev.vars"), { force: true }); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
// Petite API de contrôle pour le test : état du faux GitHub, assignation de Luc
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  let out = {};
  if (u.pathname === "/voyage") out = JSON.parse(files.get(`${A}/voyage.json`).content);
  if (u.pathname === "/assigner") out = (await call("POST", "/api/admin/acces", { trip: A, comptes: ["julie.b", "luc.t"] }, adm)).json;
  if (u.pathname === "/cle") out = (await call("GET", `/api/voyage/cle?trip=${A}`, null, adm)).json;
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out));
}).listen(9919, "127.0.0.1");
console.log("PRET " + JSON.stringify({ site: SITE, worker: W, admin: adm, julie, luc, phrase: PHRASE, controle: "http://127.0.0.1:9919" }));
await new Promise(() => {});

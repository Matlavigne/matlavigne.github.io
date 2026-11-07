// Test de la publication depuis l'éditeur : wrangler dev + faux GitHub local.
// Vérifie qu'une clé d'éditeur ne peut écrire que <son voyage>/voyage.json.
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GH_PORT = 9912, WORKER_PORT = 8798;
const W = `http://127.0.0.1:${WORKER_PORT}`;
const ORIGIN = "https://monaccompagnateur.ca";
const A = "solden-voyage-2027", B = "st-anton-mars2027";
const KEY_A = "cle-a-" + crypto.randomBytes(6).toString("hex");
const KEY_B = "cle-b-" + crypto.randomBytes(6).toString("hex");
const GH_TOKEN = "github_pat_test_" + crypto.randomBytes(6).toString("hex");
const REPO = "Matlavigne/matlavigne.github.io";

let failures = 0;
const check = (c, l) => { console.log(`${c ? "  ok " : "  ÉCHEC"}  ${l}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- faux GitHub ----------
const files = new Map(); // chemin -> { content, sha }
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const enc = (o) => ({ chiffre: { v: 1, salt: "c2Fs", iv: "aXY=", data: Buffer.from(JSON.stringify(o)).toString("base64") }, titre: "Test" });
for (const t of [A, B]) { const c = JSON.stringify(enc({ t })); files.set(`${t}/voyage.json`, { content: c, sha: sha1(c) }); }
files.set("solden-voyage-2027/index.html", { content: "<html>", sha: sha1("<html>") });
const writes = [];
const gh = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
    const m = req.url.match(new RegExp(`^/repos/${REPO}/contents/([^?]+)`));
    if (!m) return send(404, { message: "Not Found" });
    const p = decodeURIComponent(m[1]);
    if (req.method === "GET") {
      const f = files.get(p);
      return f ? send(200, { sha: f.sha, content: Buffer.from(f.content).toString("base64") }) : send(404, { message: "Not Found" });
    }
    if (req.method === "PUT") {
      const j = JSON.parse(body);
      const f = files.get(p);
      if (f && j.sha !== f.sha) return send(409, { message: "sha mismatch" });
      const content = Buffer.from(j.content, "base64").toString("utf8");
      const nf = { content, sha: sha1(content) };
      files.set(p, nf);
      writes.push({ path: p, message: j.message, author: j.author });
      return send(200, { content: { sha: nf.sha }, commit: { sha: sha1("c" + content) } });
    }
    send(405, {});
  });
});
await new Promise((r) => gh.listen(GH_PORT, "127.0.0.1", r));

// ---------- Worker ----------
fs.writeFileSync(path.join(root, ".dev.vars"), [
  "VAPID_PUBLIC_KEY=x",
  `EDITOR_TOKENS=${JSON.stringify({ [A]: KEY_A, [B]: KEY_B })}`,
  `GITHUB_TOKEN=${GH_TOKEN}`,
  `GITHUB_API=http://127.0.0.1:${GH_PORT}`,
].join("\n") + "\n");
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
  return { status: r.status, json: await r.json().catch(() => ({})), cors: r.headers.get("access-control-allow-origin") };
};

try {
  console.log("\nLecture");
  let r = await call("GET", `/api/voyage?trip=${A}`);
  check(r.status === 401, `sans clé : refusé (${r.status})`);
  r = await call("GET", `/api/voyage?trip=${A}`, null, KEY_B);
  check(r.status === 403, `clé de St. Anton sur Sölden : refusée (${r.status})`);
  r = await call("GET", `/api/voyage?trip=${A}`, null, KEY_A);
  check(r.status === 200 && r.json.sha === files.get(`${A}/voyage.json`).sha && JSON.parse(r.json.content).chiffre, "clé de Sölden : contenu et sha reçus");
  check(r.cors === ORIGIN, "CORS autorisé pour monaccompagnateur.ca");
  const shaA = r.json.sha;

  console.log("\nPublication");
  const nouveau = JSON.stringify(enc({ t: A, v: 2 }));
  r = await call("POST", "/api/publier", { trip: A, content: nouveau, sha: shaA }, KEY_B);
  check(r.status === 403, `clé de St. Anton ne publie pas Sölden (${r.status})`);
  r = await call("POST", "/api/publier", { trip: "../" + A, content: nouveau, sha: shaA }, KEY_A);
  check(r.status === 400, `voyage « ../ » refusé (${r.status})`);
  r = await call("POST", "/api/publier", { trip: "inconnu-2099", content: nouveau }, KEY_A);
  check(r.status === 404, `voyage inconnu refusé (${r.status})`);
  r = await call("POST", "/api/publier", { trip: A, content: "{pas du json", sha: shaA }, KEY_A);
  check(r.status === 400, `contenu invalide refusé (${r.status})`);
  r = await call("POST", "/api/publier", { trip: A, content: JSON.stringify({ programme: [] }), sha: shaA }, KEY_A);
  check(r.status === 400 && /protégé/.test(r.json.erreur), `publication en clair d'un voyage protégé refusée (${r.status})`);
  r = await call("POST", "/api/publier", { trip: A, content: nouveau, sha: "0".repeat(40) }, KEY_A);
  check(r.status === 409 && r.json.sha_actuel === shaA, `sha périmé : conflit avec le sha actuel (${r.status})`);
  r = await call("POST", "/api/publier", { trip: A, content: nouveau, sha: shaA, path: "index.html" }, KEY_A);
  check(r.status === 200 && r.json.sha === sha1(nouveau), `publication de Sölden réussie (${r.status} ${r.json.erreur || ""})`);
  check(files.get(`${A}/voyage.json`).content === nouveau, "le fichier Sölden/voyage.json est remplacé");
  check(files.get("solden-voyage-2027/index.html").content === "<html>", "un champ « path » envoyé est ignoré : index.html intact");
  check(writes.length === 1 && writes[0].path === `${A}/voyage.json` && writes[0].author?.name === `Éditeur ${A}`, "une seule écriture, au bon chemin, signée « Éditeur » du voyage");
  r = await call("POST", "/api/publier", { trip: A, content: "x".repeat(700 * 1024), sha: r.json.sha }, KEY_A);
  check(r.status === 413, `contenu trop gros refusé (${r.status})`);
  r = await call("POST", "/api/publier", { trip: B, content: JSON.stringify(enc({ t: B, v: 2 })), sha: files.get(`${B}/voyage.json`).sha }, KEY_B);
  check(r.status === 200 && writes.at(-1).path === `${B}/voyage.json`, "la clé de St. Anton publie St. Anton");
} finally {
  wr.kill("SIGINT");
  gh.close();
  fs.rmSync(path.join(root, ".dev.vars"), { force: true });
}
console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
process.exit(failures ? 1 : 0);

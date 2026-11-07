// Test des comptes : premier administrateur, double authentification, comptes accompagnateurs, accès à l'éditeur.
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GH_PORT = 9915, WORKER_PORT = 8795, W = `http://127.0.0.1:${WORKER_PORT}`, ORIGIN = "https://monaccompagnateur.ca";
const ADMIN_TOKEN = "adm-" + crypto.randomBytes(8).toString("hex"), GH_TOKEN = "github_pat_test";
let failures = 0;
const check = (c, l) => { console.log(`${c ? "  ok " : "  ÉCHEC"}  ${l}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TOTP de référence (RFC 6238, SHA-1, 30 s, 6 chiffres)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32dec = (s) => { let bits = 0, v = 0; const out = []; for (const c of s) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
function totp(secret, t = Date.now()) { const step = Math.floor(t / 30000); const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac("sha1", b32dec(secret)).update(msg).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, "0"); }

// faux GitHub minimal (lecture d'un voyage)
const gh = http.createServer((req, res) => { res.writeHead(req.url.includes("voyage.json") ? 200 : 404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ sha: "a".repeat(40), content: Buffer.from('{"chiffre":{"iv":"a","data":"b","salt":"c"}}').toString("base64") })); });
await new Promise((r) => gh.listen(GH_PORT, "127.0.0.1", r));
fs.writeFileSync(path.join(root, ".dev.vars"), ["VAPID_PUBLIC_KEY=x", `ADMIN_TOKEN=${ADMIN_TOKEN}`, `GITHUB_TOKEN=${GH_TOKEN}`, `GITHUB_API=http://127.0.0.1:${GH_PORT}`, "EDITOR_TOKENS={}"].join("\n") + "\n");
fs.rmSync(path.join(root, ".wrangler"), { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
execFileSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--local", "--file=schema.sql"], { cwd: root, env, stdio: "pipe" });
const wr = spawn("npx", ["wrangler", "dev", "--local", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; wr.stdout.on("data", (d) => (out += d)); wr.stderr.on("data", (d) => (out += d));
for (let i = 0; ; i++) { try { if ((await fetch(`${W}/api/vapid`)).ok) break; } catch {} if (i > 60) throw new Error(out); await sleep(500); }
const call = async (method, p, body, tok) => { const r = await fetch(W + p, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

try {
  console.log("\nPremier administrateur");
  check((await call("POST", "/api/auth/premier-admin", { jeton: "faux", username: "mathieu", password: "un-bon-mot-de-passe" })).status === 403, "mauvaise clé de configuration refusée");
  let r = await call("POST", "/api/auth/premier-admin", { jeton: ADMIN_TOKEN, username: "Mathieu", nom: "Mathieu Lavigne", password: "court" });
  check(r.status === 400, "mot de passe trop court refusé");
  r = await call("POST", "/api/auth/premier-admin", { jeton: ADMIN_TOKEN, username: "Mathieu", nom: "Mathieu Lavigne", password: "un-bon-mot-de-passe" });
  check(r.status === 200 && r.json.session?.startsWith("s.") && r.json.profil.role === "admin", "administrateur créé, session ouverte");
  let adm = r.json.session;
  check((await call("POST", "/api/auth/premier-admin", { jeton: ADMIN_TOKEN, username: "autre", password: "un-bon-mot-de-passe" })).status === 409, "un deuxième « premier administrateur » est refusé");
  r = await call("GET", "/api/admin/comptes", null, adm);
  check(r.status === 428 && r.json.etape === "2fa", "administration bloquée tant que la double authentification n'est pas active");

  console.log("\nDouble authentification");
  r = await call("POST", "/api/auth/2fa/debut", {}, adm);
  check(r.status === 200 && /^otpauth:\/\/totp\//.test(r.json.uri), "code QR (otpauth) fourni");
  const secret = r.json.secret;
  check((await call("POST", "/api/auth/2fa/activer", { code: "000000" }, adm)).status === 403, "mauvais code refusé");
  r = await call("POST", "/api/auth/2fa/activer", { code: totp(secret) }, adm);
  check(r.status === 200 && r.json.codesSecours?.length === 8, "activée, 8 codes de secours");
  const secours = r.json.codesSecours;
  check((await call("GET", "/api/admin/comptes", null, adm)).status === 200, "administration ouverte");

  console.log("\nConnexion en deux étapes");
  r = await call("POST", "/api/auth/connexion", { username: "mathieu", password: "mauvais" });
  check(r.status === 403, "mauvais mot de passe refusé");
  r = await call("POST", "/api/auth/connexion", { username: "MATHIEU", password: "un-bon-mot-de-passe" });
  check(r.status === 200 && r.json.deuxEtapes && r.json.defi && !r.json.session, "mot de passe correct : code demandé, pas de session");
  const defi = r.json.defi;
  check((await call("POST", "/api/auth/code", { defi, code: "123456" })).status === 403, "mauvais code refusé");
  r = await call("POST", "/api/auth/code", { defi, code: secours[0] });
  check(r.status === 200 && r.json.session, "code de secours accepté");
  r = await call("POST", "/api/auth/connexion", { username: "mathieu", password: "un-bon-mot-de-passe" });
  check((await call("POST", "/api/auth/code", { defi: r.json.defi, code: secours[0] })).status === 403, "un code de secours ne sert qu'une fois");
  r = await call("POST", "/api/auth/connexion", { username: "mathieu", password: "un-bon-mot-de-passe" });
  const r2 = await call("POST", "/api/auth/code", { defi: r.json.defi, code: totp(secret, Date.now() + 30000) });
  check(r2.status === 200, "code de l'app d'authentification accepté (±30 s)");
  adm = r2.json.session;

  console.log("\nComptes accompagnateurs");
  r = await call("POST", "/api/admin/comptes", { username: "julie.b", nom: "Julie B.", role: "accompagnateur", trips: ["st-anton-mars2027"] }, adm);
  check(r.status === 200 && r.json.motDePasse, "compte créé avec un mot de passe temporaire");
  const temp = r.json.motDePasse;
  r = await call("POST", "/api/auth/connexion", { username: "julie.b", password: temp });
  check(r.status === 200 && r.json.session && r.json.profil.doitChanger, "connexion, changement de mot de passe exigé");
  let ju = r.json.session;
  check((await call("GET", "/api/voyage?trip=st-anton-mars2027", null, ju)).status === 403, "pas d'accès à l'éditeur avant d'avoir changé le mot de passe");
  check((await call("POST", "/api/auth/mdp", { ancien: temp, nouveau: "court" }, ju)).status === 400, "nouveau mot de passe trop court refusé");
  check((await call("POST", "/api/auth/mdp", { ancien: temp, nouveau: "le-nouveau-de-julie" }, ju)).status === 200, "mot de passe changé");
  check((await call("GET", "/api/voyage?trip=st-anton-mars2027", null, ju)).status === 200, "accès à l'éditeur de son voyage");
  check((await call("GET", "/api/voyage?trip=solden-voyage-2027", null, ju)).status === 403, "pas d'accès à un autre voyage");
  check((await call("GET", "/api/admin/comptes", null, ju)).status === 403, "pas d'accès à l'administration");
  check((await call("GET", "/api/voyage?trip=solden-voyage-2027", null, adm)).status === 200, "l'administrateur ouvre tous les voyages");

  console.log("\nBlocage et administration des comptes");
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/connexion", { username: "julie.b", password: "faux-faux-faux" });
  r = await call("POST", "/api/auth/connexion", { username: "julie.b", password: "le-nouveau-de-julie" });
  check(r.status === 429, "bloqué après 5 essais ratés, même avec le bon mot de passe");
  r = await call("POST", "/api/admin/comptes/mdp", { username: "julie.b" }, adm);
  check(r.status === 200 && r.json.motDePasse, "réinitialisation par l'administrateur (débloque)");
  check((await call("GET", "/api/voyage?trip=st-anton-mars2027", null, ju)).status === 401, "les sessions de Julie sont fermées");
  check((await call("POST", "/api/auth/connexion", { username: "julie.b", password: r.json.motDePasse })).status === 200, "connexion avec le nouveau mot de passe temporaire");
  check((await call("POST", "/api/admin/comptes/modifier", { username: "mathieu", actif: false }, adm)).status === 400, "l'administrateur ne peut pas désactiver son propre compte");
  r = await call("POST", "/api/admin/comptes/modifier", { username: "julie.b", actif: false }, adm);
  check(r.status === 200 && (await call("POST", "/api/auth/connexion", { username: "julie.b", password: "x-x-x-x-x-x" })).status === 403, "compte désactivé");
  r = await call("GET", "/api/admin/comptes", null, adm);
  check(r.json.comptes?.length === 2 && !JSON.stringify(r.json).includes("pbkdf2"), "liste des comptes, sans aucune empreinte de mot de passe");
  check((await call("POST", "/api/auth/deconnexion", {}, adm)).status === 200 && (await call("GET", "/api/auth/moi", null, adm)).status === 401, "déconnexion");
} finally { wr.kill("SIGINT"); gh.close(); fs.rmSync(path.join(root, ".dev.vars"), { force: true }); }
console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
process.exit(failures ? 1 : 0);

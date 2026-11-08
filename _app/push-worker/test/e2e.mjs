// Test de bout en bout : wrangler dev (D1 local) + faux service de push qui
// vérifie la signature VAPID et déchiffre chaque message comme le ferait un téléphone.
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRIPS_TEST, premierAdmin } from "./outils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUSH_PORT = 9911, WORKER_PORT = 8799;
const W = `http://127.0.0.1:${WORKER_PORT}`;
const ORIGIN = "https://monaccompagnateur.ca";
const TRIP = "solden-voyage-2027";
const ADMIN_TOKEN = "adm-" + crypto.randomBytes(8).toString("hex");

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "  ok " : "  ÉCHEC"}  ${label}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- clés VAPID et .dev.vars ----------
const vapid = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pubJwk = vapid.publicKey.export({ format: "jwk" });
const privJwk = vapid.privateKey.export({ format: "jwk" });
const vapidPublicRaw = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, "base64url"), Buffer.from(pubJwk.y, "base64url")]).toString("base64url");

fs.writeFileSync(path.join(root, ".dev.vars"), [
  `VAPID_PUBLIC_KEY=${vapidPublicRaw}`,
  `VAPID_PRIVATE_JWK=${JSON.stringify({ kty: "EC", crv: "P-256", x: privJwk.x, y: privJwk.y, d: privJwk.d })}`,
  `ADMIN_TOKEN=${ADMIN_TOKEN}`,
  TRIPS_TEST,
  `ALLOW_ANY_PUSH_HOST=1`,
  `MAX_PUSH_PER_RUN=5`,
  `PUBLISH_DELAY_SECONDS=2`,
].join("\n") + "\n");

// ---------- faux téléphones ----------
function makeDevice(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { name, ecdh, auth: crypto.randomBytes(16), received: [] };
}
const devices = [];
for (let i = 0; i < 7; i++) devices.push(makeDevice(`tel${i}`));
const gone = makeDevice("gone");

const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const hkdf = (salt, ikm, info, len) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

function decrypt(dev, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = dev.ecdh.getPublicKey();
  const secret = dev.ecdh.computeSecret(asPublic);
  const ikm = hkdf(dev.auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  let pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  if (pt[end] !== 2) throw new Error("délimiteur manquant");
  return JSON.parse(pt.subarray(0, end).toString("utf8"));
}

function verifyVapid(authHeader) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader || "");
  if (!m) return "en-tête absent";
  if (m[2] !== vapidPublicRaw) return "clé k différente";
  const [h, c, s] = m[1].split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  if (claims.aud !== `http://127.0.0.1:${PUSH_PORT}`) return `aud = ${claims.aud}`;
  if (!(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400)) return "exp invalide";
  if (!/^(mailto:|https:)/.test(claims.sub)) return "sub invalide";
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: vapid.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return ok ? null : "signature invalide";
}

const pushLog = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const name = req.url.split("/").pop();
    const body = Buffer.concat(chunks);
    const entry = { name, headers: req.headers, err: null };
    pushLog.push(entry);
    if (name === "gone") { res.writeHead(410); return res.end(); }
    const dev = devices.find((d) => d.name === name);
    try {
      const e = verifyVapid(req.headers.authorization);
      if (e) throw new Error("VAPID : " + e);
      if (req.headers["content-encoding"] !== "aes128gcm") throw new Error("Content-Encoding");
      if (!req.headers.ttl) throw new Error("TTL manquant");
      dev.received.push(decrypt(dev, body));
      res.writeHead(201); res.end();
    } catch (err) {
      entry.err = err.message;
      res.writeHead(400); res.end();
    }
  });
});
await new Promise((r) => server.listen(PUSH_PORT, "127.0.0.1", r));

// ---------- base locale et Worker ----------
fs.rmSync(path.join(root, ".wrangler"), { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
execFileSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--local", "--file=schema.sql"], { cwd: root, env, stdio: "pipe" });

const wr = spawn("npx", ["wrangler", "dev", "--local", "--test-scheduled", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let wrOut = "";
wr.stdout.on("data", (d) => (wrOut += d));
wr.stderr.on("data", (d) => (wrOut += d));

async function up() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${W}/api/vapid`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("wrangler dev ne démarre pas :\n" + wrOut);
}

async function call(method, p, body, headers = {}) {
  const r = await fetch(W + p, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
}
let editor = null;   // session d'un compte (administrateur avec double authentification)
const cron = () => fetch(`${W}/__scheduled?cron=*+*+*+*+*`);
const subOf = (d) => ({ endpoint: `http://127.0.0.1:${PUSH_PORT}/push/${d.name}`, keys: { p256dh: d.ecdh.getPublicKey().toString("base64url"), auth: d.auth.toString("base64url") } });

try {
  await up();
  editor = { Authorization: "Bearer " + await premierAdmin((m, p, b, k) => call(m, p, b, k ? { Authorization: "Bearer " + k } : {}), ADMIN_TOKEN) };
  console.log("\nAPI publique");
  let r = await call("GET", "/api/vapid");
  check(r.json.publicKey === vapidPublicRaw, "clé publique VAPID servie");
  r = await call("OPTIONS", "/api/subscribe");
  check(r.status === 204 && r.headers.get("access-control-allow-origin") === ORIGIN, "préflight CORS pour monaccompagnateur.ca");

  console.log("\nAbonnements");
  for (const d of [...devices, gone]) {
    r = await call("POST", "/api/subscribe", { trip: TRIP, subscription: subOf(d) });
    if (r.status !== 200) check(false, `abonnement ${d.name} (${r.status} ${JSON.stringify(r.json)})`);
  }
  check(true, "8 téléphones abonnés");
  r = await call("POST", "/api/subscribe", { trip: TRIP, subscription: subOf(devices[0]) });
  check(r.status === 200, "réabonnement du même téléphone accepté (pas de doublon)");
  r = await call("POST", "/api/subscribe", { trip: TRIP, subscription: subOf(devices[0]) }, { Origin: "https://ailleurs.example" });
  check(r.status === 403, "origine étrangère refusée");
  r = await call("POST", "/api/subscribe", { trip: "voyage-inconnu", subscription: subOf(devices[0]) });
  check(r.status === 404, "voyage inconnu refusé");
  r = await call("POST", "/api/subscribe", { trip: TRIP, subscription: { ...subOf(devices[0]), keys: { p256dh: "abc", auth: "def" } } });
  check(r.status === 400, "clés malformées refusées");

  console.log("\nAuthentification de l'éditeur");
  r = await call("POST", "/api/schedule", { trip: TRIP, items: [] });
  check(r.status === 401, "sans jeton : 401");
  r = await call("POST", "/api/schedule", { trip: TRIP, items: [] }, { Authorization: "Bearer mauvais-jeton-sans-compte" });
  check(r.status === 401, "ancienne clé d'éditeur ou jeton inconnu : 401");
  r = await call("POST", "/api/schedule", { trip: TRIP, items: [] }, { Authorization: "Bearer s.session-inconnue" });
  check(r.status === 401, "session inconnue : 401");

  console.log("\nCalendrier");
  const now = Date.now();
  r = await call("POST", "/api/schedule", {
    trip: TRIP,
    items: [
      { id: "a0", at: new Date(now - 86400000).toISOString(), kind: "annonce" },
      { id: "a1", at: new Date(now).toISOString(), kind: "annonce" },
      { id: "a2", at: new Date(now + 3600000).toISOString(), kind: "rappel" },
    ],
  }, editor);
  check(r.status === 200 && r.json.programmees === 2 && r.json.ignorees_passees === 1, `ancienne annonce ignorée, 2 programmées (${JSON.stringify(r.json)})`);
  r = await call("POST", "/api/schedule", { trip: TRIP, items: [{ id: "x", at: "pas une date" }] }, editor);
  check(r.status === 400, "date invalide refusée");

  await cron();
  await sleep(300);
  check(pushLog.length === 0, "rien n'est envoyé pendant le délai de publication GitHub Pages");

  await sleep(2200);
  await cron(); await sleep(500);
  const firstRun = pushLog.length;
  check(firstRun === 5, `1er passage du cron : 5 envois (plafond par passage), obtenu ${firstRun}`);
  await cron(); await sleep(500);
  await cron(); await sleep(500);
  const real = pushLog.filter((e) => e.name !== "gone");
  check(real.length === 7 && real.every((e) => !e.err), `7 téléphones servis, VAPID vérifié et message déchiffré (${real.filter((e) => e.err).map((e) => e.err).join("; ")})`);
  check(devices.every((d) => d.received.length === 1 && d.received[0].id === "a1" && d.received[0].kind === "annonce"), "chaque téléphone a reçu l'annonce a1 une seule fois");
  const m = devices[0].received[0];
  check(m.title === "Sölden 2027" && /Nouvelle annonce/.test(m.body) && m.url.startsWith("/solden-voyage-2027/"), `texte générique, accents intacts : « ${m.title} — ${m.body} »`);
  check(pushLog.filter((e) => e.name === "gone").length === 1, "abonnement expiré (410) contacté une seule fois");

  await cron(); await sleep(500);
  check(devices.every((d) => d.received.length === 1), "aucun renvoi aux passages suivants");

  console.log("\nModification et retrait");
  r = await call("POST", "/api/schedule", { trip: TRIP, items: [{ id: "a1", at: new Date(now).toISOString() }] }, editor);
  check(r.json.ignorees_deja_envoyees === 1 && r.json.retirees === 1, `a1 déjà partie ignorée, a2 retirée (${JSON.stringify(r.json)})`);

  console.log("\nTest et état");
  r = await call("POST", "/api/test", { trip: TRIP }, editor);
  check(r.status === 200, "alerte de test programmée");
  await cron(); await sleep(500); await cron(); await sleep(500);
  check(devices.every((d) => d.received.length === 2 && d.received[1].kind === "test"), "alerte de test reçue par les 7 téléphones");
  check(pushLog.filter((e) => e.name === "gone").length === 1, "l'abonnement expiré a bien été supprimé");

  r = await call("GET", `/api/status?trip=${TRIP}`, null, editor);
  const a1 = (r.json.annonces || []).find((a) => a.id === "a1");
  check(r.json.abonnements === 7 && a1 && a1.livrees === 7 && a1.termine, `état : 7 abonnés, a1 livrée à 7 (${JSON.stringify({ abonnements: r.json.abonnements, a1 })})`);

  r = await call("POST", "/api/unsubscribe", { trip: TRIP, endpoint: subOf(devices[6]).endpoint });
  r = await call("GET", `/api/status?trip=${TRIP}`, null, editor);
  check(r.json.abonnements === 6, "désabonnement d'un téléphone");

  r = await call("POST", "/api/purge", { trip: TRIP }, editor);
  r = await call("GET", `/api/status?trip=${TRIP}`, null, editor);
  check(r.json.abonnements === 0 && r.json.annonces.length === 0, "purge : plus aucune donnée du voyage");
} catch (err) {
  failures++;
  console.error(err);
} finally {
  wr.kill("SIGTERM");
  server.close();
  fs.rmSync(path.join(root, ".dev.vars"), { force: true });
}

console.log(failures ? `\n${failures} échec(s)\n` : "\nTous les tests passent.\n");
if (failures) console.log(wrOut.split("\n").slice(-40).join("\n"));
process.exit(failures ? 1 : 0);

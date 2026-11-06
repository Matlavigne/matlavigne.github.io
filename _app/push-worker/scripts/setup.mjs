// Installation en une commande : génère la paire VAPID et un jeton d'éditeur par voyage,
// puis les enregistre comme secrets du Worker (ils ne sont écrits nulle part ailleurs).
// Usage : npx wrangler login, puis npm run setup, puis npm run deploy
import { webcrypto as crypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const toml = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const trips = [...toml.matchAll(/^\[vars\.TRIPS\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
const b64url = (buf) => Buffer.from(buf).toString("base64url");

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
const priv = JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d });
const tokens = Object.fromEntries(trips.map((t) => [t, b64url(crypto.getRandomValues(new Uint8Array(24)))]));

// Le Worker doit exister pour recevoir des secrets : un premier déploiement le crée
console.log("Premier déploiement du Worker…");
let r = spawnSync("npx", ["wrangler", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0) process.exit(r.status || 1);

for (const [name, value] of [["VAPID_PUBLIC_KEY", pub], ["VAPID_PRIVATE_JWK", priv], ["EDITOR_TOKENS", JSON.stringify(tokens)]]) {
  console.log(`Secret ${name}…`);
  r = spawnSync("npx", ["wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`Échec pour ${name}`); process.exit(r.status || 1); }
}

console.log("\n✓ Clés installées. Le Worker est en ligne (adresse affichée plus haut : …workers.dev).");
console.log("\nJetons d'éditeur — à garder dans votre gestionnaire de mots de passe.");
console.log("Chaque éditeur de voyage demande le sien une seule fois :\n");
for (const [t, v] of Object.entries(tokens)) console.log(`  ${t.padEnd(22)} ${v}`);
console.log("\nNe relancez pas « npm run setup » : de nouvelles clés désabonneraient les téléphones.\n");

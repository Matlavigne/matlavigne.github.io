// Installation initiale (une seule fois) : génère la paire VAPID des notifications et l'enregistre comme secrets du Worker.
// Usage : npx wrangler login, puis npm run setup, puis npm run deploy
// NE PAS RELANCER sur un Worker en service : de nouvelles clés désabonneraient tous les téléphones.
import { webcrypto as crypto } from "node:crypto";
import { spawnSync } from "node:child_process";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
const priv = JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d });

// Le Worker doit exister pour recevoir des secrets : un premier déploiement le crée
console.log("Premier déploiement du Worker…");
let r = spawnSync("npx", ["wrangler", "deploy"], { stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0) process.exit(r.status || 1);

for (const [name, value] of [["VAPID_PUBLIC_KEY", pub], ["VAPID_PRIVATE_JWK", priv]]) {
  console.log(`Secret ${name}…`);
  r = spawnSync("npx", ["wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`Échec pour ${name}`); process.exit(r.status || 1); }
}

console.log("\n✓ Clés installées. Le Worker est en ligne (adresse affichée plus haut : …workers.dev).");
console.log("Ensuite : npm run cle-config (clé de première configuration), puis monaccompagnateur.ca/admin › Première configuration.");
console.log("\nNe relancez pas « npm run setup » : de nouvelles clés désabonneraient les téléphones.\n");

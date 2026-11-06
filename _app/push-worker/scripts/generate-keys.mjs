// Génère la paire de clés VAPID et un jeton d'éditeur.
// Usage : node scripts/generate-keys.mjs            (un jeton par voyage de wrangler.toml)
import { webcrypto as crypto } from "node:crypto";
import fs from "node:fs";

const trips = [...fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").matchAll(/^\[vars\.TRIPS\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
const b64url = (buf) => Buffer.from(buf).toString("base64url");

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const tokens = Object.fromEntries(trips.map((t) => [t, b64url(crypto.getRandomValues(new Uint8Array(24)))]));

console.log("\n1) Clé publique VAPID — à mettre dans wrangler.toml (VAPID_PUBLIC_KEY) :\n");
console.log(b64url(pub));
console.log("\n2) Clé privée VAPID — secret, à coller quand wrangler la demande :");
console.log("   npx wrangler secret put VAPID_PRIVATE_JWK\n");
console.log(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
console.log("\n3) Jetons d'éditeur — secret :");
console.log("   npx wrangler secret put EDITOR_TOKENS\n");
console.log(JSON.stringify(tokens));
console.log("\n   (le jeton de chaque voyage sera demandé une fois par l’éditeur de ce voyage)");
console.log("\nGardez une copie de ces valeurs dans votre gestionnaire de mots de passe.");
console.log("Ne changez plus la paire VAPID une fois des téléphones abonnés : ils devraient se réabonner.\n");

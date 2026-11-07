// Clé de première configuration (secret ADMIN_TOKEN) : sert une seule fois, à créer le premier compte administrateur.
// Usage : npm run cle-config   — la clé s'affiche une seule fois.
import { webcrypto as crypto } from "node:crypto";
import { spawnSync } from "node:child_process";

const cle = "adm-" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
const r = spawnSync("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN"], { input: cle, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
if (r.status !== 0) { console.error("Échec : la clé n'a pas été installée."); process.exit(r.status || 1); }
console.log("\n✓ Clé de première configuration installée.");
console.log("\nClé de première configuration (monaccompagnateur.ca/admin › Première configuration) :\n  " + cle + "\n");

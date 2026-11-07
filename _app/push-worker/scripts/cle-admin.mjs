// Crée (ou remplace) la clé d'administration : secret ADMIN_TOKEN du Worker.
// Usage : npm run cle-admin   — la clé s'affiche une seule fois : gardez-la dans votre gestionnaire de mots de passe.
import { webcrypto as crypto } from "node:crypto";
import { spawnSync } from "node:child_process";

const cle = "adm-" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
const r = spawnSync("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN"], { input: cle, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
if (r.status !== 0) { console.error("Échec : la clé n'a pas été installée."); process.exit(r.status || 1); }
console.log("\n✓ Clé d'administration installée. Elle remplace l'ancienne, s'il y en avait une.");
console.log("\nClé d'administration (pour monaccompagnateur.ca/admin) :\n  " + cle + "\n");

// Clé maîtresse du serveur (secret CLE_MAITRE) : chiffre au repos, dans la base D1, la clé du contenu de chaque voyage.
// Usage : npm run cle-maitre   — une seule fois. La clé s'affiche une seule fois : gardez-la dans votre gestionnaire
// de mots de passe. Sans elle, les clés gardées par le serveur ne s'ouvrent plus (il faudrait rechiffrer chaque voyage).
import { webcrypto as crypto } from "node:crypto";
import { spawnSync } from "node:child_process";

const win = process.platform === "win32";
const forcer = process.argv.includes("--remplacer");
const liste = spawnSync("npx", ["wrangler", "secret", "list"], { encoding: "utf8", shell: win });
if (liste.status !== 0) { console.error("Impossible de lire les secrets du Worker (connectez-vous avec « npx wrangler login »)."); process.exit(1); }
if (/"CLE_MAITRE"/.test(liste.stdout) && !forcer) {
  console.error("La clé maîtresse est déjà installée. Ne la remplacez pas : les clés des voyages ne s'ouvriraient plus.");
  console.error("(Seulement si vous savez ce que vous faites : npm run cle-maitre -- --remplacer)");
  process.exit(1);
}
const cle = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const r = spawnSync("npx", ["wrangler", "secret", "put", "CLE_MAITRE"], { input: cle, stdio: ["pipe", "inherit", "inherit"], shell: win });
if (r.status !== 0) { console.error("Échec : la clé maîtresse n'a pas été installée."); process.exit(r.status || 1); }
console.log("\n✓ Clé maîtresse installée dans le Worker.");
console.log("\nCopie de secours (gestionnaire de mots de passe, jamais ailleurs) :\n  " + cle + "\n");

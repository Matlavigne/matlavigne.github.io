// Crée ou remplace la clé d'éditeur d'UN voyage, sans toucher aux autres.
// Usage : npm run cle -- <dossier-du-voyage>      (ex. npm run cle -- zermatt-mars2027)
// Le script demande le JSON actuel des clés (celui de votre gestionnaire de mots de passe),
// installe la nouvelle version du secret EDITOR_TOKENS, puis affiche la nouvelle clé et le JSON à garder.
// Remplacer la clé d'un voyage retire l'accès à l'ancienne clé immédiatement.
import { webcrypto as crypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import fs from "node:fs";

const trip = process.argv[2];
if (!trip || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(trip)) { console.error("Usage : npm run cle -- <dossier-du-voyage>"); process.exit(1); }
const toml = fs.readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
if (!new RegExp(`^\\[vars\\.TRIPS\\.${trip}\\]`, "m").test(toml)) console.warn(`Attention : ${trip} n'est pas encore dans wrangler.toml (bloc [vars.TRIPS.${trip}]). Ajoutez-le, puis npm run deploy.`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const raw = (await rl.question("Collez le JSON actuel des clés d'éditeur (vide s'il n'y en a pas encore) :\n")).trim();
rl.close();
let tokens = {};
if (raw) { try { tokens = JSON.parse(raw); } catch { console.error("JSON illisible : rien n'a été changé."); process.exit(1); } }
const remplace = !!tokens[trip];
tokens[trip] = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

const r = spawnSync("npx", ["wrangler", "secret", "put", "EDITOR_TOKENS"], { input: JSON.stringify(tokens), stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
if (r.status !== 0) { console.error("Échec : le secret n'a pas été modifié."); process.exit(r.status || 1); }
console.log(`\n✓ ${remplace ? "Clé remplacée" : "Clé créée"} pour ${trip}. Elle fonctionne dans quelques secondes.`);
console.log(`\nClé de l'éditeur à remettre à l'accompagnateur de ${trip} :\n  ${tokens[trip]}`);
console.log("\nNouveau JSON de toutes les clés, à garder dans votre gestionnaire de mots de passe :\n" + JSON.stringify(tokens));

// Secours : téléphone perdu ou mot de passe oublié pour un compte administrateur.
// Usage : npm run secours-admin -- <nom-d-usager>
// Retire la double authentification du compte, lui donne un mot de passe temporaire et ferme ses sessions.
// À la prochaine connexion : changer le mot de passe, puis réactiver la double authentification.
import { webcrypto as crypto, pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const user = String(process.argv[2] || "").toLowerCase();
if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(user)) { console.error("Usage : npm run secours-admin -- <nom-d-usager>"); process.exit(1); }
const MOTS = ["marmotte", "chamois", "fondue", "raclette", "poudreuse", "gondole", "sapin", "glacier", "sommet", "chalet", "flocon", "bouquetin"];
const r = randomBytes(4);
const pw = `${MOTS[r[0] % MOTS.length]}-${MOTS[r[1] % MOTS.length]}-${MOTS[r[2] % MOTS.length]}-${10 + (r[3] % 90)}`;
const b64url = (b) => Buffer.from(b).toString("base64url");
const salt = randomBytes(16), iter = 40000;
const hash = `pbkdf2$${iter}$${b64url(salt)}$${b64url(pbkdf2Sync(pw.normalize("NFC"), salt, iter, 32, "sha256"))}`;
const sql = `UPDATE users SET pw='${hash}', must_change=1, totp=NULL, totp_on=0, secours=NULL, failed=0, locked_until=0, actif=1 WHERE username='${user}'; DELETE FROM sessions WHERE username='${user}';`;
const x = spawnSync("npx", ["wrangler", "d1", "execute", "monaccompagnateur-push", "--remote", "--command", sql], { stdio: "inherit", shell: process.platform === "win32" });
if (x.status !== 0) { console.error("Échec : rien n'a été changé."); process.exit(x.status || 1); }
console.log(`\n✓ Compte ${user} réinitialisé (si ce nom d'usager existe).\nMot de passe temporaire : ${pw}\nÀ la connexion : nouveau mot de passe, puis nouvelle double authentification.\n`);

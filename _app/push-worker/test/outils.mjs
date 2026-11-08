// Outils communs aux tests : voyages de test, code de double authentification, sessions de comptes.
import crypto from "node:crypto";

// Voyages connus du Worker pendant les tests (comme le bloc [vars.TRIPS] de wrangler.toml)
export const TRIPS_TEST = "TRIPS=" + JSON.stringify({
  "solden-voyage-2027": { title: "Sölden 2027", url: "/solden-voyage-2027/", end: "2027-03-13", maxSubs: 300 },
  "st-anton-mars2027": { title: "St. Anton 2027", url: "/st-anton-mars2027/", end: "2027-03-14", maxSubs: 300 },
  "zermatt-mars2027": { title: "Zermatt 2027", url: "/zermatt-mars2027/", end: "2027-03-31", maxSubs: 300 },
});

// TOTP de référence (RFC 6238, SHA-1, 30 s, 6 chiffres)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32dec = (s) => { let bits = 0, v = 0; const out = []; for (const c of s) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
export function totp(secret, t = Date.now()) { const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = crypto.createHmac("sha1", b32dec(secret)).update(msg).digest(); const o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, "0"); }

// Premier administrateur (avec double authentification) : renvoie sa session
export async function premierAdmin(call, adminToken, username = "admin") {
  let r = await call("POST", "/api/auth/premier-admin", { jeton: adminToken, username, password: "mot-de-passe-test" });
  const s = r.json.session;
  r = await call("POST", "/api/auth/2fa/debut", {}, s);
  await call("POST", "/api/auth/2fa/activer", { code: totp(r.json.secret) }, s);
  return s;
}
// Compte accompagnateur prêt à publier (mot de passe changé, double authentification) : renvoie sa session
export async function accompagnateur(call, admin, username, trips) {
  let r = await call("POST", "/api/admin/comptes", { username, nom: username, role: "accompagnateur", trips }, admin);
  const tmp = r.json.motDePasse;
  r = await call("POST", "/api/auth/connexion", { username, password: tmp });
  const s = r.json.session;
  await call("POST", "/api/auth/mdp", { ancien: tmp, nouveau: username + "-nouveau-mdp" }, s);
  r = await call("POST", "/api/auth/2fa/debut", {}, s);
  await call("POST", "/api/auth/2fa/activer", { code: totp(r.json.secret) }, s);
  return s;
}

// Contenu de voyage chiffré comme le fait le navigateur (AES-256-GCM), avec sa clé { sel, k }
export function nouvelleCle() { return { sel: crypto.randomBytes(16).toString("base64"), k: crypto.randomBytes(32).toString("base64") }; }
export async function chiffrerVoyage(o, cle = nouvelleCle()) {
  const k = await crypto.webcrypto.subtle.importKey("raw", Buffer.from(cle.k, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.randomBytes(12);
  const data = Buffer.from(await crypto.webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k, Buffer.from(JSON.stringify(o))));
  return { cle, contenu: JSON.stringify({ titre: o.titre || "T", debut: o.debut || "2028-02-05", fin: o.fin || "2028-02-12", chiffre: { v: 2, alg: "AES-256-GCM", salt: cle.sel, iv: iv.toString("base64"), data: data.toString("base64") } }) };
}
export const CLE_MAITRE_TEST = "CLE_MAITRE=" + crypto.randomBytes(32).toString("base64");

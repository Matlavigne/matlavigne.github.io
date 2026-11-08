// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
/* Clé du contenu de chaque voyage, gardée par le Worker.

   Le contenu d'un voyage (<voyage>/voyage.json) est chiffré dans le navigateur avec une clé AES-256 propre au voyage.
   Le Worker garde cette clé, elle-même chiffrée au repos (AES-256-GCM) avec la clé maîtresse CLE_MAITRE, un secret
   Cloudflare tenu hors de la base : une copie de la base D1 seule ne permet pas d'ouvrir le contenu.

   La clé n'est remise qu'aux comptes qui ont le voyage (accompagnateurs assignés, administrateurs), avec double
   authentification. Les voyageurs la reçoivent chiffrée pour leur téléphone (ECDH P-256 + AES-256-GCM), à l'approbation
   de leur demande d'accès, puis de nouveau, automatiquement, quand la clé change.

   Forme de la clé : { sel, k } en base64. « sel » identifie la clé (il est aussi écrit en clair dans voyage.json,
   chiffre.salt); k = les 32 octets de la clé AES. Pour un voyage chiffré autrefois avec une phrase, k est la clé
   tirée de la phrase par PBKDF2 et sel est le sel d'origine : les téléphones déjà ouverts n'y voient aucune différence. */

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const enc = new TextEncoder();
const b64 = (u) => { let x = ""; for (let i = 0; i < u.length; i += 0x8000) x += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(x); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class CleError extends Error { constructor(status, message) { super(message); this.status = status; } }

let schemaOk = false;
async function schema(env) {
  if (schemaOk) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS cles_voyage (trip TEXT PRIMARY KEY, sel TEXT NOT NULL, iv TEXT NOT NULL, data TEXT NOT NULL, maj INTEGER NOT NULL, par TEXT)").run();
  schemaOk = true;
}

/* Clé maîtresse : 32 octets en base64 (secret CLE_MAITRE, installé par « npm run cle-maitre ») */
async function maitre(env) {
  const s = String(env.CLE_MAITRE || "").trim();
  let raw = null;
  try { if (B64.test(s)) raw = unb64(s); } catch (e) { raw = null; }
  if (!raw || raw.length !== 32) throw new CleError(503, "Clé maîtresse du serveur absente ou invalide (npm run cle-maitre)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* À appeler avant d'écrire sur GitHub ce qui dépend d'une clé à garder : pas de publication si la clé ne peut être gardée */
export async function verifierMaitre(env) { await maitre(env); }

/* Vérifie la forme d'une clé reçue d'un navigateur : { sel, k } */
export function cleValide(c) {
  if (!c || typeof c !== "object") return null;
  const sel = String(c.sel || ""), k = String(c.k || "");
  if (!B64.test(sel) || sel.length < 12 || sel.length > 64) return null;
  if (!B64.test(k)) return null;
  let raw; try { raw = unb64(k); } catch (e) { return null; }
  if (raw.length !== 32) return null;
  return { sel, k };
}

export async function lireCle(env, trip) {
  await schema(env);
  const r = await env.DB.prepare("SELECT sel, iv, data FROM cles_voyage WHERE trip = ?").bind(trip).first();
  if (!r) return null;
  const m = await maitre(env);
  let pt;
  try { pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv), additionalData: enc.encode(trip + "|" + r.sel) }, m, unb64(r.data)); }
  catch (e) { throw new CleError(500, "La clé du voyage ne s'ouvre pas avec la clé maîtresse du serveur"); }
  return { sel: r.sel, k: b64(new Uint8Array(pt)) };
}

export async function ecrireCle(env, trip, cle, par) {
  await schema(env);
  const m = await maitre(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(trip + "|" + cle.sel) }, m, unb64(cle.k)));
  await env.DB.prepare("INSERT INTO cles_voyage (trip, sel, iv, data, maj, par) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (trip) DO UPDATE SET sel = excluded.sel, iv = excluded.iv, data = excluded.data, maj = excluded.maj, par = excluded.par")
    .bind(trip, cle.sel, b64(iv), b64(data), Date.now(), par || null).run();
}

export async function effacerCle(env, trip) {
  await schema(env);
  await env.DB.prepare("DELETE FROM cles_voyage WHERE trip = ?").bind(trip).run();
}

/* La clé ouvre-t-elle ce bloc chiffré (chiffre de voyage.json)? */
export async function cleOuvre(cle, chiffre) {
  if (!chiffre || chiffre.salt !== cle.sel) return false;
  try {
    const k = await crypto.subtle.importKey("raw", unb64(cle.k), { name: "AES-GCM" }, false, ["decrypt"]);
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(chiffre.iv) }, k, unb64(chiffre.data));
    return true;
  } catch (e) { return false; }
}

/* Clé du voyage chiffrée pour le téléphone d'un voyageur (même enveloppe que celle que l'app sait ouvrir) :
   ECDH P-256 éphémère avec la clé publique du téléphone, puis AES-256-GCM de { salt, k }. */
export async function envelopperPour(pub, cle) {
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const dev = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const k = await crypto.subtle.deriveKey({ name: "ECDH", public: dev }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(JSON.stringify({ salt: cle.sel, k: cle.k }))));
  const e = await crypto.subtle.exportKey("jwk", eph.publicKey);
  return { epk: { x: e.x, y: e.y }, iv: b64url(iv), data: b64url(data) };
}

/* Après un changement de clé : la nouvelle clé part aux voyageurs déjà approuvés, et seulement à eux */
export async function renouvelerVoyageurs(env, trip, cle) {
  let r;
  try { r = (await env.DB.prepare("SELECT id, pub FROM demandes WHERE trip = ? AND statut = 'ok' AND (sel IS NULL OR sel != ?) LIMIT 1000").bind(trip, cle.sel).all()).results || []; }
  catch (e) { return 0; } // table des demandes absente : personne à renouveler
  let n = 0;
  for (const d of r) {
    let pub; try { pub = JSON.parse(d.pub); } catch (e) { continue; }
    try {
      const env2 = await envelopperPour(pub, cle);
      await env.DB.prepare("UPDATE demandes SET cle = ?, sel = ? WHERE id = ?").bind(JSON.stringify(env2), cle.sel, d.id).run();
      n++;
    } catch (e) { /* clé publique illisible : ignorée */ }
  }
  return n;
}


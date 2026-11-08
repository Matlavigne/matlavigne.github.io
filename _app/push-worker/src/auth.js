// Comptes (nom d'usager + mot de passe), sessions et double authentification (TOTP, RFC 6238).
// Rôles : « admin » (administration complète, double authentification obligatoire)
//         « accompagnateur » (éditeur de ses voyages seulement).
// Rien n'est gardé en clair : mots de passe en PBKDF2 salé, jetons de session et codes de secours en SHA-256.

export class AuthError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

const enc = new TextEncoder();
const b64url = (u) => { let x = ""; for (let i = 0; i < u.length; i++) x += String.fromCharCode(u[i]); return btoa(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const sha = async (s) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
async function same(a, b) { const [x, y] = [enc.encode(await sha(String(a))), enc.encode(await sha(String(b)))]; let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }

// ---------- mots de passe ----------
const PW_ITER = 40000; // plafond du forfait gratuit de Workers : 10 ms de calcul par requête
async function pbkdf2(pw, salt, iter) {
  const k = await crypto.subtle.importKey("raw", enc.encode(String(pw).normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  return b64url(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64url(salt), iterations: iter }, k, 256)));
}
export async function hashPw(pw) { const salt = b64url(rnd(16)); return `pbkdf2$${PW_ITER}$${salt}$${await pbkdf2(pw, salt, PW_ITER)}`; }
async function checkPw(pw, stored) {
  const [alg, iter, salt, h] = String(stored || "").split("$");
  if (alg !== "pbkdf2") { await pbkdf2(pw, b64url(rnd(16)), PW_ITER); return false; } // même durée qu'un vrai essai
  return same(await pbkdf2(pw, salt, +iter), h);
}
const MOTS = ["marmotte", "chamois", "fondue", "raclette", "poudreuse", "gondole", "sapin", "glacier", "sommet", "chalet", "flocon", "bouquetin", "refuge", "corniche", "vallon", "myrtille", "lanterne", "dameuse", "godille", "slalom"];
export function tempPassword() { const r = rnd(4); return `${MOTS[r[0] % MOTS.length]}-${MOTS[r[1] % MOTS.length]}-${MOTS[r[2] % MOTS.length]}-${10 + (r[3] % 90)}`; }
function checkNewPw(p) { if (typeof p !== "string" || p.length < 10) throw new AuthError(400, "Le mot de passe doit compter au moins 10 caractères"); if (p.length > 200) throw new AuthError(400, "Mot de passe trop long"); }

// ---------- TOTP ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(u) { let bits = 0, v = 0, out = ""; for (const b of u) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; }
function b32dec(s) { let bits = 0, v = 0; const out = []; for (const c of s.replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function totpAt(secret, step) {
  const k = await crypto.subtle.importKey("raw", b32dec(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8); let x = step; for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg)); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, "0");
}
// Renvoie le pas de temps reconnu (±30 s de tolérance), ou null. Un pas déjà utilisé est refusé.
export async function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code || "").replace(/\s/g, ""); if (!/^\d{6}$/.test(c)) return null;
  const t = Math.floor(now / 30000);
  for (const s of [t - 1, t, t + 1]) if (s > (lastStep || 0) && await same(await totpAt(secret, s), c)) return s;
  return null;
}
export { totpAt };

// ---------- base ----------
let ok = false;
export async function ensureAuthSchema(env) {
  if (ok) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, nom TEXT, role TEXT NOT NULL, trips TEXT NOT NULL DEFAULT '[]', pw TEXT NOT NULL, must_change INTEGER DEFAULT 0, totp TEXT, totp_on INTEGER DEFAULT 0, totp_last INTEGER DEFAULT 0, secours TEXT, actif INTEGER DEFAULT 1, failed INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, created_at INTEGER, last_login INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS defis (hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL)`),
  ]);
  // Coordonnées de l'accompagnateur (affichées aux voyageurs, dans le contenu chiffré du voyage)
  for (const col of ["cellulaire", "courriel"]) { try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col} TEXT`).run(); } catch (e) { /* déjà là */ } }
  ok = true;
}
const U = (r) => r && { username: r.username, nom: r.nom || r.username, role: r.role, trips: JSON.parse(r.trips || "[]"), doitChanger: !!r.must_change, deuxEtapes: !!r.totp_on, actif: !!r.actif, derniereConnexion: r.last_login || null, cellulaire: r.cellulaire || "", courriel: r.courriel || "" };
async function getUser(env, username) { return env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(String(username || "").toLowerCase()).first(); }
const normUser = (u) => { const s = String(u || "").trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(s)) throw new AuthError(400, "Nom d'usager : 3 à 40 caractères, lettres, chiffres, point, tiret"); return s; };

async function newSession(env, user) {
  const tok = "s." + b64url(rnd(32)), now = Date.now();
  const life = user.role === "admin" ? 12 * 3600e3 : 30 * 86400e3;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (hash, username, created, expires) VALUES (?, ?, ?, ?)").bind(await sha(tok), user.username, now, now + life),
    env.DB.prepare("UPDATE users SET failed = 0, locked_until = 0, last_login = ? WHERE username = ?").bind(now, user.username),
  ]);
  return { session: tok, expire: now + life, profil: U(user) };
}

// Session de la requête (jeton « s.… »), ou null
export async function sessionUser(env, req) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(s\.[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  await ensureAuthSchema(env);
  const r = await env.DB.prepare("SELECT u.*, s.expires AS s_exp FROM sessions s JOIN users u ON u.username = s.username WHERE s.hash = ?").bind(await sha(m[1])).first();
  if (!r || r.s_exp < Date.now() || !r.actif) return null;
  return r;
}
// Peut modifier ce voyage? (admin avec double authentification, ou accompagnateur à qui le voyage est confié)
export function userCanEdit(r, trip) {
  if (!r || r.must_change) return false;
  if (!r.totp_on) return false; // double authentification obligatoire pour tous les comptes
  if (r.role === "admin") return true;
  return JSON.parse(r.trips || "[]").includes(trip);
}
export async function requireAdminSession(env, req) {
  const r = await sessionUser(env, req);
  if (!r) throw new AuthError(401, "Connectez-vous");
  if (r.role !== "admin") throw new AuthError(403, "Réservé à l'administrateur");
  if (r.must_change) throw new AuthError(428, "Changez d'abord votre mot de passe", { etape: "mdp" });
  if (!r.totp_on) throw new AuthError(428, "Activez d'abord la double authentification", { etape: "2fa" });
  return r;
}

async function fail(env, u) {
  const n = (u.failed || 0) + 1;
  await env.DB.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE username = ?").bind(n, n >= 5 ? Date.now() + 15 * 60e3 : u.locked_until || 0, u.username).run();
}
const lockedMsg = (u) => new AuthError(429, `Trop d'essais : compte bloqué jusqu'à ${new Date(u.locked_until).toISOString().slice(11, 16)} UTC`);

// ---------- routes /api/auth/* ----------
export async function handleAuth(req, env, path, readJson) {
  await ensureAuthSchema(env);
  const body = req.method === "POST" ? await readJson(req) : {};

  // Premier compte administrateur : seulement s'il n'y en a aucun, avec la clé ADMIN_TOKEN
  if (path === "/api/auth/premier-admin" && req.method === "POST") {
    if (!env.ADMIN_TOKEN || !(await same(body.jeton || "", env.ADMIN_TOKEN))) throw new AuthError(403, "Clé de première configuration refusée");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
    if (n.n > 0) throw new AuthError(409, "Un administrateur existe déjà");
    const username = normUser(body.username); checkNewPw(body.password);
    await env.DB.prepare("INSERT INTO users (username, nom, role, trips, pw, must_change, created_at) VALUES (?, ?, 'admin', '[]', ?, 0, ?)").bind(username, String(body.nom || username).slice(0, 60), await hashPw(body.password), Date.now()).run();
    return newSession(env, await getUser(env, username));
  }

  if (path === "/api/auth/connexion" && req.method === "POST") {
    const u = await getUser(env, body.username);
    if (!u || !u.actif) { await checkPw(body.password, ""); throw new AuthError(403, "Nom d'usager ou mot de passe incorrect"); }
    if (u.locked_until > Date.now()) throw lockedMsg(u);
    if (!(await checkPw(body.password, u.pw))) { await fail(env, u); throw new AuthError(403, "Nom d'usager ou mot de passe incorrect"); }
    if (u.totp_on) {
      const defi = "d." + b64url(rnd(24));
      await env.DB.prepare("INSERT INTO defis (hash, username, expires) VALUES (?, ?, ?)").bind(await sha(defi), u.username, Date.now() + 5 * 60e3).run();
      return { deuxEtapes: true, defi };
    }
    return newSession(env, u);
  }

  if (path === "/api/auth/code" && req.method === "POST") {
    const d = await env.DB.prepare("SELECT * FROM defis WHERE hash = ?").bind(await sha(String(body.defi || ""))).first();
    if (!d || d.expires < Date.now()) throw new AuthError(403, "Délai dépassé : reconnectez-vous");
    const u = await getUser(env, d.username);
    if (!u || !u.actif) throw new AuthError(403, "Compte désactivé");
    if (u.locked_until > Date.now()) throw lockedMsg(u);
    const code = String(body.code || "").trim();
    const step = await verifyTotp(u.totp, code, u.totp_last);
    let okCode = step != null;
    if (okCode) await env.DB.prepare("UPDATE users SET totp_last = ? WHERE username = ?").bind(step, u.username).run();
    else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code)) { // code de secours, utilisable une fois
      const list = JSON.parse(u.secours || "[]"), h = await sha(code.toLowerCase().replace("-", ""));
      if (list.includes(h)) { okCode = true; await env.DB.prepare("UPDATE users SET secours = ? WHERE username = ?").bind(JSON.stringify(list.filter((x) => x !== h)), u.username).run(); }
    }
    if (!okCode) { await fail(env, u); throw new AuthError(403, "Code incorrect"); }
    await env.DB.prepare("DELETE FROM defis WHERE hash = ?").bind(d.hash).run();
    return newSession(env, u);
  }

  // Les routes suivantes demandent une session
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(s\.[A-Za-z0-9_-]+)$/);
  const me = await sessionUser(env, req);
  if (!me) throw new AuthError(401, "Session expirée : reconnectez-vous");

  if (path === "/api/auth/moi" && req.method === "GET") return { profil: U(me) };
  if (path === "/api/auth/profil" && req.method === "POST") {
    const t = (v, n) => { const x = String(v ?? "").trim(); if (x.length > n) throw new AuthError(400, "Texte trop long"); return x; };
    const nom = t(body.nom, 80) || me.nom || me.username, cel = t(body.cellulaire, 30), mail = t(body.courriel, 120);
    if (cel && !/^\+?[\d\s().-]{7,}$/.test(cel)) throw new AuthError(400, "Cellulaire : chiffres seulement (ex. 514 555-0100)");
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new AuthError(400, "Courriel invalide");
    await env.DB.prepare("UPDATE users SET nom = ?, cellulaire = ?, courriel = ? WHERE username = ?").bind(nom, cel, mail, me.username).run();
    return { ok: true, profil: U({ ...me, nom, cellulaire: cel, courriel: mail }) };
  }
  if (path === "/api/auth/deconnexion" && req.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE hash = ?").bind(await sha(m[1])).run();
    return { ok: true };
  }
  if (path === "/api/auth/mdp" && req.method === "POST") {
    if (!(await checkPw(body.ancien, me.pw))) { await fail(env, me); throw new AuthError(403, "Mot de passe actuel incorrect"); }
    checkNewPw(body.nouveau);
    if (body.nouveau === body.ancien) throw new AuthError(400, "Choisissez un nouveau mot de passe");
    const h = await sha(m[1]);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw = ?, must_change = 0 WHERE username = ?").bind(await hashPw(body.nouveau), me.username),
      env.DB.prepare("DELETE FROM sessions WHERE username = ? AND hash <> ?").bind(me.username, h),
    ]);
    return { ok: true, profil: U({ ...me, must_change: 0 }) };
  }
  if (path === "/api/auth/2fa/debut" && req.method === "POST") {
    if (me.totp_on) throw new AuthError(409, "La double authentification est déjà active");
    const secret = b32enc(rnd(20));
    await env.DB.prepare("UPDATE users SET totp = ?, totp_last = 0 WHERE username = ?").bind(secret, me.username).run();
    const label = encodeURIComponent(`monaccompagnateur:${me.username}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=monaccompagnateur&algorithm=SHA1&digits=6&period=30` };
  }
  if (path === "/api/auth/2fa/activer" && req.method === "POST") {
    if (me.totp_on) throw new AuthError(409, "Déjà active");
    if (!me.totp) throw new AuthError(400, "Commencez par afficher le code QR");
    const step = await verifyTotp(me.totp, body.code, 0);
    if (step == null) throw new AuthError(403, "Code incorrect : vérifiez l'heure du téléphone et réessayez");
    const codes = Array.from({ length: 8 }, () => { const s = b64url(rnd(6)).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 8); return s.slice(0, 4) + "-" + s.slice(4); });
    const hashes = await Promise.all(codes.map((c) => sha(c.replace("-", ""))));
    await env.DB.prepare("UPDATE users SET totp_on = 1, totp_last = ?, secours = ? WHERE username = ?").bind(step, JSON.stringify(hashes), me.username).run();
    return { ok: true, codesSecours: codes, profil: U({ ...me, totp_on: 1 }) };
  }
  if (path === "/api/auth/2fa/retirer" && req.method === "POST") {
    // Obligatoire pour tous : seul l'administrateur peut la réinitialiser (téléphone perdu), et elle est redemandée à la connexion suivante
    throw new AuthError(403, "La double authentification est obligatoire pour tous les comptes");
  }
  throw new AuthError(404, "Introuvable");
}

// ---------- gestion des comptes (administrateur) ----------
export async function handleComptes(env, path, body, method, me) {
  await ensureAuthSchema(env);
  if (method === "GET" && path === "/api/admin/comptes") {
    const r = await env.DB.prepare("SELECT * FROM users ORDER BY role, username").all();
    return { comptes: (r.results || []).map(U) };
  }
  const trips = (t) => (Array.isArray(t) ? t : []).filter((x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(x));
  if (method === "POST" && path === "/api/admin/comptes") {
    const username = normUser(body.username), role = body.role === "admin" ? "admin" : "accompagnateur";
    if (await getUser(env, username)) throw new AuthError(409, "Ce nom d'usager existe déjà");
    const pw = tempPassword();
    await env.DB.prepare("INSERT INTO users (username, nom, role, trips, pw, must_change, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(username, String(body.nom || username).slice(0, 60), role, JSON.stringify(trips(body.trips)), await hashPw(pw), Date.now()).run();
    return { ok: true, username, motDePasse: pw };
  }
  const u = await getUser(env, body.username);
  if (!u) throw new AuthError(404, "Compte introuvable");
  const self = me && u.username === me.username;
  if (self && (path.endsWith("/supprimer") || path.endsWith("/2fa") || path.endsWith("/mdp") || (path.endsWith("/modifier") && body.actif === false)))
    throw new AuthError(400, "Pour votre propre compte, utilisez « Mon compte »");
  if (method === "POST" && path === "/api/admin/comptes/modifier") {
    const nom = body.nom != null ? String(body.nom).slice(0, 60) : u.nom;
    const t = body.trips != null ? JSON.stringify(trips(body.trips)) : u.trips;
    const actif = body.actif != null ? (body.actif ? 1 : 0) : u.actif;
    await env.DB.prepare("UPDATE users SET nom = ?, trips = ?, actif = ? WHERE username = ?").bind(nom, t, actif, u.username).run();
    if (!actif) await env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(u.username).run();
    return { ok: true };
  }
  if (method === "POST" && path === "/api/admin/comptes/mdp") {
    const pw = tempPassword();
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw = ?, must_change = 1, failed = 0, locked_until = 0 WHERE username = ?").bind(await hashPw(pw), u.username),
      env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(u.username),
    ]);
    return { ok: true, username: u.username, motDePasse: pw };
  }
  if (method === "POST" && path === "/api/admin/comptes/2fa") {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET totp = NULL, totp_on = 0, secours = NULL, failed = 0, locked_until = 0 WHERE username = ?").bind(u.username),
      env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(u.username),
    ]);
    return { ok: true };
  }
  if (method === "POST" && path === "/api/admin/comptes/supprimer") {
    await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(u.username), env.DB.prepare("DELETE FROM users WHERE username = ?").bind(u.username)]);
    return { ok: true };
  }
  return null;
}

export async function purgeSessions(env) {
  await ensureAuthSchema(env);
  const now = Date.now();
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now), env.DB.prepare("DELETE FROM defis WHERE expires < ?").bind(now)]);
}

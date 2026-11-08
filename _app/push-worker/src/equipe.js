// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
// Mon groupe partagé entre les accompagnateurs d'un voyage, chiffré de bout en bout.
//
// - La liste et les présences sont chiffrées sur les téléphones avec une clé d'équipe aléatoire (AES-256-GCM).
// - Chaque téléphone d'accompagnateur a sa paire de clés ECDH P-256 (la partie privée ne le quitte jamais).
// - La clé d'équipe voyage d'un téléphone à l'autre dans une enveloppe chiffrée pour le téléphone qui la reçoit;
//   un accompagnateur la donne après avoir comparé un code court calculé à partir de la clé publique.
// - Ce Worker ne garde que des enveloppes et un bloc chiffré : il ne peut lire ni la clé ni la liste.
// - Seuls les comptes accompagnateurs assignés au voyage (double authentification) reçoivent quoi que ce soit.

const MAX_BLOB = 1_500_000;
let schemaOk = false;
async function schema(env) {
  if (schemaOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS equipe_appareils (id TEXT PRIMARY KEY, username TEXT NOT NULL, pub TEXT NOT NULL, nom TEXT, created INTEGER NOT NULL, vu INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS equipe_cles (trip TEXT NOT NULL, appareil TEXT NOT NULL, kid TEXT NOT NULL, env TEXT NOT NULL, par TEXT, created INTEGER NOT NULL, PRIMARY KEY (trip, appareil))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS groupes (trip TEXT PRIMARY KEY, blob TEXT NOT NULL, version INTEGER NOT NULL, kid TEXT NOT NULL, updated INTEGER NOT NULL, par TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS equipe_attente (trip TEXT NOT NULL, appareil TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (trip, appareil))`),
  ]);
  for (const q of ["ALTER TABLE groupes ADD COLUMN epub TEXT", "ALTER TABLE groupes ADD COLUMN ekid TEXT"]) { try { await env.DB.prepare(q).run(); } catch (e) { /* déjà là */ } }
  schemaOk = true;
}
// Clé publique d'équipe (pour chiffrer le nom des demandes d'accès), ou null
export async function clePubliqueEquipe(env, trip) {
  await schema(env);
  const g = await env.DB.prepare("SELECT epub, ekid FROM groupes WHERE trip = ?").bind(trip).first();
  return g && g.epub ? { ekid: g.ekid, pub: JSON.parse(g.epub) } : null;
}

async function empreinte(x, y) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${x}.${y}`));
  return [...new Uint8Array(h)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const B64U = /^[A-Za-z0-9_-]+$/;
function validEnv(e) {
  return e && typeof e === "object" && e.epk && B64U.test(e.epk.x || "") && B64U.test(e.epk.y || "") && B64U.test(e.iv || "") && B64U.test(e.data || "") && JSON.stringify(e).length < 2000;
}
const validKid = (k) => typeof k === "string" && /^[0-9a-f]{16,64}$/.test(k);

export async function supprimerEquipe(env, trip) {
  try {
    await schema(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM groupes WHERE trip = ?").bind(trip),
      env.DB.prepare("DELETE FROM equipe_cles WHERE trip = ?").bind(trip),
      env.DB.prepare("DELETE FROM equipe_attente WHERE trip = ?").bind(trip),
    ]);
  } catch (e) { /* tables absentes */ }
}

// d = { HttpError, sessionUser, requireTrip, readJson, notifierComptes }
export async function handleEquipe(req, env, path, url, d) {
  await schema(env);
  const u = await d.sessionUser(env, req);
  if (!u) throw new d.HttpError(401, "Session expirée : reconnectez-vous");
  if (u.must_change) throw new d.HttpError(428, "Changez d'abord votre mot de passe temporaire");
  if (!u.totp_on) throw new d.HttpError(428, "Activez d'abord la double authentification");
  const now = Date.now();

  // Enregistrer la clé publique de ce téléphone (une fois par compte)
  if (req.method === "POST" && path === "/api/equipe/appareil") {
    const b = await d.readJson(req);
    const k = b.pub || {};
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(k.x || "") || !/^[A-Za-z0-9_-]{40,50}$/.test(k.y || "")) throw new d.HttpError(400, "Clé de l'appareil invalide");
    const id = await empreinte(k.x, k.y);
    const nom = String(b.nom || "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
    const ex = await env.DB.prepare("SELECT username FROM equipe_appareils WHERE id = ?").bind(id).first();
    if (ex && ex.username !== u.username) throw new d.HttpError(409, "Ce téléphone est déjà lié à un autre compte");
    if (!ex) {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM equipe_appareils WHERE username = ?").bind(u.username).first();
      if (n.n >= 10) throw new d.HttpError(429, "Trop de téléphones pour ce compte");
    }
    await env.DB.prepare("INSERT INTO equipe_appareils (id, username, pub, nom, created, vu) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET nom = excluded.nom, vu = excluded.vu")
      .bind(id, u.username, JSON.stringify({ x: k.x, y: k.y }), nom, now, now).run();
    return { ok: true, id };
  }

  // Tout le reste concerne un voyage dont on est accompagnateur
  const trip = req.method === "GET" ? url.searchParams.get("trip") || "" : null;
  const b = req.method === "GET" ? null : await d.readJson(req, 2_100_000);
  const t = await d.requireTrip(env, trip ?? b.trip);
  const id = trip ?? b.trip;
  if (t.supprime || t.clos === 2) throw new d.HttpError(404, "Voyage inconnu");
  const us = (await env.DB.prepare("SELECT username, nom, trips, actif FROM users").all()).results || [];
  const membres = us.filter((x) => x.actif && JSON.parse(x.trips || "[]").includes(id));
  if (!membres.some((x) => x.username === u.username)) throw new d.HttpError(403, "Réservé aux accompagnateurs de ce voyage");
  const noms = new Set(membres.map((x) => x.username));
  const apps = membres.length ? ((await env.DB.prepare(`SELECT id, username, pub, nom FROM equipe_appareils WHERE username IN (${membres.map(() => "?").join(",")})`).bind(...membres.map((x) => x.username)).all()).results || []) : [];
  const appIds = new Set(apps.map((a) => a.id));
  const g = await env.DB.prepare("SELECT version, kid, updated, par, ekid FROM groupes WHERE trip = ?").bind(id).first();
  const monApp = (aid) => { const a = apps.find((x) => x.id === aid && x.username === u.username); if (!a) throw new d.HttpError(400, "Téléphone non enregistré pour ce compte"); return a; };

  if (req.method === "GET" && path === "/api/equipe") {
    const aid = url.searchParams.get("appareil") || "";
    const cles = (await env.DB.prepare("SELECT appareil, kid, env FROM equipe_cles WHERE trip = ?").bind(id).all()).results || [];
    const mine = aid ? cles.find((c) => c.appareil === aid) : null;
    // Une enveloppe de la clé actuelle chez un téléphone qui n'est plus dans l'équipe : il faut changer de clé
    const rotation = !!g && cles.some((c) => c.kid === g.kid && !appIds.has(c.appareil));
    const aCle = new Set(cles.filter((c) => g && c.kid === g.kid).map((c) => c.appareil));
    // Téléphone en attente de la clé : on avertit les autres accompagnateurs (au plus toutes les 6 heures)
    if (g && aid && appIds.has(aid) && !aCle.has(aid)) {
      const at = await env.DB.prepare("SELECT at FROM equipe_attente WHERE trip = ? AND appareil = ?").bind(id, aid).first();
      if (!at || at.at < now - 6 * 3600e3) {
        await env.DB.prepare("INSERT INTO equipe_attente (trip, appareil, at) VALUES (?, ?, ?) ON CONFLICT (trip, appareil) DO UPDATE SET at = excluded.at").bind(id, aid, now).run();
        const autres = membres.filter((x) => x.username !== u.username || apps.filter((a) => a.username === u.username && aCle.has(a.id)).length).map((x) => x.username);
        try { await d.notifierComptes(env, autres, { title: t.title || "Mon groupe", body: `${u.nom || u.username} attend la clé d'équipe de Mon groupe.`, nom: u.nom || u.username, url: `/app/groupe.html?v=${encodeURIComponent(id)}`, tag: `cle:${id}`, kind: "cle", id }); } catch (e) { /* rien */ }
      }
    }
    return {
      kid: g ? g.kid : null, ekid: g ? g.ekid || null : null, version: g ? g.version : 0, maj: g ? g.updated : null, majPar: g ? g.par : null,
      cle: mine && g && mine.kid === g.kid ? JSON.parse(mine.env) : null,
      rotation,
      membres: membres.map((x) => ({ username: x.username, nom: x.nom || x.username })),
      appareils: apps.map((a) => ({ id: a.id, username: a.username, nom: a.nom, pub: JSON.parse(a.pub), cle: aCle.has(a.id) })),
    };
  }

  // Donner la clé actuelle à des téléphones de l'équipe (enveloppes chiffrées pour chacun)
  if (req.method === "POST" && path === "/api/equipe/cles") {
    if (!g || b.kid !== g.kid) throw new d.HttpError(409, "La clé d'équipe a changé : rouvrez Mon groupe");
    const list = Array.isArray(b.cles) ? b.cles.slice(0, 50) : [];
    const recus = new Set();
    for (const c of list) {
      if (!appIds.has(c.appareil) || !validEnv(c.env)) throw new d.HttpError(400, "Enveloppe invalide");
      await env.DB.prepare("INSERT INTO equipe_cles (trip, appareil, kid, env, par, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (trip, appareil) DO UPDATE SET kid = excluded.kid, env = excluded.env, par = excluded.par, created = excluded.created")
        .bind(id, c.appareil, g.kid, JSON.stringify(c.env), u.username, now).run();
      await env.DB.prepare("DELETE FROM equipe_attente WHERE trip = ? AND appareil = ?").bind(id, c.appareil).run();
      recus.add(apps.find((a) => a.id === c.appareil).username);
    }
    recus.delete(u.username);
    try { if (recus.size) await d.notifierComptes(env, [...recus], { title: t.title || "Mon groupe", body: "Clé d'équipe reçue : touchez pour ouvrir Mon groupe.", url: `/app/groupe.html?v=${encodeURIComponent(id)}`, tag: `cle:${id}`, kind: "cle", id }); } catch (e) { /* rien */ }
    return { ok: true, donnees: list.length };
  }

  // Bloc chiffré de la liste et des présences
  if (req.method === "GET" && path === "/api/groupe") {
    if (!g) return { version: 0, kid: null, blob: null };
    const depuis = Number(url.searchParams.get("depuis") || -1);
    if (depuis === g.version) return { version: g.version, kid: g.kid, inchange: true };
    const r = await env.DB.prepare("SELECT blob FROM groupes WHERE trip = ?").bind(id).first();
    return { version: g.version, kid: g.kid, blob: JSON.parse(r.blob), maj: g.updated, majPar: g.par };
  }
  if (req.method === "PUT" && path === "/api/groupe") {
    const base = Number(b.base || 0);
    const blob = b.blob;
    if (!blob || typeof blob !== "object" || !B64U.test(blob.iv || "") || !B64U.test(blob.data || "")) throw new d.HttpError(400, "Bloc chiffré invalide");
    const s = JSON.stringify({ iv: blob.iv, data: blob.data, z: blob.z ? 1 : 0 });
    if (s.length > MAX_BLOB) throw new d.HttpError(413, "Liste trop grosse");
    if (!validKid(b.kid)) throw new d.HttpError(400, "Clé d'équipe invalide");
    const nouvelle = !g || b.kid !== g.kid;
    let cles = [], epub = null, ekid = null;
    if (nouvelle) {
      // Partie publique de la clé d'équipe : les voyageurs y chiffrent leur nom
      const e = b.epub || {};
      if (!/^[A-Za-z0-9_-]{40,50}$/.test(e.x || "") || !/^[A-Za-z0-9_-]{40,50}$/.test(e.y || "")) throw new d.HttpError(400, "Clé publique d'équipe manquante");
      epub = JSON.stringify({ x: e.x, y: e.y }); ekid = await empreinte(e.x, e.y);
      // Nouvelle clé (création ou changement) : les enveloppes de tous les téléphones qui la reçoivent, dont le sien
      cles = Array.isArray(b.cles) ? b.cles.slice(0, 50) : [];
      for (const c of cles) if (!appIds.has(c.appareil) || !validEnv(c.env)) throw new d.HttpError(400, "Enveloppe invalide");
      if (!cles.some((c) => { const a = apps.find((x) => x.id === c.appareil); return a && a.username === u.username; })) throw new d.HttpError(400, "La nouvelle clé doit inclure votre téléphone");
    }
    const ver = (g ? g.version : 0);
    if (base !== ver) throw new d.HttpError(409, "La liste a changé entre-temps", { version: ver });
    const r = g
      ? (nouvelle
        ? await env.DB.prepare("UPDATE groupes SET blob = ?, version = version + 1, kid = ?, epub = ?, ekid = ?, updated = ?, par = ? WHERE trip = ? AND version = ?").bind(s, b.kid, epub, ekid, now, u.username, id, base).run()
        : await env.DB.prepare("UPDATE groupes SET blob = ?, version = version + 1, updated = ?, par = ? WHERE trip = ? AND version = ? AND kid = ?").bind(s, now, u.username, id, base, b.kid).run())
      : await env.DB.prepare("INSERT INTO groupes (trip, blob, version, kid, epub, ekid, updated, par) VALUES (?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT (trip) DO NOTHING").bind(id, s, b.kid, epub, ekid, now, u.username).run();
    if (!r.meta || r.meta.changes !== 1) throw new d.HttpError(409, "La liste a changé entre-temps", { version: ver });
    if (nouvelle) {
      const st = [env.DB.prepare("DELETE FROM equipe_cles WHERE trip = ?").bind(id), env.DB.prepare("DELETE FROM equipe_attente WHERE trip = ?").bind(id)];
      for (const c of cles) st.push(env.DB.prepare("INSERT INTO equipe_cles (trip, appareil, kid, env, par, created) VALUES (?, ?, ?, ?, ?, ?)").bind(id, c.appareil, b.kid, JSON.stringify(c.env), u.username, now));
      await env.DB.batch(st);
    }
    return { ok: true, version: ver + 1, kid: b.kid, ekid: nouvelle ? ekid : g.ekid };
  }
  throw new d.HttpError(404, "Introuvable");
}

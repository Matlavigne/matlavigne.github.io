// Worker des apps de voyage monaccompagnateur.ca : alertes et publication depuis l'éditeur.
//
// Publication : chaque accompagnateur a une clé d'éditeur propre à SON voyage (EDITOR_TOKENS).
// Le Worker garde le seul jeton GitHub (secret GITHUB_TOKEN) et n'écrit que <voyage>/voyage.json.
// Il reçoit le contenu déjà chiffré par l'éditeur : il ne voit pas la phrase du voyage.
//
// Le Worker ne voit jamais le contenu du voyage : il garde les abonnements des téléphones
// et un calendrier (identifiant + heure) des annonces, et envoie des textes génériques.
// L'app déchiffre l'annonce elle-même quand le voyageur touche la notification.

import { sendPush, b64urlDecode } from "./webpush.js";
import { handleAuth, handleComptes, sessionUser, userCanEdit, requireAdminSession, purgeSessions, ensureAuthSchema } from "./auth.js";

const KINDS = {
  annonce: "Nouvelle annonce du groupe. Touchez pour la lire.",
  rappel: "Rappel : un rendez-vous approche. Touchez pour les détails.",
  test: "Les alertes du voyage fonctionnent sur ce téléphone.",
};

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^web\.push\.apple\.com$/,
  /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const MAX_BODY_BYTES = 8192;

// ---------- configuration ----------

function tomlTrips(env) {
  const t = env.TRIPS;
  if (!t) return {};
  return typeof t === "string" ? JSON.parse(t) : t;
}

// Tables créées au besoin (voyages ajoutés par l'administration, clés d'éditeur)
let schemaOk = false;
async function ensureSchema(env) {
  if (schemaOk) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, station TEXT, titre TEXT, url TEXT, fin TEXT, max_subs INTEGER, created_at INTEGER, clos INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS editor_keys (trip TEXT PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`),
  ]);
  schemaOk = true;
}

// Voyages connus : ceux de wrangler.toml, plus ceux créés depuis l'administration (base D1)
async function trips(env) {
  const out = { ...tomlTrips(env) };
  try {
    await ensureSchema(env);
    const r = await env.DB.prepare("SELECT id, titre, url, fin, max_subs, clos FROM trips").all();
    for (const t of r.results || []) out[t.id] = { ...(out[t.id] || {}), title: t.titre, url: t.url || `/${t.id}/`, end: t.fin, maxSubs: t.max_subs || 300, clos: !!t.clos, supprime: t.clos === 2 };
  } catch (e) { console.error("trips D1", e); }
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function cfg(env) {
  return {
    maxPerRun: num(env.MAX_PUSH_PER_RUN, 40),
    publishDelay: num(env.PUBLISH_DELAY_SECONDS, 180),
    maxPast: num(env.MAX_PAST_SECONDS, 900),
    ttl: num(env.PUSH_TTL_SECONDS, 43200),
    purgeAfterDays: num(env.PURGE_AFTER_DAYS, 7),
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_JWK, subject: env.VAPID_SUBJECT },
  };
}

// ---------- utilitaires HTTP ----------

function allowedOrigin(env, origin) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function corsHeaders(env, req) {
  const origin = allowedOrigin(env, req.headers.get("Origin"));
  const h = { Vary: "Origin" };
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(env, req, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(env, req) },
  });
}

async function readJson(req, max = MAX_BODY_BYTES) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > max) throw new HttpError(413, "Requête trop grosse");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "Requête trop grosse");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "JSON invalide"); }
}

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

// ---------- publication sur GitHub (un seul fichier par voyage) ----------

const MAX_VOYAGE_BYTES = 600 * 1024;

function github(env) {
  const repo = String(env.GITHUB_REPO || "");
  if (!env.GITHUB_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new HttpError(503, "Publication non configurée sur le serveur");
  return {
    repo,
    api: String(env.GITHUB_API || "https://api.github.com").replace(/\/+$/, ""),
    branch: env.GITHUB_BRANCH || "main",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "monaccompagnateur-editeur",
    },
  };
}

// Le chemin est construit ici, jamais reçu du client : <voyage validé>/voyage.json
const voyagePath = (trip) => `${trip}/voyage.json`;

function utf8ToB64(text) {
  const b = new TextEncoder().encode(text);
  let x = "";
  for (let i = 0; i < b.length; i += 0x8000) x += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(x);
}
function b64ToUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, "")), (c) => c.charCodeAt(0)));
}

async function ghGetVoyage(env, trip) {
  const g = github(env);
  const r = await fetch(`${g.api}/repos/${g.repo}/contents/${voyagePath(trip)}?ref=${encodeURIComponent(g.branch)}`, { headers: g.headers });
  if (r.status === 404) return { sha: null, content: null };
  if (!r.ok) throw new HttpError(502, `GitHub a répondu ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, content: b64ToUtf8(j.content || "") };
}

// Forme minimale d'un voyage.json : chiffré ({ chiffre: { iv, data, salt } }) ou en clair ({ programme: [] })
function checkVoyage(text) {
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, "Le contenu n'est pas du JSON valide"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Le contenu doit être un objet");
  if (v.chiffre != null) {
    const c = v.chiffre;
    if (typeof c !== "object" || !["iv", "data", "salt"].every((k) => typeof c[k] === "string" && c[k].length)) throw new HttpError(400, "Bloc chiffré invalide");
    return { v, chiffre: true };
  }
  if (!Array.isArray(v.programme)) throw new HttpError(400, "Le contenu doit contenir un programme");
  return { v, chiffre: false };
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const b64url = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hashKey(k) { return b64url(await sha256("cle-editeur:" + k)); }
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(24)));

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Jeton de l'éditeur : EDITOR_TOKENS = {"<voyage>": "<jeton>", "*": "<jeton admin facultatif>"}
async function requireEditor(env, req, trip) {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) throw new HttpError(401, "Jeton manquant");
  // Compte (nom d'usager + mot de passe) : session « s.… »
  if (m[1].startsWith("s.")) {
    const u = await sessionUser(env, req);
    if (!u) throw new HttpError(401, "Session expirée : reconnectez-vous");
    if (userCanEdit(u, trip)) return;
    if (!u.totp_on) throw new HttpError(428, "Activez d'abord la double authentification");
    throw new HttpError(403, "Ce compte n'a pas accès à ce voyage");
  }
  let tokens = {};
  try { tokens = JSON.parse(env.EDITOR_TOKENS || "{}"); } catch { tokens = {}; }
  const candidates = [tokens[trip], tokens["*"]].filter(Boolean);
  for (const t of candidates) if (await safeEqual(m[1], t)) return;
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT hash FROM editor_keys WHERE trip = ?").bind(trip).first();
    if (row && await safeEqual(await hashKey(m[1]), row.hash)) return;
  } catch (e) { console.error("editor_keys", e); }
  throw new HttpError(403, "Jeton refusé");
}

async function requireTrip(env, trip) {
  if (typeof trip !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(trip)) throw new HttpError(400, "Voyage invalide");
  const t = (await trips(env))[trip];
  if (!t) throw new HttpError(404, "Voyage inconnu");
  return t;
}

function validEndpoint(env, endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (env.ALLOW_ANY_PUSH_HOST === "1") return u.protocol === "https:" || u.protocol === "http:";
  return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

function validKey(b64, len, first) {
  try {
    const k = b64urlDecode(b64);
    return k.length === len && (first === undefined || k[0] === first);
  } catch { return false; }
}


// ---------- administration : voyages créés sans coder ----------
// Clé d'administration : secret ADMIN_TOKEN. Le Worker écrit la fiche du voyage, son contenu chiffré
// (préparé dans le navigateur) et la photo dans le dépôt, en un seul commit; un robot GitHub (Actions)
// génère ensuite l'app, l'icône et la photo d'en-tête.

const MAX_ADMIN_BYTES = 8 * 1024 * 1024;

// Administrateur : session d'un compte « admin », mot de passe changé et double authentification active
async function requireAdmin(env, req) { return requireAdminSession(env, req); }

async function ghJson(env, path, opt = {}) {
  const g = github(env);
  const r = await fetch(`${g.api}/repos/${g.repo}${path}`, { ...opt, headers: { ...g.headers, ...(opt.body ? { "Content-Type": "application/json" } : {}), ...(opt.headers || {}) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, `GitHub a répondu ${r.status} (${path.split("?")[0]})`);
  return r.json();
}
async function ghFile(env, path) {
  const g = github(env);
  const j = await ghJson(env, `/contents/${path}?ref=${encodeURIComponent(g.branch)}`);
  return j && !Array.isArray(j) ? { sha: j.sha, text: b64ToUtf8(j.content || "") } : null;
}
async function ghDir(env, path) {
  const g = github(env);
  const j = await ghJson(env, `/contents/${path}?ref=${encodeURIComponent(g.branch)}`);
  return Array.isArray(j) ? j : [];
}

// Un seul commit pour plusieurs fichiers : [{ path, text } | { path, b64 } | { path, del: true }]
// files peut aussi être une fonction (liste des chemins du dépôt) => fichiers, pour une suppression.
async function commitFiles(env, files, message) {
  const g = github(env);
  const ref = await ghJson(env, `/git/ref/heads/${encodeURIComponent(g.branch)}`);
  const head = ref.object.sha;
  const commit = await ghJson(env, `/git/commits/${head}`);
  if (typeof files === "function") {
    const all = await ghJson(env, `/git/trees/${commit.tree.sha}?recursive=1`);
    if (!all || all.truncated) throw new HttpError(502, "Liste des fichiers du dépôt incomplète");
    files = await files(all.tree.filter((e) => e.type === "blob").map((e) => e.path));
  }
  const tree = [];
  for (const f of files) {
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(f.path) || f.path.includes("..")) throw new HttpError(400, `Chemin refusé : ${f.path}`);
    if (f.del) { tree.push({ path: f.path, mode: "100644", type: "blob", sha: null }); continue; }
    const blob = await ghJson(env, "/git/blobs", { method: "POST", body: JSON.stringify(f.b64 != null ? { content: f.b64, encoding: "base64" } : { content: f.text, encoding: "utf-8" }) });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const t = await ghJson(env, "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
  const c = await ghJson(env, "/git/commits", { method: "POST", body: JSON.stringify({ message, tree: t.sha, parents: [head], author: { name: "Administration monaccompagnateur", email: "admin@monaccompagnateur.ca" } }) });
  const up = await fetch(`${g.api}/repos/${g.repo}/git/refs/heads/${encodeURIComponent(g.branch)}`, { method: "PATCH", headers: { ...g.headers, "Content-Type": "application/json" }, body: JSON.stringify({ sha: c.sha }) });
  if (up.status === 422 || up.status === 409) throw new HttpError(409, "Le dépôt a changé pendant l'enregistrement : réessayez");
  if (!up.ok) throw new HttpError(502, `GitHub a refusé l'enregistrement (${up.status})`);
  return c.sha;
}

const AFFICHE_DEFAUT = {
  soute: [{ t: "Sac à skis", d: "Skis et bâtons" }, { t: "Sac à bottes", d: "Bottes de ski et casque de ski" }, { t: "1 bagage de 23 kg", d: "Vêtements et effets personnels" }],
  noteSoute: "Le sac à skis et le sac à bottes sont en plus du bagage de 23 kg. Ensemble, ski et bottes, ils ne doivent pas dépasser 23 kg.",
  cabine: [{ t: "1 bagage à main", d: "Format cabine, dans le compartiment au-dessus du siège" }, { t: "1 sac personnel", d: "Sac à dos ou sac à main, sous le siège devant vous" }],
  important: "Très important : les batteries externes et les batteries au lithium voyagent avec vous en cabine, jamais en soute.",
  conseils: ["Gardez dans votre bagage à main : passeport, médicaments, chargeur et vos batteries.", "Mettez une étiquette à votre nom sur chaque sac."],
};
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dateOk = (d) => /^\d{4}-\d\d-\d\d$/.test(d || "") && !Number.isNaN(Date.parse(d));
const str = (v, max) => { if (typeof v !== "string") return ""; const t = v.trim(); if (t.length > max) throw new HttpError(400, "Texte trop long"); return t; };

async function adminEtat(env) {
  const [stFiles, vFiles, all] = await Promise.all([ghDir(env, "_app/stations"), ghDir(env, "_app/voyages"), trips(env)]);
  const stations = [];
  for (const f of stFiles.filter((f) => f.name.endsWith(".json"))) {
    const j = await ghFile(env, `_app/stations/${f.name}`);
    try { const s = JSON.parse(j.text); stations.push({ id: s.id, nom: s.nom, lieu: s.lieu, pays: s.pays, fuseau: s.fuseau }); } catch {}
  }
  await ensureSchema(env);
  const subs = await env.DB.prepare("SELECT trip, COUNT(*) AS n FROM subscriptions GROUP BY trip").all();
  const nSubs = Object.fromEntries((subs.results || []).map((r) => [r.trip, r.n]));
  const keys = await env.DB.prepare("SELECT trip, created_at FROM editor_keys").all();
  const kSet = Object.fromEntries((keys.results || []).map((r) => [r.trip, r.created_at]));
  let toml = {}; try { toml = JSON.parse(env.EDITOR_TOKENS || "{}"); } catch {}
  await ensureAuthSchema(env);
  const us = (await env.DB.prepare("SELECT username, nom, trips, role, actif FROM users").all()).results || [];
  const acces = (id) => us.filter((u) => u.actif && u.role !== "admin" && JSON.parse(u.trips || "[]").includes(id)).map((u) => u.nom || u.username);
  const voyages = [];
  for (const f of vFiles.filter((f) => f.name.endsWith(".json"))) {
    const j = await ghFile(env, `_app/voyages/${f.name}`);
    let v; try { v = JSON.parse(j.text); } catch { continue; }
    const t = all[v.id] || {};
    if (t.supprime) continue; // supprimé : GitHub peut encore lister la fiche quelques instants
    voyages.push({ id: v.id, station: v.station, titre: v.titre, dates: v.dates, appCourt: v.appCourt, fin: t.end || null, alertes: !!all[v.id], abonnes: nSubs[v.id] || 0, cle: kSet[v.id] ? "admin" : toml[v.id] ? "terminal" : null, acces: acces(v.id), clos: !!t.clos });
  }
  voyages.sort((a, b) => String(b.fin || "").localeCompare(String(a.fin || "")));
  return { stations, voyages };
}

async function adminCreer(env, b) {
  const id = str(b.id, 63).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) throw new HttpError(400, "Adresse du voyage : lettres minuscules, chiffres et tirets seulement");
  if (/^(admin|api|_app|assets|confidentialite)/.test(id)) throw new HttpError(400, "Cette adresse est réservée");
  const station = str(b.station, 40);
  const titre = str(b.titre, 80), dates = str(b.dates, 60), appCourt = str(b.appCourt, 24);
  if (!titre || !dates || !appCourt) throw new HttpError(400, "Titre, dates et nom court de l'app requis");
  if (!dateOk(b.debut) || !dateOk(b.fin) || b.fin < b.debut) throw new HttpError(400, "Premier et dernier jour invalides");
  const [stFile, exists, dirExists] = await Promise.all([ghFile(env, `_app/stations/${station}.json`), ghFile(env, `_app/voyages/${id}.json`), ghDir(env, id)]);
  if (!stFile) throw new HttpError(400, "Station inconnue");
  if (exists || dirExists.length) throw new HttpError(409, "Un voyage existe déjà à cette adresse");
  const S = JSON.parse(stFile.text);
  if (typeof b.contenu !== "string") throw new HttpError(400, "Contenu du voyage manquant");
  const contenu = checkVoyage(b.contenu);
  if (!contenu.chiffre) throw new HttpError(400, "Le contenu du nouveau voyage doit être protégé par une phrase");

  const credit = b.photo ? (str(b.credit, 300) ? esc(str(b.credit, 300)) : "Photo : monaccompagnateur.ca") : "Illustration : monaccompagnateur.ca";
  const config = {
    id, station, titre, dates, appCourt,
    nomApp: str(b.nomApp, 60) || `${titre} ${b.debut.slice(0, 4)}`,
    pied: appCourt,
    description: `L’app du voyage de ski en groupe à ${S.nom} : programme, annonces, état des pistes, carte et infos pratiques.`,
    ogDescription: `Voyage de ski en groupe à ${S.nom} (${dates}) : programme, annonces, météo et carte GPS.`,
    credit,
    cache: `gendronski-${id}`,
    affiche: { titre, sousDates: dates, bagages: AFFICHE_DEFAUT },
  };
  const files = [
    { path: `_app/voyages/${id}.json`, text: JSON.stringify(config, null, 2) + "\n" },
    { path: `${id}/voyage.json`, text: JSON.stringify(contenu.v, null, 1) + "\n" },
  ];
  if (b.photo) {
    const m = String(b.photo).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, "Photo : JPEG, PNG ou WebP seulement");
    files.push({ path: `_app/voyages/photos/${id}.${m[1] === "jpeg" ? "jpg" : m[1]}`, b64: m[2] });
  }
  if (b.accueil) {
    const site = await ghFile(env, "voyages.json");
    if (site) {
      const d = JSON.parse(site.text);
      d.voyages = Array.isArray(d.voyages) ? d.voyages : [];
      d.voyages.unshift({ titre: appCourt, lieu: S.lieu.replace(" · ", ", "), debut: b.debut, fin: b.fin, dates, photo: `/${id}/hero.webp`, app: `https://monaccompagnateur.ca/${id}/`, souvenir: "" });
      files.push({ path: "voyages.json", text: JSON.stringify(d, null, 2) + "\n" });
    }
  }
  const commit = await commitFiles(env, files, `Nouveau voyage : ${titre} (${dates})`);
  const cle = newKey(), now = Date.now();
  await ensureSchema(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO trips (id, station, titre, url, fin, max_subs, created_at, clos) VALUES (?, ?, ?, ?, ?, 300, ?, 0) ON CONFLICT (id) DO UPDATE SET station = excluded.station, titre = excluded.titre, url = excluded.url, fin = excluded.fin, created_at = excluded.created_at, clos = 0").bind(id, station, appCourt, `/${id}/`, b.fin, now),
    env.DB.prepare("INSERT INTO editor_keys (trip, hash, created_at) VALUES (?, ?, ?) ON CONFLICT (trip) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at").bind(id, await hashKey(cle), now),
  ]);
  let compte = null;
  if (b.compte) {
    await ensureAuthSchema(env);
    const u = await env.DB.prepare("SELECT username, trips FROM users WHERE username = ?").bind(String(b.compte).toLowerCase()).first();
    if (u) { const t = JSON.parse(u.trips || "[]"); if (!t.includes(id)) t.push(id); await env.DB.prepare("UPDATE users SET trips = ? WHERE username = ?").bind(JSON.stringify(t), u.username).run(); compte = u.username; }
  }
  return { ok: true, id, cle, compte, commit, url: `https://monaccompagnateur.ca/${id}/` };
}

async function adminNouvelleCle(env, trip) {
  await requireTrip(env, trip);
  const cle = newKey();
  await ensureSchema(env);
  await env.DB.prepare("INSERT INTO editor_keys (trip, hash, created_at) VALUES (?, ?, ?) ON CONFLICT (trip) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at").bind(trip, await hashKey(cle), Date.now()).run();
  return { ok: true, trip, cle };
}

// Suppression d'un voyage : l'app, sa fiche, sa photo, son icône, son dictionnaire, son entrée sur la page d'accueil
// (un seul commit, réversible dans l'historique GitHub), puis ses alertes, sa clé et ses accès dans la base.
async function adminSupprimer(env, b) {
  const id = String(b.trip || "");
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id) || /^(admin|api|_app|assets|confidentialite)/.test(id)) throw new HttpError(400, "Voyage invalide");
  if (b.confirmer !== id) throw new HttpError(400, "Confirmation manquante : tapez l'adresse du voyage");
  let n = 0;
  const commit = await commitFiles(env, async (paths) => {
    const own = new Set([`_app/voyages/${id}.json`, `_app/i18n/voyages/${id}.json`, `_app/icones/${id}.svg`]);
    const del = paths.filter((p) => p.startsWith(`${id}/`) || own.has(p) || new RegExp(`^_app/voyages/photos/${id}\\.(jpe?g|png|webp)$`).test(p));
    if (!del.some((p) => p === `_app/voyages/${id}.json` || p.startsWith(`${id}/`))) throw new HttpError(404, "Voyage introuvable dans le dépôt");
    n = del.length;
    const out = del.map((p) => ({ path: p, del: true }));
    const site = await ghFile(env, "voyages.json");
    if (site) {
      const d = JSON.parse(site.text);
      const avant = (d.voyages || []).length;
      d.voyages = (d.voyages || []).filter((v) => !String(v.app || "").includes(`/${id}/`));
      if (d.voyages.length !== avant) out.push({ path: "voyages.json", text: JSON.stringify(d, null, 2) + "\n" });
    }
    return out;
  }, `Suppression du voyage ${id}`);
  await purgeTrip(env, id);
  await ensureSchema(env);
  // Marqué supprimé (clos = 2) plutôt qu'effacé : plus d'alertes, et absent de l'administration même si GitHub tarde à mettre sa liste à jour
  await env.DB.prepare(`INSERT INTO trips (id, titre, url, max_subs, created_at, clos) VALUES (?, ?, ?, 300, ?, 2) ON CONFLICT (id) DO UPDATE SET clos = 2`).bind(id, id, `/${id}/`, Date.now()).run();
  await env.DB.prepare("DELETE FROM editor_keys WHERE trip = ?").bind(id).run();
  await ensureAuthSchema(env);
  const us = (await env.DB.prepare("SELECT username, trips FROM users").all()).results || [];
  for (const u of us) { const t = JSON.parse(u.trips || "[]"); if (t.includes(id)) await env.DB.prepare("UPDATE users SET trips = ? WHERE username = ?").bind(JSON.stringify(t.filter((x) => x !== id)), u.username).run(); }
  return { ok: true, id, fichiers: n, commit };
}

// App de l'accompagnateur : ses voyages (tous pour l'administrateur), sans le contenu chiffré
async function mesVoyages(env, req) {
  const u = await sessionUser(env, req);
  if (!u) throw new HttpError(401, "Session expirée : reconnectez-vous");
  if (u.must_change) throw new HttpError(428, "Changez d'abord votre mot de passe temporaire");
  const admin = u.role === "admin";
  if (!u.totp_on) throw new HttpError(428, "Activez d'abord la double authentification");
  const mine = new Set(JSON.parse(u.trips || "[]"));
  const [vFiles, all] = await Promise.all([ghDir(env, "_app/voyages"), trips(env)]);
  const ids = vFiles.filter((f) => f.name.endsWith(".json")).map((f) => f.name.slice(0, -5)).filter((id) => (admin || mine.has(id)) && !(all[id] || {}).supprime);
  await ensureSchema(env);
  const subs = await env.DB.prepare("SELECT trip, COUNT(*) AS n FROM subscriptions GROUP BY trip").all();
  const nSubs = Object.fromEntries((subs.results || []).map((r) => [r.trip, r.n]));
  const stations = {};
  const voyages = [];
  for (const id of ids) {
    const j = await ghFile(env, `_app/voyages/${id}.json`);
    let v; try { v = JSON.parse(j.text); } catch { continue; }
    if (v.station && !(v.station in stations)) {
      const sf = await ghFile(env, `_app/stations/${v.station}.json`);
      try { const st = JSON.parse(sf.text); stations[v.station] = { nom: st.nom, lieu: st.lieu, fuseau: st.fuseau }; } catch { stations[v.station] = null; }
    }
    const t = all[id] || {};
    voyages.push({ id, titre: v.titre, appCourt: v.appCourt, dates: v.dates, station: stations[v.station] || null, alertes: !!all[id], abonnes: nSubs[id] || 0, clos: !!t.clos, fin: t.end || null });
  }
  return { profil: { username: u.username, nom: u.nom || u.username, role: u.role }, voyages };
}

// Photo d'en-tête d'un voyage existant : le robot la recadre ensuite en hero.webp et og.jpg
async function adminPhoto(env, b) {
  const id = String(b.trip || "");
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) throw new HttpError(400, "Voyage invalide");
  const fiche = await ghFile(env, `_app/voyages/${id}.json`);
  if (!fiche) throw new HttpError(404, "Voyage introuvable");
  const m = String(b.photo || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, "Photo : JPEG, PNG ou WebP seulement");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const conf = JSON.parse(fiche.text);
  conf.credit = str(b.credit, 300) ? esc(str(b.credit, 300)) : "Photo : monaccompagnateur.ca";
  const commit = await commitFiles(env, (paths) => [
    ...paths.filter((p) => new RegExp(`^_app/voyages/photos/${id}\\.(jpe?g|png|webp|fait)$`).test(p)).map((p) => ({ path: p, del: true })),
    { path: `_app/voyages/photos/${id}.${ext}`, b64: m[2] },
    { path: `_app/voyages/${id}.json`, text: JSON.stringify(conf, null, 2) + "\n" },
  ], `Photo d'en-tête : ${conf.titre || id}`);
  return { ok: true, id, commit };
}

async function handleAdmin(req, env, path, url) {
  const me = await requireAdmin(env, req);
  if (path.startsWith("/api/admin/comptes")) {
    const r = await handleComptes(env, path, req.method === "POST" ? await readJson(req) : {}, req.method, me);
    if (r) return r;
  }
  if (req.method === "GET" && path === "/api/admin/etat") return adminEtat(env);
  if (req.method === "POST" && path === "/api/admin/voyages") return adminCreer(env, await readJson(req, MAX_ADMIN_BYTES));
  if (req.method === "POST" && path === "/api/admin/cle") { const b = await readJson(req); return adminNouvelleCle(env, b.trip); }
  if (req.method === "POST" && path === "/api/admin/photo") return adminPhoto(env, await readJson(req, MAX_ADMIN_BYTES));
  if (req.method === "POST" && path === "/api/admin/supprimer") return adminSupprimer(env, await readJson(req));
  if (req.method === "POST" && path === "/api/admin/clore") {
    const b = await readJson(req); await requireTrip(env, b.trip);
    await purgeTrip(env, b.trip);
    await ensureSchema(env);
    const t = (await trips(env))[b.trip] || {};
    await env.DB.prepare(`INSERT INTO trips (id, titre, url, fin, max_subs, created_at, clos) VALUES (?, ?, ?, ?, 300, ?, 1) ON CONFLICT (id) DO UPDATE SET clos = 1`).bind(b.trip, t.title || b.trip, t.url || `/${b.trip}/`, t.end || null, Date.now()).run();
    await env.DB.prepare("DELETE FROM editor_keys WHERE trip = ?").bind(b.trip).run();
    return { ok: true };
  }
  throw new HttpError(404, "Introuvable");
}

// ---------- routes ----------

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, req) });
  if (path.startsWith("/api/auth/")) return json(env, req, await handleAuth(req, env, path, readJson));
  if (path === "/api/mes-voyages" && req.method === "GET") return json(env, req, await mesVoyages(env, req));
  if (path.startsWith("/api/admin/")) return json(env, req, await handleAdmin(req, env, path, url));

  if (req.method === "GET" && path === "/api/vapid") {
    return json(env, req, { publicKey: env.VAPID_PUBLIC_KEY });
  }

  // Abonnement d'un téléphone (appelé par l'app du voyageur)
  if (req.method === "POST" && path === "/api/subscribe") {
    if (!allowedOrigin(env, req.headers.get("Origin"))) throw new HttpError(403, "Origine refusée");
    const body = await readJson(req);
    const t = await requireTrip(env, body.trip);
    const s = body.subscription || {};
    const keys = s.keys || {};
    if (!validEndpoint(env, s.endpoint)) throw new HttpError(400, "Endpoint refusé");
    if (!validKey(keys.p256dh, 65, 4) || !validKey(keys.auth, 16)) throw new HttpError(400, "Clés invalides");

    const exists = await env.DB.prepare("SELECT 1 FROM subscriptions WHERE trip = ? AND endpoint = ?").bind(body.trip, s.endpoint).first();
    if (!exists) {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE trip = ?").bind(body.trip).first();
      if (n >= num(t.maxSubs, 300)) throw new HttpError(429, "Trop d'abonnements pour ce voyage");
    }
    await env.DB.prepare(
      `INSERT INTO subscriptions (trip, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (trip, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(body.trip, s.endpoint, keys.p256dh, keys.auth, Date.now()).run();
    return json(env, req, { ok: true });
  }

  if (req.method === "POST" && path === "/api/unsubscribe") {
    if (!allowedOrigin(env, req.headers.get("Origin"))) throw new HttpError(403, "Origine refusée");
    const body = await readJson(req);
    await requireTrip(env, body.trip);
    if (typeof body.endpoint !== "string") throw new HttpError(400, "Endpoint manquant");
    await env.DB.prepare("DELETE FROM subscriptions WHERE trip = ? AND endpoint = ?").bind(body.trip, body.endpoint).run();
    return json(env, req, { ok: true });
  }

  // Calendrier des annonces (appelé par l'éditeur à chaque publication).
  // items = [{ id, at: "2027-03-07T08:00:00+01:00", kind: "annonce" | "rappel" }]
  // La liste remplace les envois en attente; ce qui est déjà parti n'est jamais renvoyé.
  if (req.method === "POST" && path === "/api/schedule") {
    const body = await readJson(req);
    await requireTrip(env, body.trip);
    await requireEditor(env, req, body.trip);
    if (!Array.isArray(body.items) || body.items.length > 200) throw new HttpError(400, "items invalide");
    const c = cfg(env);
    const now = Date.now();
    const earliest = now + c.publishDelay * 1000; // laisse le temps à GitHub Pages de publier

    const items = [];
    const seen = new Set();
    for (const it of body.items) {
      if (!it || typeof it.id !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(it.id)) throw new HttpError(400, "id invalide");
      if (seen.has(it.id)) throw new HttpError(400, `id en double : ${it.id}`);
      seen.add(it.id);
      const kind = it.kind || "annonce";
      if (!(kind in KINDS) || kind === "test") throw new HttpError(400, `kind invalide : ${kind}`);
      const at = Date.parse(it.at);
      if (!Number.isFinite(at)) throw new HttpError(400, `date invalide pour ${it.id}`);
      items.push({ id: it.id, kind, at });
    }

    const existing = await env.DB.prepare("SELECT id, done_at FROM announcements WHERE trip = ?").bind(body.trip).all();
    const done = new Set(existing.results.filter((r) => r.done_at != null).map((r) => r.id));
    const pending = new Set(existing.results.filter((r) => r.done_at == null).map((r) => r.id));

    const stmts = [];
    const report = { programmees: 0, ignorees_deja_envoyees: 0, ignorees_passees: 0, retirees: 0 };
    for (const it of items) {
      if (done.has(it.id)) { report.ignorees_deja_envoyees++; continue; }
      if (!pending.has(it.id) && it.at < now - c.maxPast * 1000) { report.ignorees_passees++; continue; }
      const sendAt = Math.max(it.at, earliest);
      stmts.push(env.DB.prepare(
        `INSERT INTO announcements (trip, id, kind, send_at, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (trip, id) DO UPDATE SET kind = excluded.kind, send_at = excluded.send_at
         WHERE announcements.done_at IS NULL`,
      ).bind(body.trip, it.id, it.kind, sendAt, now));
      report.programmees++;
    }
    for (const id of pending) {
      if (!seen.has(id)) {
        stmts.push(env.DB.prepare("DELETE FROM announcements WHERE trip = ? AND id = ? AND done_at IS NULL").bind(body.trip, id));
        report.retirees++;
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json(env, req, { ok: true, ...report });
  }

  // Notification de test, envoyée à tout le groupe à la prochaine minute
  if (req.method === "POST" && path === "/api/test") {
    const body = await readJson(req);
    await requireTrip(env, body.trip);
    await requireEditor(env, req, body.trip);
    const id = `test-${Date.now()}`;
    await env.DB.prepare("INSERT INTO announcements (trip, id, kind, send_at, created_at) VALUES (?, ?, 'test', ?, ?)")
      .bind(body.trip, id, Date.now(), Date.now()).run();
    return json(env, req, { ok: true, id });
  }

  if (req.method === "GET" && path === "/api/status") {
    const trip = url.searchParams.get("trip");
    await requireTrip(env, trip);
    await requireEditor(env, req, trip);
    const subs = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE trip = ?").bind(trip).first();
    const anns = await env.DB.prepare(
      `SELECT a.id, a.kind, a.send_at, a.done_at,
              (SELECT COUNT(*) FROM deliveries d WHERE d.trip = a.trip AND d.ann_id = a.id AND d.status BETWEEN 200 AND 299) AS livrees,
              (SELECT COUNT(*) FROM deliveries d WHERE d.trip = a.trip AND d.ann_id = a.id AND NOT (d.status BETWEEN 200 AND 299)) AS echecs
       FROM announcements a WHERE a.trip = ? ORDER BY a.send_at DESC LIMIT 50`,
    ).bind(trip).all();
    return json(env, req, {
      trip,
      abonnements: subs.n,
      annonces: anns.results.map((a) => ({
        id: a.id, kind: a.kind,
        envoi: new Date(a.send_at).toISOString(),
        termine: a.done_at ? new Date(a.done_at).toISOString() : null,
        livrees: a.livrees, echecs: a.echecs,
      })),
    });
  }

  // Lecture du voyage.json à jour (avec son sha) pour l'éditeur
  if (req.method === "GET" && path === "/api/voyage") {
    const trip = url.searchParams.get("trip");
    await requireTrip(env, trip);
    await requireEditor(env, req, trip);
    return json(env, req, { ok: true, trip, ...(await ghGetVoyage(env, trip)) });
  }

  // Publication depuis l'éditeur : remplace <voyage>/voyage.json, et rien d'autre
  if (req.method === "POST" && path === "/api/publier") {
    const body = await readJson(req, MAX_VOYAGE_BYTES + 4096);
    await requireTrip(env, body.trip);
    await requireEditor(env, req, body.trip);
    if (typeof body.content !== "string" || !body.content.length) throw new HttpError(400, "Contenu manquant");
    if (new TextEncoder().encode(body.content).length > MAX_VOYAGE_BYTES) throw new HttpError(413, "Contenu trop gros");
    if (body.sha != null && (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha))) throw new HttpError(400, "sha invalide");
    const neuf = checkVoyage(body.content);

    const actuel = await ghGetVoyage(env, body.trip);
    if (actuel.sha && body.sha !== actuel.sha) throw new HttpError(409, "Le voyage a été modifié ailleurs depuis l'ouverture de l'éditeur", { sha_actuel: actuel.sha });
    // Ne jamais retirer la protection par erreur : un voyage chiffré reste chiffré
    if (actuel.content && !neuf.chiffre) {
      let avant = null;
      try { avant = JSON.parse(actuel.content); } catch {}
      if (avant && avant.chiffre) throw new HttpError(400, "Le voyage en ligne est protégé par une phrase : publication en clair refusée");
    }

    const g = github(env);
    const r = await fetch(`${g.api}/repos/${g.repo}/contents/${voyagePath(body.trip)}`, {
      method: "PUT",
      headers: { ...g.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Mise à jour du voyage ${body.trip} depuis l'éditeur`,
        content: utf8ToB64(body.content),
        sha: actuel.sha || undefined,
        branch: g.branch,
        author: { name: `Éditeur ${body.trip}`, email: "editeur@monaccompagnateur.ca" },
      }),
    });
    if (r.status === 409 || r.status === 422) throw new HttpError(409, "Le voyage a été modifié ailleurs pendant la publication");
    if (!r.ok) throw new HttpError(502, `GitHub a refusé la publication (${r.status})`);
    const j = await r.json();
    return json(env, req, { ok: true, sha: j.content && j.content.sha, commit: j.commit && j.commit.sha });
  }

  // Effacement complet des données d'un voyage
  if (req.method === "POST" && path === "/api/purge") {
    const body = await readJson(req);
    await requireTrip(env, body.trip);
    await requireEditor(env, req, body.trip);
    await purgeTrip(env, body.trip);
    return json(env, req, { ok: true });
  }

  throw new HttpError(404, "Introuvable");
}

// ---------- envoi planifié ----------

async function purgeTrip(env, trip) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries WHERE trip = ?").bind(trip),
    env.DB.prepare("DELETE FROM announcements WHERE trip = ?").bind(trip),
    env.DB.prepare("DELETE FROM subscriptions WHERE trip = ?").bind(trip),
  ]);
}

export async function runDue(env, now = Date.now()) {
  const c = cfg(env);
  const allTrips = await trips(env);
  let budget = c.maxPerRun;
  const log = { envoyees: 0, expirees: 0, echecs: 0, annonces_terminees: 0 };

  const due = await env.DB.prepare(
    "SELECT trip, id, kind, send_at FROM announcements WHERE done_at IS NULL AND send_at <= ? ORDER BY send_at LIMIT 20",
  ).bind(now).all();

  for (const ann of due.results) {
    if (budget <= 0) break;
    const t = allTrips[ann.trip];
    // Trop vieille (Worker en pause, voyage retiré) : on ne l'envoie plus
    if (!t || now - ann.send_at > c.ttl * 1000) {
      await env.DB.prepare("UPDATE announcements SET done_at = ? WHERE trip = ? AND id = ?").bind(now, ann.trip, ann.id).run();
      log.annonces_terminees++;
      continue;
    }

    const subs = await env.DB.prepare(
      `SELECT endpoint, p256dh, auth FROM subscriptions s
       WHERE s.trip = ? AND NOT EXISTS (
         SELECT 1 FROM deliveries d WHERE d.trip = s.trip AND d.ann_id = ? AND d.endpoint = s.endpoint)
       LIMIT ?`,
    ).bind(ann.trip, ann.id, budget).all();

    const message = {
      title: t.title || "Votre voyage",
      body: (t.messages && t.messages[ann.kind]) || KINDS[ann.kind] || KINDS.annonce,
      url: t.url || "/",
      tag: `${ann.trip}:${ann.id}`,
      kind: ann.kind,
      id: ann.id,
    };

    let rateLimited = false;
    const batchSize = 10;
    for (let i = 0; i < subs.results.length && !rateLimited; i += batchSize) {
      const chunk = subs.results.slice(i, i + batchSize);
      const results = await Promise.all(chunk.map((s) => sendPush(s, message, c.vapid, {
        ttl: c.ttl,
        urgency: ann.kind === "rappel" ? "high" : "normal",
      })));
      const stmts = [];
      results.forEach((r, j) => {
        const s = chunk[j];
        if (r.status === 429) { rateLimited = true; return; }
        if (r.status === 404 || r.status === 410) {
          stmts.push(env.DB.prepare("DELETE FROM subscriptions WHERE trip = ? AND endpoint = ?").bind(ann.trip, s.endpoint));
          log.expirees++;
          return;
        }
        if (r.status >= 200 && r.status < 300) log.envoyees++; else log.echecs++;
        stmts.push(env.DB.prepare(
          "INSERT OR REPLACE INTO deliveries (trip, ann_id, endpoint, status, at) VALUES (?, ?, ?, ?, ?)",
        ).bind(ann.trip, ann.id, s.endpoint, r.status, now));
      });
      if (stmts.length) await env.DB.batch(stmts);
    }
    budget -= subs.results.length;
    if (rateLimited) break;

    // Tout le monde a été servi : l'annonce est terminée
    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM subscriptions s WHERE s.trip = ? AND NOT EXISTS (
         SELECT 1 FROM deliveries d WHERE d.trip = s.trip AND d.ann_id = ? AND d.endpoint = s.endpoint)`,
    ).bind(ann.trip, ann.id).first();
    if (left.n === 0) {
      await env.DB.prepare("UPDATE announcements SET done_at = ? WHERE trip = ? AND id = ?").bind(now, ann.trip, ann.id).run();
      log.annonces_terminees++;
    }
  }
  return log;
}

async function purgeFinishedTrips(env, now = Date.now()) {
  const c = cfg(env);
  for (const [trip, t] of Object.entries(await trips(env))) {
    if (!t.end) continue;
    const end = Date.parse(`${t.end}T23:59:59Z`);
    if (Number.isFinite(end) && now > end + c.purgeAfterDays * 86400000) await purgeTrip(env, trip);
  }
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (err) {
      const status = typeof err.status === "number" ? err.status : 500;
      if (status === 500) console.error(err);
      return json(env, req, { ok: false, erreur: status === 500 ? "Erreur interne" : err.message, ...(err.extra || {}) }, status);
    }
  },

  async scheduled(event, env, ctx) {
    const now = event.scheduledTime || Date.now();
    const log = await runDue(env, now);
    if (log.envoyees || log.echecs || log.expirees) console.log(JSON.stringify(log));
    if (new Date(now).getUTCMinutes() === 0) { await purgeFinishedTrips(env, now); await purgeSessions(env).catch(() => {}); }
  },
};

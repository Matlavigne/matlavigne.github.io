// Worker de notifications pour les apps de voyage monaccompagnateur.ca
//
// Le Worker ne voit jamais le contenu du voyage : il garde les abonnements des téléphones
// et un calendrier (identifiant + heure) des annonces, et envoie des textes génériques.
// L'app déchiffre l'annonce elle-même quand le voyageur touche la notification.

import { sendPush, b64urlDecode } from "./webpush.js";

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

function trips(env) {
  const t = env.TRIPS;
  if (!t) return {};
  return typeof t === "string" ? JSON.parse(t) : t;
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

async function readJson(req) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "Requête trop grosse");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Requête trop grosse");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "JSON invalide"); }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

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
  let tokens = {};
  try { tokens = JSON.parse(env.EDITOR_TOKENS || "{}"); } catch { tokens = {}; }
  const candidates = [tokens[trip], tokens["*"]].filter(Boolean);
  for (const t of candidates) if (await safeEqual(m[1], t)) return;
  throw new HttpError(403, "Jeton refusé");
}

function requireTrip(env, trip) {
  if (typeof trip !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(trip)) throw new HttpError(400, "Voyage invalide");
  const t = trips(env)[trip];
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

// ---------- routes ----------

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, req) });

  if (req.method === "GET" && path === "/api/vapid") {
    return json(env, req, { publicKey: env.VAPID_PUBLIC_KEY });
  }

  // Abonnement d'un téléphone (appelé par l'app du voyageur)
  if (req.method === "POST" && path === "/api/subscribe") {
    if (!allowedOrigin(env, req.headers.get("Origin"))) throw new HttpError(403, "Origine refusée");
    const body = await readJson(req);
    const t = requireTrip(env, body.trip);
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
    requireTrip(env, body.trip);
    if (typeof body.endpoint !== "string") throw new HttpError(400, "Endpoint manquant");
    await env.DB.prepare("DELETE FROM subscriptions WHERE trip = ? AND endpoint = ?").bind(body.trip, body.endpoint).run();
    return json(env, req, { ok: true });
  }

  // Calendrier des annonces (appelé par l'éditeur à chaque publication).
  // items = [{ id, at: "2027-03-07T08:00:00+01:00", kind: "annonce" | "rappel" }]
  // La liste remplace les envois en attente; ce qui est déjà parti n'est jamais renvoyé.
  if (req.method === "POST" && path === "/api/schedule") {
    const body = await readJson(req);
    requireTrip(env, body.trip);
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
    requireTrip(env, body.trip);
    await requireEditor(env, req, body.trip);
    const id = `test-${Date.now()}`;
    await env.DB.prepare("INSERT INTO announcements (trip, id, kind, send_at, created_at) VALUES (?, ?, 'test', ?, ?)")
      .bind(body.trip, id, Date.now(), Date.now()).run();
    return json(env, req, { ok: true, id });
  }

  if (req.method === "GET" && path === "/api/status") {
    const trip = url.searchParams.get("trip");
    requireTrip(env, trip);
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

  // Effacement complet des données d'un voyage
  if (req.method === "POST" && path === "/api/purge") {
    const body = await readJson(req);
    requireTrip(env, body.trip);
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
  const allTrips = trips(env);
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
  for (const [trip, t] of Object.entries(trips(env))) {
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
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json(env, req, { ok: false, erreur: status === 500 ? "Erreur interne" : err.message }, status);
    }
  },

  async scheduled(event, env, ctx) {
    const now = event.scheduledTime || Date.now();
    const log = await runDue(env, now);
    if (log.envoyees || log.echecs || log.expirees) console.log(JSON.stringify(log));
    if (new Date(now).getUTCMinutes() === 0) await purgeFinishedTrips(env, now);
  },
};

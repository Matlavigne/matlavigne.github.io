// Service worker généré par _app/build.mjs (ne pas modifier ici : modifier _app/gabarit/sw.js)
// Changez CACHE à chaque mise à jour pour forcer l'actualisation chez les utilisateurs.
const CACHE = 'gendronski-zermatt-2027-93bb0d48';
const CORE = ['./', 'index.html', 'manifest.webmanifest',
              'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
              'voyage.json', 'hero.webp', 'installer.html', 'affiche-bagages.html', 'og.jpg', 'editeur.html'];

// Recopie une réponse redirigée en réponse « propre » (sinon Safari refuse de l'afficher).
const propre = r => r.redirected ? r.blob().then(b => new Response(b, {status: r.status, statusText: r.statusText, headers: r.headers})) : r;

self.addEventListener('install', e => {
  // cache: 'reload' : on prend les fichiers frais du serveur, pas ceux du cache HTTP du navigateur.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(CORE.map(u => fetch(u, {cache: 'reload'}).then(r => { if (r.ok) return Promise.resolve(propre(r)).then(x => c.put(u, x)); }).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('gendronski-zermatt-2027-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page : réseau d'abord (contenu à jour), avec délai max; copie en cache si hors ligne.
  // On ne met en cache qu'une vraie réponse 200 sans redirection (iOS refuse d'afficher une
  // réponse redirigée servie par le service worker → écran noir hors ligne).
  if (req.mode === 'navigate') {
    const shell = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    const cle = shell ? 'index.html' : url.pathname;
    const enCache = () => caches.open(CACHE)
      .then(c => c.match(cle, {ignoreSearch: true}).then(hit => hit || c.match('index.html')).then(hit => hit || c.match('./')))
      .then(hit => hit || caches.match(cle, {ignoreSearch: true}));
    const horsLigne = () => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:17px system-ui;padding:40px 24px;background:#fff;color:#123">'
        + '<h1 style="font-size:22px">Hors ligne</h1><p>L’app n’est pas encore enregistrée sur cet appareil. Ouvrez-la une fois avec Internet, puis elle fonctionnera hors ligne.</p>'
        + '<p><button onclick="location.reload()" style="font:inherit;padding:10px 18px">Réessayer</button></p>',
        {headers: {'Content-Type': 'text/html; charset=utf-8'}});
    const reseau = fetch(req).then(r => {
      if (r.ok && r.type === 'basic' && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(cle, copy)); }
      if (r.ok || r.type === 'opaqueredirect') return r;  // une redirection est suivie par le navigateur, jamais mise en cache
      throw new Error('réponse ' + r.status);
    });
    const delai = new Promise((_, non) => setTimeout(() => non(new Error('délai')), 4000));
    e.respondWith(Promise.race([reseau, delai]).catch(() => enCache().then(hit => hit
      ? Promise.resolve(propre(hit))
      : reseau.catch(() => horsLigne()))));
    return;
  }

  // Données JSON du même site (ex. voyage.json) : réseau d'abord pour voir les modifications, cache si hors ligne.
  if (url.origin === location.origin && url.pathname.endsWith('.json')) {
    e.respondWith(fetch(req, {cache: 'no-store'}).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); }
      return r;
    }).catch(() => caches.match(url.pathname).then(hit => hit && hit.blob().then(b => {
      const h = new Headers(hit.headers); h.set('X-Hors-Ligne', '1');  // l'app affiche alors le bandeau « Hors ligne »
      return new Response(b, {status: 200, headers: h});
    }))));
    return;
  }

  // Fichiers du même site : cache d'abord, puis réseau.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    })));
    return;
  }

  // Images en direct (webcams, paramètre live=) : toujours le réseau, jamais le cache.
  if (url.searchParams.has('live')) return;

  // Images externes : mises en cache au premier affichage (best effort).
  if (req.destination === 'image') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r;
    }).catch(() => hit)));
  }
  // Le reste (cartes en iframe, API) passe directement au réseau.
});

// ---------- Alertes du voyage (push) ----------
self.VOYAGE_PUSH = { worker: 'https://monaccompagnateur-push.monaccompagnateur.workers.dev', trip: 'zermatt-mars2027', icon: 'icon-192.png' };
/* Alertes du voyage — à ajouter au service worker existant de l'app.
 *
 * En haut du service worker (avant importScripts) :
 *   self.VOYAGE_PUSH = {
 *     worker: "https://monaccompagnateur-push.<compte>.workers.dev",
 *     trip: "solden-voyage-2027",
 *     icon: "icons/icon-192.png",   // facultatif
 *     badge: "icons/badge-72.png",  // facultatif (Android)
 *   };
 *   importScripts("sw-push.js");
 *
 * L'app reçoit un message { type: "voyage-push", kind, id } quand une alerte arrive ou est touchée :
 * elle doit alors recharger son contenu depuis le réseau (pas depuis le cache) et l'afficher.
 */
(function () {
  "use strict";
  var conf = self.VOYAGE_PUSH || {};

  function tellClients(msg) {
    return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      list.forEach(function (c) { c.postMessage(msg); });
      return list;
    });
  }

  self.addEventListener("push", function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    var title = data.title || "Votre voyage";
    var options = {
      body: data.body || "Nouvelle annonce du groupe.",
      tag: data.tag || "voyage",
      renotify: true,
      data: { url: data.url || self.registration.scope, kind: data.kind, id: data.id },
    };
    if (conf.icon) options.icon = conf.icon;
    if (conf.badge) options.badge = conf.badge;

    // Pastille sur l'icône de l'app : +1 par annonce, remise à jour par l'app à la lecture
    var badge = (data.kind === "annonce" && self.navigator && self.navigator.setAppBadge)
      ? caches.open("voyage-badge").then(function (c) {
          var key = new Request(self.registration.scope + "__pastille__");
          return c.match(key).then(function (r) { return r ? r.text() : "0"; }).then(function (t) {
            var n = (parseInt(t, 10) || 0) + 1;
            return c.put(key, new Response(String(n))).then(function () { return self.navigator.setAppBadge(n); });
          });
        }).catch(function () {})
      : Promise.resolve();

    // iOS exige qu'une notification visible soit affichée pour chaque push
    event.waitUntil(Promise.all([
      badge,
      self.registration.showNotification(title, options),
      tellClients({ type: "voyage-push", event: "received", kind: data.kind, id: data.id }),
    ]));
  });

  self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var d = event.notification.data || {};
    var target = new URL(d.url || "./", self.registration.scope).href;
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (c.url.indexOf(self.registration.scope) === 0 && "focus" in c) {
            c.postMessage({ type: "voyage-push", event: "opened", kind: d.kind, id: d.id });
            return c.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
    );
  });

  // Le navigateur a renouvelé l'abonnement (surtout Firefox) : on le renvoie au Worker
  self.addEventListener("pushsubscriptionchange", function (event) {
    if (!conf.worker || !conf.trip) return;
    var base = conf.worker.replace(/\/+$/, "");
    event.waitUntil(
      fetch(base + "/api/vapid").then(function (r) { return r.json(); }).then(function (j) {
        var s = j.publicKey.replace(/-/g, "+").replace(/_/g, "/");
        while (s.length % 4) s += "=";
        var bin = atob(s), key = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) key[i] = bin.charCodeAt(i);
        return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }).then(function (sub) {
        var j = sub.toJSON();
        return fetch(base + "/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip: conf.trip, subscription: { endpoint: j.endpoint, keys: j.keys } }),
        });
      }).catch(function () {}),
    );
  });
})();

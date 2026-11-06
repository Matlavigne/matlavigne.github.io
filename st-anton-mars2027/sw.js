// Service worker généré par _app/build.mjs (ne pas modifier ici : modifier _app/gabarit/sw.js)
// Changez CACHE à chaque mise à jour pour forcer l'actualisation chez les utilisateurs.
const CACHE = 'gendronski-st-anton-2027-3c7ffbbf';
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
    .then(keys => Promise.all(keys.filter(k => k.startsWith('gendronski-st-anton-2027-') && k !== CACHE).map(k => caches.delete(k))))
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

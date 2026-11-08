// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
// App « Mon accompagnateur » (voyageurs, accompagnateurs, administration) : page gardée pour l'ouverture hors ligne; toujours la version en ligne si possible.
const CACHE = "app-v1";
const FILES = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "liste.json", "accompagnateur.html", "groupe.html"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n.startsWith("app-") && n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith("/app/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("./"))));
});

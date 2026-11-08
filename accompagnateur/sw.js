// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
// Ancienne app « Accompagnateur » (remplacée par l'app Mon accompagnateur, /app/) : ce service worker efface son
// cache et se retire des téléphones où il était installé. Les pages de ce dossier redirigent vers /app/.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n.startsWith("accompagnateur-")).map((n) => caches.delete(n))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: "window" }))
    .then((l) => l.forEach((c) => c.navigate("/app/accompagnateur.html").catch(() => {}))));
});

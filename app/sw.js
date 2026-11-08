// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
// App « Mon accompagnateur » (voyageurs, accompagnateurs, administration) : page gardée pour l'ouverture hors ligne; toujours la version en ligne si possible.
const CACHE = "app-v10";
const FILES = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "liste.json", "accompagnateur.html", "groupe.html", "equipe.js", "garde.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n.startsWith("app-") && n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith("/app/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("./"))));
});

// ---------- Notifications : accès approuvé et alertes des voyages ----------
// Dans l'app unique, les voyages s'abonnent aux alertes avec ce service worker (une notification, pas de doublon).
var EN = {
  "Nouvelle annonce du groupe. Touchez pour la lire.": "New group announcement. Tap to read it.",
  "Rappel : un rendez-vous approche. Touchez pour les détails.": "Reminder: a meeting time is coming up. Tap for details.",
  "Les alertes du voyage fonctionnent sur ce téléphone.": "Trip alerts work on this phone.",
  "Accès approuvé : touchez pour ouvrir votre voyage.": "Access approved: tap to open your trip.",
  "Nouvelle annonce du groupe.": "New group announcement.",
  "Votre voyage": "Your trip",
  "Alertes des demandes d'accès activées sur ce téléphone.": "Access request alerts are on for this phone.",
  "Demande d'accès": "Access request",
  "Clé d'équipe reçue : touchez pour ouvrir Mon groupe.": "Team key received: tap to open My group.",
  "Mon groupe": "My group",
};
function tellClients(msg) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (l) { l.forEach(function (c) { c.postMessage(msg); }); });
}
// Pastille de l'icône : annonces non lues + demandes d'accès en attente (accompagnateur) + accès approuvés pas encore vus (voyageur)
function lireN(c, k) { return c.match(new Request(k)).then(function (r) { return r ? r.text() : "0"; }).then(function (t) { return parseInt(t, 10) || 0; }); }
function pastillePlus(kind) {
  if (!self.navigator || !self.navigator.setAppBadge) return Promise.resolve();
  var A = "/app/__pastille__", D = "/app/__pastille-dem__", P = "/app/__pastille-acces__", key = kind === "demande" ? D : kind === "acces" ? P : A;
  return caches.open("voyage-badge").then(function (c) {
    return lireN(c, key).then(function (n) { return c.put(new Request(key), new Response(String(n + 1))); })
      .then(function () { return Promise.all([lireN(c, A), lireN(c, D), lireN(c, P)]); })
      .then(function (v) { return self.navigator.setAppBadge(v[0] + v[1] + v[2]); });
  }).catch(function () {});
}
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || "Votre voyage";
  var options = { body: data.body || "Nouvelle annonce du groupe.", tag: data.tag || "voyage", renotify: true, icon: "/app/icon-192.png", data: { url: data.url || "/app/", kind: data.kind, id: data.id } };
  var badge = (data.kind === "annonce" || data.kind === "demande" || data.kind === "acces") ? pastillePlus(data.kind) : Promise.resolve();
  var show = caches.open("voyage-badge").then(function (c) { return c.match("/app/__langue__"); })
    .then(function (r) { return r ? r.text() : "fr"; }).catch(function () { return "fr"; })
    .then(function (lang) {
      if (lang === "en") {
        if (data.kind === "demande") options.body = data.n > 1 ? data.n + " access requests waiting." : "New access request for the trip.";
        else if (data.kind === "cle" && data.nom) options.body = data.nom + " is waiting for the My group team key.";
        else options.body = EN[options.body] || options.body;
        title = EN[title] || title;
      }
      return self.registration.showNotification(title, options);
    });
  event.waitUntil(Promise.all([badge, show, tellClients({ type: "voyage-push", event: "received", kind: data.kind, id: data.id })]));
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  var target = new URL(d.url || "/app/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if ("focus" in c) {
        c.postMessage({ type: "voyage-push", event: "opened", kind: d.kind, id: d.id });
        return c.focus().then(function (w) { if (w && w.url.split("#")[0] !== target.split("#")[0]) return ("navigate" in w ? w.navigate(target) : Promise.reject()).catch(function () { return self.clients.openWindow(target); }); });
      }
    }
    return self.clients.openWindow(target);
  }));
});

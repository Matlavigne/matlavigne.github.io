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

    // iOS exige qu'une notification visible soit affichée pour chaque push
    event.waitUntil(Promise.all([
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

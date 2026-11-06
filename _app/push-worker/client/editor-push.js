/* Alertes du voyage — côté éditeur de l'accompagnateur.
 *
 * <script src="editor-push.js"></script>
 * VoyagePushEditor.init({ worker: "https://monaccompagnateur-push.<compte>.workers.dev", trip: "solden-voyage-2027" });
 *
 * Après chaque publication réussie :
 *   VoyagePushEditor.sync(annonces.map(a => ({ id: a.id, at: a.afficherA, kind: "annonce" })))
 *
 *   - id   : identifiant stable de l'annonce (ne change pas si on corrige le texte)
 *   - at   : heure d'affichage ISO avec fuseau, ex. "2027-03-07T08:00:00+01:00"
 *            (pour une annonce immédiate : l'heure de publication)
 *   - kind : "annonce" ou "rappel"
 *
 * Envoyez toujours la liste complète : une annonce retirée de la liste est déprogrammée.
 * Le texte des annonces n'est jamais transmis au Worker.
 */
(function () {
  "use strict";

  var conf = null;
  var KEY = "voyage-push-jeton:";

  function token(ask) {
    var t = null;
    try { t = localStorage.getItem(KEY + conf.trip); } catch (e) {}
    if (!t && ask !== false) {
      t = window.prompt("Jeton des alertes pour " + conf.trip + " (fourni à la création du Worker) :");
      if (t) { t = t.trim(); try { localStorage.setItem(KEY + conf.trip, t); } catch (e) {} }
    }
    return t;
  }

  function call(method, path, body) {
    var t = token();
    if (!t) return Promise.reject(new Error("Jeton des alertes manquant"));
    return fetch(conf.worker.replace(/\/+$/, "") + path, {
      method: method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 || r.status === 403) {
          try { localStorage.removeItem(KEY + conf.trip); } catch (e) {}
        }
        if (!r.ok) throw new Error(j.erreur || ("Erreur " + r.status));
        return j;
      });
    });
  }

  window.VoyagePushEditor = {
    init: function (options) {
      conf = Object.assign({}, options);
      if (!conf.worker || !conf.trip) throw new Error("VoyagePushEditor.init : worker et trip sont requis");
      return this;
    },
    /** Remplace le calendrier des alertes. Renvoie { programmees, ignorees_deja_envoyees, ignorees_passees, retirees }. */
    sync: function (items) {
      return call("POST", "/api/schedule", { trip: conf.trip, items: items });
    },
    /** Envoie « Les alertes fonctionnent » à tous les téléphones abonnés, dans la minute. */
    test: function () {
      return call("POST", "/api/test", { trip: conf.trip });
    },
    /** Nombre de téléphones abonnés et dernières alertes envoyées. */
    status: function () {
      return call("GET", "/api/status?trip=" + encodeURIComponent(conf.trip));
    },
    /** Efface tous les abonnements et le calendrier du voyage (après le retour). */
    purge: function () {
      return call("POST", "/api/purge", { trip: conf.trip });
    },
    forgetToken: function () {
      try { localStorage.removeItem(KEY + conf.trip); } catch (e) {}
    },
  };
})();

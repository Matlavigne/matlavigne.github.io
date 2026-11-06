/* Alertes du voyage — côté app du voyageur.
 *
 * <script src="push-client.js"></script>
 * <div id="alertes"></div>
 * <script>
 *   VoyagePush.init({ worker: "https://monaccompagnateur-push.<compte>.workers.dev", trip: "solden-voyage-2027" });
 *   VoyagePush.mountButton(document.getElementById("alertes"));
 * </script>
 *
 * enable() doit être appelé depuis un toucher (exigence d'iOS); mountButton() s'en occupe.
 */
(function () {
  "use strict";

  var conf = null;

  function b64ToBytes(b64) {
    var s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
  }

  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function api(path, body) {
    return fetch(conf.worker.replace(/\/+$/, "") + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.erreur || ("Erreur " + r.status));
        return j;
      });
    });
  }

  function publicKey() {
    if (conf.publicKey) return Promise.resolve(conf.publicKey);
    return api("/api/vapid").then(function (j) { conf.publicKey = j.publicKey; return j.publicKey; });
  }

  // Le service worker peut ne jamais être prêt (navigation privée, erreur) : on n'attend pas plus de 5 s
  function registration() {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise(function (_, no) { setTimeout(function () { no(new Error("Service worker indisponible")); }, 5000); }),
    ]);
  }

  function sendSubscription(sub) {
    var j = sub.toJSON();
    return api("/api/subscribe", { trip: conf.trip, subscription: { endpoint: j.endpoint, keys: j.keys } });
  }

  var VoyagePush = {
    init: function (options) {
      conf = Object.assign({}, options);
      if (!conf.worker || !conf.trip) throw new Error("VoyagePush.init : worker et trip sont requis");
      // Renvoie l'abonnement au Worker à chaque ouverture (rattrape une base effacée ou une clé renouvelée)
      VoyagePush.refresh().catch(function () {});
      return VoyagePush;
    },

    /** 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on' */
    state: function () {
      if (isIOS() && !isStandalone()) return Promise.resolve("ios-install");
      if (!supported()) return Promise.resolve("unsupported");
      if (Notification.permission === "denied") return Promise.resolve("denied");
      return registration().then(function (reg) {
        return reg.pushManager.getSubscription();
      }).then(function (sub) {
        return sub && Notification.permission === "granted" ? "on" : "off";
      });
    },

    enable: function () {
      if (!supported()) return Promise.reject(new Error("Ce navigateur ne reçoit pas d'alertes."));
      // requestPermission doit partir immédiatement après le toucher, avant tout autre await
      var perm = Notification.requestPermission();
      return Promise.resolve(perm).then(function (p) {
        if (p !== "granted") throw new Error(p === "denied" ? "denied" : "dismissed");
        return Promise.all([registration(), publicKey()]);
      }).then(function (r) {
        var reg = r[0], key = r[1];
        return reg.pushManager.getSubscription().then(function (existing) {
          return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        });
      }).then(sendSubscription).then(function () { return "on"; });
    },

    disable: function () {
      return registration().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (!sub) return "off";
        var endpoint = sub.endpoint;
        return sub.unsubscribe().then(function () {
          return api("/api/unsubscribe", { trip: conf.trip, endpoint: endpoint }).catch(function () {});
        }).then(function () { return "off"; });
      });
    },

    refresh: function () {
      if (!supported() || Notification.permission !== "granted") return Promise.resolve();
      return registration().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (sub) return sendSubscription(sub);
      });
    },

    /** Petit bloc prêt à l'emploi : un bouton et une ligne d'état, en français. */
    mountButton: function (el) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voyage-push-btn";
      var msg = document.createElement("p");
      msg.className = "voyage-push-msg";
      el.innerHTML = "";
      el.appendChild(btn);
      el.appendChild(msg);

      function render(state, extra) {
        btn.hidden = false;
        btn.disabled = false;
        switch (state) {
          case "on":
            btn.textContent = "Désactiver les alertes";
            msg.textContent = "Alertes activées : vous serez averti des annonces et des rappels.";
            break;
          case "off":
            btn.textContent = "Activer les alertes";
            msg.textContent = "Recevez les annonces du groupe même quand l'app est fermée.";
            break;
          case "ios-install":
            btn.hidden = true;
            msg.textContent = "Sur iPhone, ajoutez d'abord l'app à l'écran d'accueil (Partager, puis Sur l'écran d'accueil), puis ouvrez-la depuis son icône pour activer les alertes.";
            break;
          case "denied":
            btn.hidden = true;
            msg.textContent = "Les alertes sont bloquées pour cette app. Réactivez-les dans les réglages du téléphone (Notifications), puis rouvrez l'app.";
            break;
          case "unsupported":
            btn.hidden = true;
            msg.textContent = "Ce navigateur ne reçoit pas d'alertes. Les annonces restent visibles dans l'app.";
            break;
          default:
            btn.textContent = "Activer les alertes";
            msg.textContent = extra || "";
        }
      }

      btn.addEventListener("click", function () {
        btn.disabled = true;
        VoyagePush.state().then(function (s) {
          return s === "on" ? VoyagePush.disable() : VoyagePush.enable();
        }).then(function (s) { render(s); }).catch(function (e) {
          if (e && e.message === "denied") return render("denied");
          if (e && e.message === "dismissed") return render("off");
          render("error", "Impossible d'activer les alertes pour l'instant. Réessayez avec du réseau.");
        });
      });

      VoyagePush.state().then(render).catch(function () { render("unsupported"); });
    },
  };

  window.VoyagePush = VoyagePush;
})();

// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
/* Garde : sur téléphone et tablette, l’app s’utilise installée (ouverte depuis son icône), pas dans Safari ou Chrome.
   Raisons : sur iPhone, l’app installée et Safari gardent chacun leurs données (voyages déverrouillés, liste du groupe,
   clé d’équipe), et les notifications n’arrivent que dans l’app installée.
   Ce n’est pas une protection de sécurité (le chiffrement, l’approbation et les comptes le sont) : c’est une règle d’usage.
   Exceptions : ordinateurs; pages Administration et éditeur (non gardées); mode dépannage d’un administrateur (12 h, ce navigateur).
   À charger à la fin du <head>, sans async ni defer : si la page est bloquée, la suite de la page n’est ni affichée ni exécutée. */
(function () {
  'use strict';
  var ua = navigator.userAgent || '';
  var ios = /iP(hone|od|ad)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var android = /Android/i.test(ua);
  var installee = (function () { try { return ['standalone', 'fullscreen', 'minimal-ui'].some(function (m) { return matchMedia('(display-mode: ' + m + ')').matches; }) || navigator.standalone === true; } catch (e) { return false; } })();
  if (installee || !(ios || android)) return;

  var DK = 'monaccompagnateur-depannage';
  var dep = null; try { dep = JSON.parse(localStorage.getItem(DK) || 'null'); } catch (e) { }
  if (dep && dep.exp > Date.now()) {
    // Mode dépannage administrateur : la page s’affiche, avec un rappel discret
    document.addEventListener('DOMContentLoaded', function () {
      var b = document.createElement('div');
      b.setAttribute('style', 'position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:99999;background:#5b4300;color:#fff;border-radius:12px;padding:8px 12px;font:13px/1.4 -apple-system,system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 4px 16px rgba(0,0,0,.25)');
      b.innerHTML = '<span style="flex:1">🛠 Mode dépannage administrateur (navigateur)</span><button type="button" style="all:unset;cursor:pointer;font-weight:700;text-decoration:underline">Terminer</button>';
      b.querySelector('button').onclick = function () { try { localStorage.removeItem(DK); } catch (e) { } location.reload(); };
      document.body.appendChild(b);
    });
    return;
  }

  // Bloqué : le reste de la page devient du texte inerte (rien ne s’y exécute ni ne s’affiche), puis on affiche l’installation
  var ctx = (document.currentScript && document.currentScript.getAttribute('data-garde')) || 'voyageur';
  var lang = 'fr'; try { var p = localStorage.getItem('monaccompagnateur-langue'); lang = p === 'en' || p === 'fr' ? p : (/^en/i.test(navigator.language || '') ? 'en' : 'fr'); } catch (e) { }
  var en = lang === 'en';
  var T = function (fr, e) { return en ? e : fr; };
  var dark = false; try { var th = localStorage.getItem('monaccompagnateur-theme'); dark = th === 'dark' || (th !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { }
  var integre = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|Line\/|Snapchat|MicroMessenger|; wv\)|GSA\//.test(ua);
  var iosAutre = ios && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  var url = location.href;
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ensuite = ctx === 'accompagnateur'
    ? T('Puis Réglages ⚙ › Accès accompagnateur.', 'Then Settings ⚙ › Trip leader access.')
    : T('Puis touchez « Ajouter un voyage ».', 'Then tap “Add a trip”.');
  var etape = function (n, b, s) { return '<li><span class="n">' + n + '</span><span><b>' + b + '</b>' + (s ? '<small>' + s + '</small>' : '') + '</span></li>'; };
  var corps;
  if (integre) {
    corps = '<div class="w"><b>' + T('Ce lien s’est ouvert dans une autre app (Facebook, Messenger…).', 'This link opened inside another app (Facebook, Messenger…).') + '</b><br>' +
      T('L’installation n’y est pas possible. Ouvrez-le dans ', 'Installing is not possible there. Open it in ') + (ios ? 'Safari' : 'Chrome') + '.</div>' +
      '<p class="r">' + (android ? '<a class="btn" href="intent://' + esc(location.host + location.pathname + location.search + location.hash) + '#Intent;scheme=https;package=com.android.chrome;end">' + T('Ouvrir dans Chrome', 'Open in Chrome') + '</a>' : '<a class="btn" href="x-safari-' + esc(url) + '">' + T('Ouvrir dans Safari', 'Open in Safari') + '</a>') +
      '<button type="button" class="btn l" id="g-cp">' + T('Copier le lien', 'Copy the link') + '</button></p>' +
      '<p class="s">' + (ios ? T('Sinon : touchez ··· ou le menu de l’app, puis « Ouvrir dans le navigateur ».', 'Otherwise: tap ··· or the app’s menu, then “Open in browser”.') : T('Sinon : menu ⋮ de l’app, puis « Ouvrir dans Chrome » ou « Ouvrir dans le navigateur ».', 'Otherwise: the app’s ⋮ menu, then “Open in Chrome” or “Open in browser”.')) + '</p>';
  } else if (iosAutre) {
    corps = '<div class="w">' + T('Sur iPhone et iPad, installez l’app à partir de <b>Safari</b>.', 'On iPhone and iPad, install the app from <b>Safari</b>.') + '</div>' +
      '<p class="r"><a class="btn" href="x-safari-' + esc(url) + '">' + T('Ouvrir dans Safari', 'Open in Safari') + '</a><button type="button" class="btn l" id="g-cp">' + T('Copier le lien', 'Copy the link') + '</button></p>';
  } else if (ios) {
    corps = '<ol>' +
      etape(1, T('Touchez le bouton ☰ à gauche de l’adresse', 'Tap the ☰ button left of the address'), T('En bas de Safari (iOS 26). Sur un iOS plus ancien, passez à l’étape 2.', 'At the bottom of Safari (iOS 26). On older iOS, go to step 2.')) +
      etape(2, T('Touchez Partager', 'Tap Share'), T('Le carré avec une flèche.', 'The square with an arrow.')) +
      etape(3, T('Choisissez « Sur l’écran d’accueil »', 'Choose “Add to Home Screen”'), T('Faites défiler vers le bas si vous ne le voyez pas.', 'Scroll down if you don’t see it.')) +
      etape(4, T('Touchez « Ajouter »', 'Tap “Add”'), '') +
      etape(5, T('Ouvrez l’app Mon accompagnateur depuis son icône', 'Open the Mon accompagnateur app from its icon'), ensuite) + '</ol>';
  } else {
    corps = '<p class="r" id="g-inst" hidden><button type="button" class="btn" id="g-ib">' + T('Installer l’app', 'Install the app') + '</button></p>' +
      '<ol>' + etape(1, T('Touchez le menu ⋮ de Chrome', 'Tap Chrome’s ⋮ menu'), T('En haut à droite.', 'At the top right.')) +
      etape(2, T('Choisissez « Installer l’application »', 'Choose “Install app”'), T('Ou « Ajouter à l’écran d’accueil ».', 'Or “Add to Home screen”.')) +
      etape(3, T('Ouvrez l’app Mon accompagnateur depuis son icône', 'Open the Mon accompagnateur app from its icon'), ensuite) + '</ol>';
  }
  var css = ':root{color-scheme:' + (dark ? 'dark' : 'light') + '}' +
    'body#garde{margin:0;min-height:100vh;background:' + (dark ? '#0d141e' : '#f2f5fa') + ';color:' + (dark ? '#e3e9f1' : '#16263a') + ';font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:calc(20px + env(safe-area-inset-top)) 18px calc(24px + env(safe-area-inset-bottom))}' +
    '#garde .c{max-width:520px;margin:0 auto}#garde .h{display:flex;gap:14px;align-items:center;margin-bottom:14px}#garde .h img{width:64px;height:64px;border-radius:15px;box-shadow:0 2px 8px rgba(0,0,0,.2)}' +
    '#garde h1{font-size:23px;line-height:1.2;margin:0;letter-spacing:-.3px}#garde .sub{margin:2px 0 0;font-size:14px;opacity:.75}' +
    '#garde .card{background:' + (dark ? '#172130' : '#fff') + ';border:1px solid ' + (dark ? '#2a3747' : '#d6dee9') + ';border-radius:16px;padding:16px 18px;margin:0 0 12px}' +
    '#garde ol{list-style:none;margin:0;padding:0}#garde li{display:flex;gap:12px;padding:10px 0;border-top:1px solid ' + (dark ? '#2a3747' : '#e3e9f2') + '}#garde li:first-child{border-top:0}' +
    '#garde .n{flex:none;width:28px;height:28px;border-radius:50%;background:#13509f;color:#fff;font-weight:800;display:grid;place-items:center;font-size:14px}#garde li b{display:block;font-size:15.5px}#garde li small{display:block;font-size:13px;opacity:.75}' +
    '#garde .btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 18px;border-radius:12px;background:#13509f;color:#fff;font-weight:700;font-size:15.5px;text-align:center}' +
    '#garde .btn.l{background:transparent;color:' + (dark ? '#86b6f2' : '#13509f') + ';border:1.5px solid currentColor}#garde .r{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}' +
    '#garde .w{background:' + (dark ? '#3a3014' : '#fdf3d8') + ';border-radius:12px;padding:12px 14px;font-size:15px}#garde .s{font-size:13px;opacity:.75;margin:8px 0 0}' +
    '#garde .f{text-align:center;font-size:13px;opacity:.8;margin-top:18px}#garde .f a{color:inherit}';
  var html = '<div class="c"><div class="h"><img src="/app/icon-192.png" alt=""><div><h1>' + T('Installez l’app Mon accompagnateur', 'Install the Mon accompagnateur app') + '</h1>' +
    '<p class="sub">' + (ctx === 'accompagnateur' ? T('L’accès accompagnateur et Mon groupe s’ouvrent dans l’app installée.', 'Trip leader access and My group open in the installed app.') : T('Votre voyage s’ouvre dans l’app installée, avec les notifications de votre accompagnateur.', 'Your trip opens in the installed app, with your trip leader’s notifications.')) + '</p></div></div>' +
    '<div class="card">' + corps + '</div>' +
    '<div class="card" style="font-size:14px"><b>' + T('Déjà installée?', 'Already installed?') + '</b> ' + T('Fermez Safari ou Chrome et ouvrez Mon accompagnateur depuis son icône sur l’écran d’accueil : c’est là que se trouvent vos voyages et vos notifications.', 'Close Safari or Chrome and open Mon accompagnateur from its Home Screen icon: that’s where your trips and notifications are.') + '</div>' +
    '<p class="f"><a href="/confidentialite.html">' + T('Confidentialité', 'Privacy') + '</a> · <a href="/admin/?depannage=' + encodeURIComponent(location.pathname + location.search + location.hash) + '">' + T('Je suis administrateur', 'I’m an administrator') + '</a></p></div>';

  var installEv = null;
  addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEv = e; var z = document.getElementById('g-inst'); if (z) z.hidden = false; });
  function afficher() {
    // Les styles et ressources de la page ne servent plus (et ne doivent pas déborder sur cet écran)
    Array.prototype.forEach.call(document.querySelectorAll('style,link[rel=stylesheet],link[rel=preload],link[rel=preconnect],script:not([data-garde])'), function (n) { if (n.id !== 'garde-css') n.remove(); });
    if (!document.getElementById('garde-css')) { var st = document.createElement('style'); st.id = 'garde-css'; st.textContent = css; (document.head || document.documentElement).appendChild(st); }
    var b = document.body; if (!b) { b = document.createElement('body'); document.documentElement.appendChild(b); }
    b.id = 'garde'; b.className = ''; b.removeAttribute('style'); b.innerHTML = html;
    document.title = T('Installer Mon accompagnateur', 'Install Mon accompagnateur');
    if (installEv) { var z = document.getElementById('g-inst'); if (z) z.hidden = false; }
    var ib = document.getElementById('g-ib'); if (ib) ib.onclick = function () { if (!installEv) return; installEv.prompt(); installEv.userChoice.then(function () { installEv = null; document.getElementById('g-inst').hidden = true; }); };
    var cp = document.getElementById('g-cp'); if (cp) cp.onclick = function () { try { navigator.clipboard.writeText(url).then(function () { cp.textContent = T('Lien copié ✓', 'Link copied ✓'); }); } catch (e) { prompt(T('Copiez ce lien :', 'Copy this link:'), url); } };
  }
  if (document.readyState === 'loading') {
    document.write('<style>html{background:' + (dark ? '#0d141e' : '#f2f5fa') + '}</style><plaintext style="display:none">');
    document.addEventListener('DOMContentLoaded', afficher);
  } else afficher();
})();

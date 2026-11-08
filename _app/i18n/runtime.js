// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
/* Langue de l'app : anglais si le téléphone n'est pas en français (ou choix enregistré), sinon français.
   Le français est la langue du code; en anglais, ce script traduit l'affichage à la volée
   (textes et attributs), à partir du dictionnaire #i18n-en : chaînes exactes et modèles (regex).
   Le contenu écrit par l'accompagnateur (programme, annonces…) reste tel quel. */
var LANG_KEY = 'monaccompagnateur-langue';
var LANG = (function () {
  var q = null; try { q = new URLSearchParams(location.search).get('lang'); } catch (e) {}
  var p = q; if (!p) { try { p = localStorage.getItem(LANG_KEY); } catch (e) {} }
  if (p === 'fr' || p === 'en') return p;
  var l = String((navigator.languages && navigator.languages[0]) || navigator.language || 'fr').toLowerCase();
  return l.indexOf('fr') === 0 ? 'fr' : 'en';
})();
var LOC = LANG === 'en' ? 'en-CA' : 'fr-CA';
function setLang(l) { try { if (l) localStorage.setItem(LANG_KEY, l); else localStorage.removeItem(LANG_KEY); } catch (e) {} location.reload(); }
document.documentElement.lang = LANG;
var t = function (s) { return s; };
(function () {
  if (LANG !== 'en') return;
  var el = document.getElementById('i18n-en'); if (!el) return;
  var D = JSON.parse(el.textContent || '{}'), X = D.exact || {};
  var R = (D.regex || []).map(function (r) { return [new RegExp(r[0]), r[1]]; });
  function tk(k, depth) {
    if (Object.prototype.hasOwnProperty.call(X, k)) return X[k];
    if (depth > 3) return null;
    for (var i = 0; i < R.length; i++) {
      var m = k.match(R[i][0]);
      if (m) return R[i][1].replace(/\$(\d)/g, function (_, n) { var g = m[+n] || ''; var v = g.trim() ? tk(g, depth + 1) : null; return v == null ? g : v; });
    }
    // Texte composé « a · b · c » : chaque morceau est traduit séparément
    if (k.indexOf(' · ') > 0) {
      var parts = k.split(' · '), changed = false;
      for (var j = 0; j < parts.length; j++) { var pv = parts[j] ? tk(parts[j], depth + 1) : null; if (pv != null) { parts[j] = pv; changed = true; } }
      if (changed) return parts.join(' · ');
    }
    return null;
  }
  function tr(s) {
    if (!s || !/[A-Za-zÀ-ÿ]/.test(s)) return null;
    var k = s.replace(/\s+/g, ' ').trim(); var v = tk(k, 0);
    if (v == null || v === k) return null;
    var lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
    return lead + v + trail;
  }
  t = function (s) { var v = tr(String(s)); return v == null ? s : v.trim(); };
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  function node(n) {
    if (n.nodeType === 3) {
      var p = n.parentNode; if (!p || SKIP[p.nodeName] || (p.closest && p.closest('[data-no-i18n]'))) return;
      var v = tr(n.nodeValue); if (v != null && v !== n.nodeValue) n.nodeValue = v;
    } else if (n.nodeType === 1) {
      if (n.hasAttribute('data-no-i18n')) return;
      for (var i = 0; i < ATTRS.length; i++) { var a = n.getAttribute(ATTRS[i]); if (a) { var v2 = tr(a); if (v2 != null && v2 !== a) n.setAttribute(ATTRS[i], v2); } }
      if (SKIP[n.nodeName]) return;
      for (var c = n.firstChild; c; c = c.nextSibling) node(c);
    }
  }
  function run(muts) {
    muts.forEach(function (m) {
      if (m.type === 'characterData') node(m.target);
      else if (m.type === 'attributes') { var a = m.target.getAttribute(m.attributeName); var v = a && tr(a); if (v != null && v !== a) m.target.setAttribute(m.attributeName, v); }
      else m.addedNodes.forEach(node);
    });
  }
  node(document.documentElement);
  if (document.title) { var dt = tr(document.title); if (dt) document.title = dt; }
  new MutationObserver(run).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // le titre de la page change parfois après coup
  var tEl = document.querySelector('title');
  if (tEl) new MutationObserver(function () { var v = tr(document.title); if (v && v !== document.title) document.title = v; }).observe(tEl, { childList: true, characterData: true, subtree: true });
})();

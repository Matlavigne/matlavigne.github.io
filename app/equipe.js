// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
/* Mon groupe partagé entre les accompagnateurs d’un voyage, chiffré de bout en bout.

   Clé d’équipe : 32 octets aléatoires (AES-256-GCM), gardés seulement sur les téléphones des accompagnateurs.
   Chaque téléphone a sa paire de clés ECDH P-256 (partie privée non exportable, dans IndexedDB).
   La clé d’équipe passe d’un téléphone à l’autre dans une enveloppe chiffrée pour le téléphone qui la reçoit :
   le serveur ne voit que des enveloppes et la liste chiffrée.

   La liste et les présences sont gardées comme un document où chaque fiche, chaque appel et chaque coche
   porte l’heure du changement : deux téléphones qui changent la liste en même temps se fusionnent sans rien perdre. */
(function () {
  'use strict';
  const WORKER = 'https://api.monaccompagnateur.ca';
  const CHAMPS = ['genre', 'nom', 'prenom', 'cellulaire', 'naissance', 'autre', 'sousGroupe'];
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // base 32 de Crockford : pas de I, L, O ni U (O se lit 0, I et L se lisent 1)
  const enc = new TextEncoder(), dec = new TextDecoder();

  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };
  const session = () => { try { return localStorage.getItem('monaccompagnateur-session') || ''; } catch (e) { return ''; } };

  async function api(method, path, body) {
    const s = session();
    if (!s) { const e = Error('Connectez-vous dans l’accès accompagnateur.'); e.status = 401; throw e; }
    const r = await fetch(WORKER + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = Error(j.erreur || ('Erreur ' + r.status)); e.status = r.status; e.extra = j; throw e; }
    return j;
  }

  /* ---------- Encodages ---------- */
  const b64u = (u) => { let x = ''; for (let i = 0; i < u.length; i += 0x8000) x += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
  const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function sha(t) { return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof t === 'string' ? enc.encode(t) : t)); }
  function b32(u, n) { let bits = 0, val = 0, out = ''; for (const b of u) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31]; return n ? out.slice(0, n) : out; }
  function unb32(s) { const out = []; let bits = 0, val = 0; for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) throw Error('code'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }

  /* ---------- IndexedDB (même base que l’app des voyageurs) ---------- */
  function idb() { return new Promise((ok, ko) => { const r = indexedDB.open('monaccompagnateur', 1); r.onupgradeneeded = () => r.result.createObjectStore('cles'); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); }
  async function idbGet(k) { const db = await idb(); return new Promise((ok, ko) => { const r = db.transaction('cles').objectStore('cles').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); }
  async function idbSet(k, v) { const db = await idb(); return new Promise((ok, ko) => { const t = db.transaction('cles', 'readwrite'); t.objectStore('cles').put(v, k); t.oncomplete = () => ok(); t.onerror = () => ko(t.error); }); }

  /* ---------- Téléphone : paire de clés et code de vérification ---------- */
  async function empreinte(pub) { return hex((await sha(pub.x + '.' + pub.y)).slice(0, 16)); }
  async function codeDe(pub) { const c = b32(await sha('code|' + pub.x + '.' + pub.y), 6); return c.slice(0, 3) + '-' + c.slice(3); }
  function nomAppareil() { const u = navigator.userAgent; return /iPad/.test(u) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Ordinateur'; }
  let APP = null;
  async function appareil() {
    if (APP) return APP;
    let kp = await idbGet('equipe-appareil').catch(() => null);
    if (!kp) { kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']); await idbSet('equipe-appareil', kp); }
    const j = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const pub = { x: j.x, y: j.y };
    APP = { kp, pub, id: await empreinte(pub), code: await codeDe(pub) };
    return APP;
  }
  async function enregistrer(compte) {
    const a = await appareil();
    const k = 'monaccompagnateur-equipe-app';
    const fait = store.get(k, {});
    if (fait[compte] !== a.id) { await api('POST', '/api/equipe/appareil', { pub: a.pub, nom: nomAppareil() }); fait[compte] = a.id; store.set(k, fait); }
    return a;
  }

  /* ---------- Clé d’équipe ---------- */
  async function kidDe(raw) { return hex((await sha(new Uint8Array([...enc.encode('kid|'), ...raw]))).slice(0, 16)); }
  const cleLocale = (trip) => idbGet('equipe-' + trip).catch(() => null);
  const garderCle = (trip, c) => idbSet('equipe-' + trip, c);
  async function nouvelleCle() { const raw = crypto.getRandomValues(new Uint8Array(32)); return { raw, kid: await kidDe(raw) }; }
  async function envelopper(pub, cle) {
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const dev = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const k = await crypto.subtle.deriveKey({ name: 'ECDH', public: dev }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify({ kid: cle.kid, k: b64u(cle.raw) }))));
    const e = await crypto.subtle.exportKey('jwk', eph.publicKey);
    return { epk: { x: e.x, y: e.y }, iv: b64u(iv), data: b64u(data) };
  }
  async function ouvrirEnveloppe(env) {
    const a = await appareil();
    const epk = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: env.epk.x, y: env.epk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const k = await crypto.subtle.deriveKey({ name: 'ECDH', public: epk }, a.kp.privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const j = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv) }, k, unb64u(env.data))));
    const raw = unb64u(j.k);
    if (await kidDe(raw) !== j.kid) throw Error('Clé d’équipe abîmée');
    return { raw, kid: j.kid };
  }
  // Code de secours : la clé elle-même, en groupes de 4 caractères faciles à recopier
  const codeSecours = (cle) => b32(cle.raw).match(/.{1,4}/g).join('-');
  async function depuisSecours(code) {
    const s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    let raw; try { raw = unb32(s).slice(0, 32); } catch (e) { throw Error('Code de secours invalide : vérifiez les caractères.'); }
    if (s.length !== 52 || raw.length !== 32) throw Error('Code de secours incomplet : il compte 52 caractères.');
    return { raw, kid: await kidDe(raw) };
  }

  /* ---------- Chiffrement de la liste (compressée si possible) ---------- */
  async function flux(u, T) { const s = new Blob([u]).stream().pipeThrough(new T('gzip')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function chiffrer(cle, doc) {
    let u = enc.encode(JSON.stringify(doc)), z = 0;
    if (typeof CompressionStream === 'function') { try { u = await flux(u, CompressionStream); z = 1; } catch (e) { u = enc.encode(JSON.stringify(doc)); z = 0; } }
    const k = await crypto.subtle.importKey('raw', cle.raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(cle.kid) }, k, u));
    return { iv: b64u(iv), data: b64u(data), z };
  }
  async function dechiffrer(cle, b) {
    const k = await crypto.subtle.importKey('raw', cle.raw, { name: 'AES-GCM' }, false, ['decrypt']);
    let u = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(b.iv), additionalData: enc.encode(cle.kid) }, k, unb64u(b.data)));
    if (b.z) u = await flux(u, DecompressionStream);
    return JSON.parse(dec.decode(u));
  }

  /* ---------- Document fusionnable ----------
     { p: { id: {champs…, t, par, del} },
       a: { id: { nom, at, t, par, del, c: { pid: {v, t, par} }, x: { pid: {v, t, par} } } } } */
  const vide = () => ({ p: {}, a: {} });
  const plusRecent = (x, y) => !y || (x && (x.t > y.t || (x.t === y.t && String(x.par || '') > String(y.par || ''))));
  function fusionMap(A = {}, B = {}) { const o = {}; for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) o[k] = plusRecent(A[k], B[k]) ? A[k] : B[k]; return o; }
  function fusion(A, B) {
    A = A || vide(); B = B || vide();
    const out = { p: fusionMap(A.p, B.p), a: {} };
    for (const id of new Set([...Object.keys(A.a || {}), ...Object.keys(B.a || {})])) {
      const x = (A.a || {})[id], y = (B.a || {})[id];
      const m = plusRecent(x, y) ? x : y;
      out.a[id] = { ...m, c: fusionMap(x && x.c, y && y.c), x: fusionMap(x && x.x, y && y.x) };
    }
    return out;
  }
  const canon = (v) => v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}') : JSON.stringify(v);
  const egal = (a, b) => canon(a) === canon(b);

  /* Le document, vu comme les deux formats déjà utilisés par la page (liste et appels) */
  function projeter(doc, trip) {
    const voyageurs = [], qui = {};
    let maj = 0;
    for (const [id, r] of Object.entries(doc.p)) { maj = Math.max(maj, r.t || 0); if (r.del) continue; const p = { _id: id }; for (const k of CHAMPS) if (r[k] != null && r[k] !== '') p[k] = r[k]; for (const k of ['genre', 'nom', 'prenom', 'cellulaire', 'naissance', 'autre']) if (p[k] == null) p[k] = ''; voyageurs.push(p); }
    const pres = store.get(trip + '-presences-v1', null) || {};
    const appels = [];
    for (const [id, a] of Object.entries(doc.a)) {
      if (a.del) continue;
      const coches = {}, exclus = {};
      for (const [pid, c] of Object.entries(a.c || {})) if (c.v) { coches[pid] = c.t; qui[id + '|' + pid] = c; }
      for (const [pid, c] of Object.entries(a.x || {})) if (c.v) exclus[pid] = 1;
      appels.push({ id, nom: a.nom, at: a.at, coches, exclus });
    }
    appels.sort((x, y) => (y.at || 0) - (x.at || 0));
    const cur = appels.some((x) => x.id === pres.cur) ? pres.cur : (appels[0] || {}).id;
    return { groupe: { voyageurs, maj: maj || undefined }, presences: { appels, cur }, qui };
  }
  /* Changements faits sur ce téléphone (liste et appels) reportés dans le document, à l’heure actuelle */
  function reporter(doc, groupe, presences, par) {
    const now = Date.now(); let n = 0;
    const d = { p: { ...doc.p }, a: { ...doc.a } };
    const vus = new Set();
    for (const p of (groupe && groupe.voyageurs) || []) {
      if (!p._id) continue; vus.add(p._id);
      const f = {}; for (const k of CHAMPS) if (p[k] != null && p[k] !== '') f[k] = p[k];
      const r = d.p[p._id], ancien = {}; if (r && !r.del) for (const k of CHAMPS) if (r[k] != null && r[k] !== '') ancien[k] = r[k];
      if (!r || r.del || !egal(f, ancien)) { d.p[p._id] = { ...f, t: now, par }; n++; }
    }
    for (const [id, r] of Object.entries(d.p)) if (!r.del && !vus.has(id)) { d.p[id] = { del: 1, t: now, par }; n++; }
    const appVus = new Set();
    for (const a of (presences && presences.appels) || []) {
      appVus.add(a.id);
      const r = d.a[a.id];
      let m = r ? { ...r, c: { ...(r.c || {}) }, x: { ...(r.x || {}) } } : { c: {}, x: {} };
      if (!r || r.del || r.nom !== a.nom) { m = { ...m, nom: a.nom, at: a.at || now, t: now, par, del: 0 }; n++; }
      const sync = (loc, dst) => {
        for (const pid of Object.keys(loc || {})) if (!(dst[pid] && dst[pid].v)) { dst[pid] = { v: 1, t: now, par }; n++; }
        for (const [pid, c] of Object.entries(dst)) if (c.v && !(loc || {})[pid]) { dst[pid] = { v: 0, t: now, par }; n++; }
      };
      sync(a.coches, m.c); sync(a.exclus, m.x);
      d.a[a.id] = m;
    }
    for (const [id, a] of Object.entries(d.a)) if (!a.del && !appVus.has(id)) { d.a[id] = { ...a, del: 1, t: now, par }; n++; }
    return { doc: d, n };
  }
  /* Premier partage depuis un téléphone qui avait déjà sa propre liste : les mêmes personnes (même nom) ne sont pas doublées */
  function rapprocher(local, distant) {
    const cle = (r) => String([r.prenom, r.nom].join(' ')).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const parNom = {}; for (const [id, r] of Object.entries(distant.p)) if (!r.del) parNom[cle(r)] = id;
    const ren = {}; const p = {};
    for (const [id, r] of Object.entries(local.p)) { if (r.del) continue; const d = parNom[cle(r)]; if (d && d !== id) ren[id] = d; else p[id] = r; }
    const a = {};
    for (const [id, x] of Object.entries(local.a)) { const c = {}, xx = {}; for (const [pid, v] of Object.entries(x.c || {})) c[ren[pid] || pid] = v; for (const [pid, v] of Object.entries(x.x || {})) xx[ren[pid] || pid] = v; a[id] = { ...x, c, x: xx }; }
    return { p, a };
  }

  /* ---------- Synchronisation ---------- */
  const K = (trip) => ({ doc: trip + '-groupe-doc-v1', sync: trip + '-groupe-sync-v1', grp: trip + '-groupe-local-v1', pres: trip + '-presences-v1' });
  function docLocal(trip) {
    const k = K(trip);
    let d = store.get(k.doc, null);
    if (!d || !d.p) {
      // Première fois : la liste et les appels déjà sur ce téléphone deviennent le document
      d = reporter(vide(), store.get(k.grp, null), store.get(k.pres, null), '').doc;
      store.set(k.doc, d);
    }
    return d;
  }
  function ecrireLocal(trip, doc) {
    const k = K(trip);
    store.set(k.doc, doc);
    const pr = projeter(doc, trip);
    store.set(k.grp, pr.groupe);
    store.set(k.pres, pr.presences);
    return pr;
  }
  /* À appeler après chaque changement fait dans la page (liste, appel, coche) */
  function noterChangement(trip, compte) {
    const k = K(trip);
    const r = reporter(docLocal(trip), store.get(k.grp, null), store.get(k.pres, null), compte || '');
    if (!r.n) return false;
    store.set(k.doc, r.doc);
    const s = store.get(k.sync, {}); s.sale = true; store.set(k.sync, s);
    return true;
  }
  const quiACoche = (trip) => projeter(docLocal(trip), trip).qui;

  let enCours = null, MOI = null;
  /* opts.creer : créer la clé d’équipe si personne ne l’a encore (seulement depuis Mon groupe) */
  function synchroniser(trip, opts) { if (enCours) return enCours; enCours = sync1(trip, opts || {}).finally(() => { enCours = null; }); return enCours; }
  async function sync1(trip, opts) {
    let moi = MOI;
    if (!moi) try { moi = MOI = (await api('GET', '/api/auth/moi')).profil; } catch (e) { if (e.status === 401) return { mode: 'local', raison: 'connexion' }; return { mode: 'horsligne', erreur: e.message }; }
    const a = await enregistrer(moi.username);
    const k = K(trip);
    let eq;
    try { eq = await api('GET', '/api/equipe?trip=' + encodeURIComponent(trip) + '&appareil=' + a.id); }
    catch (e) {
      if (e.status === 403 || e.status === 404) {
        // Retiré du voyage (ou voyage supprimé) : la liste partagée qui était sur ce téléphone en est effacée
        if (store.get(k.sync, {}).joint) { for (const x of [k.doc, k.sync, k.grp, k.pres]) try { localStorage.removeItem(x); } catch (z) { } try { await idbSet('equipe-' + trip, null); } catch (z) { } return { mode: 'local', raison: 'retire', moi, efface: true }; }
        return { mode: 'local', raison: 'membre', moi };
      }
      if (e.status === 428) return { mode: 'local', raison: '2fa', moi }; return { mode: 'horsligne', erreur: e.message, moi };
    }
    const base = { moi, appareil: a, membres: eq.membres, appareils: eq.appareils };
    let cle = await cleLocale(trip);

    // Pas encore de liste partagée : on crée la clé (une seule fois, depuis Mon groupe)
    if (!eq.kid) {
      if (!opts.creer) return { ...base, mode: 'aucune' };
      cle = await nouvelleCle();
      const doc = docLocal(trip);
      try {
        const r = await api('PUT', '/api/groupe', { trip, base: 0, kid: cle.kid, blob: await chiffrer(cle, doc), cles: [{ appareil: a.id, env: await envelopper(a.pub, cle) }] });
        await garderCle(trip, cle);
        store.set(k.sync, { version: r.version, kid: cle.kid, sale: false, maj: Date.now(), joint: true });
        return { ...base, mode: 'equipe', cle, creee: true, ...(await infos(trip, cle, a)) };
      } catch (e) { if (e.status !== 409) throw e; return sync1(trip, { ...opts, creer: false }); }
    }

    // Clé d’équipe pour ce téléphone (reçue d’un collègue) ou toujours en attente
    if (!cle || cle.kid !== eq.kid) {
      if (eq.cle) { cle = await ouvrirEnveloppe(eq.cle); if (cle.kid !== eq.kid) throw Error('Clé d’équipe inattendue'); await garderCle(trip, cle); }
      else return { ...base, mode: 'attente', kid: eq.kid };
    }

    // Échanges avec la copie chiffrée du serveur (fusion, puis envoi s’il y a du nouveau)
    for (let essai = 0; essai < 4; essai++) {
      const st = store.get(k.sync, {});
      const g = await api('GET', '/api/groupe?trip=' + encodeURIComponent(trip) + '&depuis=' + (st.kid === eq.kid && st.joint ? (st.version || 0) : -1));
      let doc = docLocal(trip), distant = null;
      if (!g.inchange && g.blob) {
        if (g.kid !== cle.kid) { if (essai < 3) { const e2 = await api('GET', '/api/equipe?trip=' + encodeURIComponent(trip) + '&appareil=' + a.id); if (e2.cle) { cle = await ouvrirEnveloppe(e2.cle); await garderCle(trip, cle); continue; } } return { ...base, mode: 'attente', kid: g.kid }; }
        distant = await dechiffrer(cle, g.blob);
        if (!st.joint) doc = rapprocher(doc, distant);
        doc = fusion(doc, distant);
      }
      const doitEnvoyer = distant ? !egal(doc, fusion(distant, vide())) : !!st.sale;
      const rotation = eq.rotation && essai === 0;
      if (!doitEnvoyer && !rotation) {
        ecrireLocal(trip, doc);
        store.set(k.sync, { version: g.version, kid: cle.kid, sale: false, maj: Date.now(), joint: true });
        return { ...base, mode: 'equipe', cle, change: !!distant, ...(await infos(trip, cle, a, eq)) };
      }
      let corps = { trip, base: g.version, kid: cle.kid };
      let cleEnvoi = cle;
      if (rotation) {
        // Un accompagnateur a été retiré : nouvelle clé, remise aux téléphones de l’équipe qui avaient la précédente
        cleEnvoi = await nouvelleCle();
        const dest = eq.appareils.filter((x) => x.cle || x.id === a.id);
        corps = { ...corps, kid: cleEnvoi.kid, cles: await Promise.all(dest.map(async (x) => ({ appareil: x.id, env: await envelopper(x.pub, cleEnvoi) }))) };
      }
      corps.blob = await chiffrer(cleEnvoi, doc);
      try {
        const r = await api('PUT', '/api/groupe', corps);
        if (rotation) { await garderCle(trip, cleEnvoi); cle = cleEnvoi; eq.rotation = false; }
        ecrireLocal(trip, doc);
        store.set(k.sync, { version: r.version, kid: cle.kid, sale: false, maj: Date.now(), joint: true });
        return { ...base, mode: 'equipe', cle, change: !!distant, envoye: true, rotation, ...(await infos(trip, cle, a, rotation ? null : eq)) };
      } catch (e) {
        if (e.status !== 409) throw e;
        // Quelqu’un a écrit entre-temps : on reprend, fusionne et renvoie
        ecrireLocal(trip, doc); const s2 = store.get(k.sync, {}); s2.sale = true; s2.version = -1; store.set(k.sync, s2);
      }
    }
    return { ...base, mode: 'equipe', cle, ...(await infos(trip, cle, a)), erreur: 'La liste change beaucoup en ce moment : réessai dans quelques secondes.' };
  }
  // Téléphones de l’équipe qui attendent la clé, avec leur code de vérification
  async function infos(trip, cle, a, eq) {
    if (!eq) eq = await api('GET', '/api/equipe?trip=' + encodeURIComponent(trip) + '&appareil=' + a.id).catch(() => null);
    if (!eq) return {};
    const attente = [];
    for (const x of eq.appareils) if (!x.cle && x.id !== a.id) attente.push({ ...x, code: await codeDe(x.pub), nomCompte: (eq.membres.find((m) => m.username === x.username) || {}).nom || x.username });
    return { membres: eq.membres, appareils: eq.appareils, attente, maj: eq.maj, majPar: eq.majPar };
  }
  async function donnerCle(trip, appareils) {
    const cle = await cleLocale(trip);
    if (!cle) throw Error('Ce téléphone n’a pas la clé d’équipe.');
    return api('POST', '/api/equipe/cles', { trip, kid: cle.kid, cles: await Promise.all(appareils.map(async (x) => ({ appareil: x.id, env: await envelopper(x.pub, cle) }))) });
  }
  async function utiliserSecours(trip, code) {
    const cle = await depuisSecours(code);
    const a = await appareil();
    const eq = await api('GET', '/api/equipe?trip=' + encodeURIComponent(trip) + '&appareil=' + a.id);
    if (eq.kid && eq.kid !== cle.kid) throw Error('Ce code de secours n’ouvre pas la liste actuelle de ce voyage.');
    await garderCle(trip, cle);
    // On se remet la clé à soi-même pour la retrouver sur ce téléphone et la voir comme reçue
    if (eq.kid) await api('POST', '/api/equipe/cles', { trip, kid: cle.kid, cles: [{ appareil: a.id, env: await envelopper(a.pub, cle) }] });
    return cle;
  }

  window.Equipe = { synchroniser, noterChangement, donnerCle, utiliserSecours, codeSecours, cleLocale, appareil, quiACoche, codeDe, docLocal, ecrireLocal,
    _t: { fusion, reporter, projeter, rapprocher, chiffrer, dechiffrer, nouvelleCle, depuisSecours, kidDe } };
})();

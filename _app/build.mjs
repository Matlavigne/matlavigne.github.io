#!/usr/bin/env node
// Copyright © 2026 Mathieu Lavigne. Tous droits réservés. Voir LICENSE.
// Génère les fichiers de chaque voyage à partir du gabarit commun et de la fiche de sa station.
//
//   node _app/build.mjs                 tous les voyages
//   node _app/build.mjs st-anton-mars2027   un seul voyage
//
// Fichiers générés dans chaque dossier de voyage (ne pas les modifier à la main) :
//   index.html, editeur.html, installer.html, affiche-bagages.html, sw.js, manifest.webmanifest
// Jamais touchés : voyage.json, images et icônes (propres à chaque voyage).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP, "..");
const SITE = "https://monaccompagnateur.ca";
const DEPOT = { owner: "Matlavigne", repo: "matlavigne.github.io" };
// Réglages du site : adresse du Worker des alertes (vide = alertes désactivées)
const CONFIG = fs.existsSync(path.join(APP, "config.json")) ? JSON.parse(fs.readFileSync(path.join(APP, "config.json"), "utf8")) : {};
const PUSH = String(CONFIG.pushWorker || "").replace(/\/+$/, "");
const GABARITS = ["index.html", "editeur.html", "installer.html", "affiche-bagages.html", "manifest.webmanifest", "sw.js"];

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const embed = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const jsStr = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const lien = (l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.titre)} ↗</a>`;

function versionNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// ---------- vérification de la fiche station ----------
function checkStation(S, file) {
  const err = [];
  for (const k of ["id", "nom", "lieu", "pays", "paysEn", "fuseau", "fuseauNom", "decalageTexte", "prise", "domaines", "domaineDefaut", "urgences", "faits", "langue", "sources"])
    if (S[k] == null) err.push(`champ manquant : ${k}`);
  const doms = Object.keys(S.domaines || {});
  if (!doms.length) err.push("aucun domaine");
  if (S.domaineDefaut && !doms.includes(S.domaineDefaut)) err.push(`domaineDefaut inconnu : ${S.domaineDefaut}`);
  if (doms.length > 1 && !S.tousNom) err.push("tousNom requis avec plusieurs domaines");
  for (const [k, d] of Object.entries(S.domaines || {})) {
    if (!d.nom) err.push(`domaine ${k} : nom manquant`);
    if (!Array.isArray(d.bounds) || d.bounds.length !== 2) err.push(`domaine ${k} : bounds invalide`);
    if (d.secteur) try { new RegExp(d.secteur, "i"); } catch (e) { err.push(`domaine ${k} : secteur invalide (${e.message})`); }
    const shared = doms.filter((j) => S.domaines[j].feed && S.domaines[j].feed === d.feed).length > 1;
    if (shared && !d.secteur) err.push(`domaine ${k} : flux partagé, il faut une expression « secteur »`);
  }
  try { new Intl.DateTimeFormat("fr", { timeZone: S.fuseau }); } catch { err.push(`fuseau inconnu : ${S.fuseau}`); }
  for (const p of S.meteo?.points || []) if (typeof p.lat !== "number" || typeof p.lng !== "number" || !doms.includes(p.domaine)) err.push(`point météo invalide : ${p.nom}`);
  for (const c of S.webcams || []) if (!doms.includes(c.domaine)) err.push(`webcam ${c.nom} : domaine inconnu ${c.domaine}`);
  for (const a of S.pistesSuggerees ? Object.keys(S.pistesSuggerees) : []) if (!doms.includes(a)) err.push(`pistes suggérées : domaine inconnu ${a}`);
  const ids = new Set();
  for (const a of S.adresses || []) {
    if (!a.id) err.push(`adresse sans id : ${a.nom}`);
    else if (ids.has(a.id)) err.push(`adresse en double : ${a.id}`); else ids.add(a.id);
    if (a.domaine && !doms.includes(a.domaine)) err.push(`adresse ${a.id} : domaine inconnu`);
  }
  if (err.length) throw new Error(`${file} :\n  - ${err.join("\n  - ")}`);
}

// ---------- blocs HTML tirés de la fiche ----------
function blocs(S) {
  const tels = S.urgences.numeros.map((n) =>
    `    <div class="tel"><span><b>${esc(n.nom)}</b>${n.detail ? `<br><span class="small">${esc(n.detail)}</span>` : ""}</span><a${n.secondaire ? ' class="soft"' : ""} href="tel:${esc(n.tel)}">${esc(n.affiche)}</a></div>`);
  if (S.urgences.note) tels.push(`    <p class="small" style="margin-top:8px">${S.urgences.note}</p>`);
  const av = S.avalanche?.liens || [];
  const avLinks = av.map((l) => `<a class="btn light" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.titre)} ↗</a>`).join("");
  return {
    URGENCES: tels.join("\n"),
    FAITS: S.faits.map((f) => `    <div class="fact"><strong>${esc(f.titre)}</strong><span>${esc(f.texte)}</span></div>`).join("\n"),
    PHRASES: S.langue.phrases.map(([a, b]) => `      <tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("\n"),
    LANGUE_TITRE: esc(S.langue.titre),
    AVALANCHE_TEXTE: `      <p><b>Risque d’avalanche</b> : ${S.avalanche?.texte || "consultez chaque matin le bulletin officiel, surtout avant de sortir des pistes balisées."}</p>`,
    AVALANCHE_LIENS: av.length === 1 ? `      <p>${avLinks}</p>` : av.length ? `      <p class="row" style="gap:8px;flex-wrap:wrap">${avLinks}</p>` : "",
    NEIGE_LIEN: S.neige ? lien(S.neige) : "",
    PLAN_LIEN: S.planLien ? lien(S.planLien) : "",
    PAYS_EN: esc(S.paysEn),
    FUSEAU_NOM: esc(S.fuseauNom),
    DECALAGE_TEXTE: esc(S.decalageTexte),
    CASIER: esc(S.casierExemple || "casier 214"),
    LIEU: esc(S.lieu),
    WEBCAMS_SOURCES: esc(S.sources.webcamsPhrase || "des domaines"),
    SOURCES_PISTES: esc(S.sources.pistes || "Intermaps"),
    SOURCES_WEBCAMS: esc(S.sources.webcams || "les stations"),
  };
}

function build(tripId, version) {
  const T = readJson(path.join(APP, "voyages", `${tripId}.json`));
  const stationFile = path.join(APP, "stations", `${T.station}.json`);
  const S = readJson(stationFile);
  checkStation(S, path.relative(ROOT, stationFile));

  const dir = path.join(ROOT, T.id);
  fs.mkdirSync(dir, { recursive: true });
  let defaut = {};
  const vPath = path.join(dir, "voyage.json");
  if (fs.existsSync(vPath)) { defaut = readJson(vPath); delete defaut.chiffre; }
  else defaut = { titre: T.titre, datesTexte: T.dates };

  const { pistesSuggerees, ...stationPublic } = S;
  const ski = { picks: pistesSuggerees || {}, plans: Object.fromEntries(Object.entries(S.domaines).map(([k, d]) => [k, d.plan || ""])) };
  const trip = { id: T.id, titre: T.titre, depot: DEPOT, push: PUSH };

  // Traduction anglaise : dictionnaire commun + dictionnaire de la station (+ celui du voyage s'il existe)
  const dico = { exact: {}, regex: [] };
  for (const f of [path.join(APP, "i18n", "en.json"), path.join(APP, "i18n", "stations", `${T.station}.json`), path.join(APP, "i18n", "voyages", `${T.id}.json`)]) {
    if (!fs.existsSync(f)) continue;
    const d = readJson(f);
    Object.assign(dico.exact, d.exact || {});
    dico.regex.push(...(d.regex || []));
  }
  for (const [re] of dico.regex) new RegExp(re); // une regex invalide arrête la génération
  const tokens = {
    ...blocs(S),
    LANG_DICO: embed(dico), LANG_SCRIPT: fs.readFileSync(path.join(APP, "i18n", "runtime.js"), "utf8"),
    ID: esc(T.id), TITRE: esc(T.titre), DATES: esc(T.dates), APP_COURT: esc(T.appCourt), APP_COURT_JS: jsStr(T.appCourt),
    NOM_APP: esc(T.nomApp || T.titre), PIED: esc(T.pied || T.appCourt),
    DESCRIPTION: esc(T.description), OG_DESCRIPTION: esc(T.ogDescription || T.description),
    URL: `${SITE}/${T.id}/`, CREDIT: T.credit || "", VERSION: version,
    DEFAUT_JSON: embed(defaut), SKI_JSON: embed(ski), STATION_JSON: embed(stationPublic), TRIP_JSON: embed(trip),
    AFFICHE_JSON: embed(T.affiche || { titre: T.titre, sousDates: T.dates }),
    CACHE: T.cache || `voyage-${T.id}`,
    PUSH_WORKER: jsStr(PUSH),
    ICONES_V: (() => { const hi = crypto.createHash("sha256"); for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) if (fs.existsSync(path.join(dir, f))) hi.update(fs.readFileSync(path.join(dir, f))); return hi.digest("hex").slice(0, 8); })(),
  };

  const out = {};
  for (const g of GABARITS.filter((g) => g !== "sw.js")) out[g] = fill(fs.readFileSync(path.join(APP, "gabarit", g), "utf8"), tokens, g);
  // La version du cache change dès qu'un fichier généré ou un fichier du voyage change
  const h = crypto.createHash("sha256");
  for (const g of Object.keys(out).sort()) h.update(sansVersion(out[g]));
  for (const f of ["hero.webp", "og.jpg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) if (fs.existsSync(path.join(dir, f))) h.update(fs.readFileSync(path.join(dir, f)));
  out["sw.js"] = fill(fs.readFileSync(path.join(APP, "gabarit", "sw.js"), "utf8"), { ...tokens, HASH: h.digest("hex").slice(0, 8) }, "sw.js");

  let changed = 0;
  for (const [g, s] of Object.entries(out)) {
    const p = path.join(dir, g);
    const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    // On ne réécrit pas un fichier dont seule la ligne de version changerait
    if (prev !== null && sansVersion(prev) === sansVersion(s)) continue;
    fs.writeFileSync(p, s); changed++;
  }
  console.log(`${T.id} (${S.nom}) : ${changed ? `${changed} fichier(s) mis à jour` : "à jour"}`);
}

// La ligne « Version de l’app » ne compte pas comme un changement
const sansVersion = (x) => x.replace(/Version de l’app : [0-9: -]+/, "");

function fill(src, tokens, name) {
  const s = src.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in tokens)) throw new Error(`${name} : jeton inconnu ${m}`);
    return tokens[k];
  });
  return s;
}

const only = process.argv[2];
const ids = fs.readdirSync(path.join(APP, "voyages")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
if (only && !ids.includes(only)) { console.error(`Voyage inconnu : ${only}. Voyages : ${ids.join(", ")}`); process.exit(1); }
const version = versionNow();
let failed = false;
for (const id of only ? [only] : ids) {
  try { build(id, version); } catch (e) { failed = true; console.error(`ERREUR ${id} : ${e.message}`); }
}
// Liste publique des voyages pour l'app « Mes voyages » des voyageurs (identifiants et noms seulement, jamais le contenu)
if (!only) {
  const liste = ids.map((id) => { const T = readJson(path.join(APP, "voyages", `${id}.json`)); return { id, appCourt: T.appCourt, titre: T.titre }; });
  const lp = path.join(ROOT, "mes-voyages", "liste.json");
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const txt = JSON.stringify({ voyages: liste }, null, 1) + "\n";
  if (!fs.existsSync(lp) || fs.readFileSync(lp, "utf8") !== txt) { fs.writeFileSync(lp, txt); console.log("mes-voyages/liste.json mis à jour"); }
}
process.exit(failed ? 1 : 0);

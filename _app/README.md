# Apps de voyage : code commun et bibliothèque de stations

Toutes les apps de voyage partagent **un seul code**. Chaque voyage n'est qu'un dossier du site (`/solden-voyage-2027/`, `/st-anton-mars2027/`…) avec son contenu, et chaque station a **une fiche** réutilisable par tous les voyages qui y vont.

```
_app/
  gabarit/            le code commun (index, éditeur, installation, affiche, service worker, manifeste)
  stations/           une fiche par station : soelden.json, stanton.json…
  voyages/            une fiche par voyage : titre, dates, station, textes de partage
  build.mjs           génère les fichiers de chaque voyage
solden-voyage-2027/   ← dossier publié du voyage
  voyage.json         contenu du voyage (éditeur), chiffré par la phrase
  hero.webp, og.jpg, icônes
  index.html, editeur.html, … ← GÉNÉRÉS, ne pas modifier à la main
```

Le dossier `_app` n'est pas publié par GitHub Pages, car les dossiers qui commencent par `_` sont ignorés.

## Les trois couches

1. **Fiche de la station** (`_app/stations/<id>.json`). Elle contient :
   - les domaines et leurs flux Intermaps, avec les limites de carte et le plan officiel ;
   - les points météo et les webcams ;
   - les pistes suggérées ;
   - la neige, les avalanches et les urgences du pays ;
   - les faits pratiques, les phrases utiles et la prise électrique ;
   - les adresses de base, avec un `id` chacune.
2. **Fiche du voyage** (`_app/voyages/<id>.json`). Elle contient la station choisie, le titre, les dates, le nom court de l'app, les textes de partage et le crédit de la photo.
3. **Contenu de l'accompagnateur** (`<id>/voyage.json`, rempli avec l'éditeur). Il contient le programme, les annonces, l'hôtel, les vols, les bagages et ses adresses. Pour les adresses de la station :
   - `{ "ref": "id-station", "masquer": true }` retire une adresse de la station ;
   - `{ "ref": "id-station", "coupDeCoeur": true, "description": "…" }` la modifie ;
   - une adresse sans `ref` s'ajoute à la liste.

   Les points météo et les webcams du voyage, s'il y en a, remplacent ceux de la station.

## Générer après une modification

Après avoir changé le gabarit ou une fiche (station ou voyage) :

```bash
node _app/build.mjs                       # tous les voyages
node _app/build.mjs st-anton-mars2027     # un seul
```

Puis faites un commit des dossiers modifiés. Le script :
- vérifie la fiche de la station (champs requis, domaines, fuseau, expressions de secteur, points météo, webcams) et refuse de générer si quelque chose cloche ;
- ne réécrit que les fichiers dont le contenu change ;
- change le numéro de cache du service worker seulement dans ce cas, ce qui oblige les téléphones à prendre la nouvelle version.

L'éditeur, lui, n'écrit que `voyage.json` : aucune génération n'est nécessaire pour publier une annonce.

## Ajouter une station

1. Copier une fiche existante dans `_app/stations/<nouvel-id>.json`.
2. Remplacer les domaines. Un domaine a `nom`, `feed` (le flux Intermaps `…/data?lang=en`), `bounds` (les coins sud-ouest et nord-est de la carte), `plan` (le plan officiel intégrable) et `meteoNom`.
   - Si plusieurs domaines partagent **le même flux** (comme Ski Arlberg), chacun doit avoir une expression `secteur` : la liste des noms de remontées et de pistes qui lui appartiennent.
   - Sans flux Intermaps, laissez `feed` vide : l'onglet Ski affiche alors seulement le plan et le lien officiel.
   - `etatLien` (facultatif) : page officielle de l'état des remontées, proposée quand l'état en direct manque.
3. Indiquer `devises` : les codes des monnaies du séjour, par exemple `["CHF", "EUR"]`. Le convertisseur de l’onglet Infos les compare au dollar canadien.
4. Remplacer les points météo, les webcams, la neige, l'avalanche, les urgences et les faits. Pour un autre pays, il faut aussi le fuseau, la prise électrique et les phrases utiles.
5. Lancer `node _app/build.mjs` : les erreurs de la fiche s'affichent.

## Ajouter un voyage

1. Créer `_app/voyages/<id>.json` à partir d'un voyage existant, avec `station` réglé sur l'id de la fiche.
2. Créer le dossier `<id>/` avec `hero.webp`, `og.jpg` et les icônes. `voyage.json` peut être copié d'un voyage précédent, puis vidé dans l'éditeur.
3. Lancer `node _app/build.mjs <id>`, puis faire un commit.
4. L'app est à `https://monaccompagnateur.ca/<id>/`, et l'éditeur à `…/<id>/editeur.html`.

## Éditeur

Les accompagnateurs se connectent dans « Connexion pour publier » avec leur compte (nom d'usager, mot de passe, code de double authentification au besoin); voir `push-worker/README.md`, section « Comptes ».

Tous les voyages sont dans le dépôt `Matlavigne/matlavigne.github.io`. L'éditeur écrit dans `<id>/voyage.json`. Le dépôt et le dossier sont fixés : ils ne se saisissent plus.

Le jeton GitHub doit avoir le droit *Contents : Read and write* sur `matlavigne.github.io`. Un jeton limité à l'ancien dépôt du voyage ne suffit plus.

## Passage depuis les anciens dépôts (une seule fois)

Les anciens dépôts `solden-voyage-2027` et `st-anton-mars2027` publient encore leur propre site à la même adresse. Un site de dépôt l'emporte sur le dossier du même nom dans `matlavigne.github.io`. Après la fusion de cette branche dans `main` :

1. Dans chacun des deux anciens dépôts : **Settings → Pages → Unpublish site** (ou mettre la source à « None »).
2. Attendre une ou deux minutes, puis ouvrir `https://monaccompagnateur.ca/solden-voyage-2027/?verif`.
3. Archiver les anciens dépôts (**Settings → Archive**) pour ne plus les modifier par erreur.

Les adresses, les phrases du voyage, le contenu chiffré et la clé accompagnateur ne changent pas.

## Liste du groupe

Aucune donnée des voyageurs n'est dans le dépôt. La liste du groupe se gère dans l'app, sur le téléphone de l'accompagnateur (Infos › Accès accompagnateur) : import d'un CSV (Genre ; Nom ; Prénom ; Cellulaire ; Date de naissance ; Autre) ou saisie à la main. Elle est gardée dans le stockage local du téléphone et n'est jamais envoyée sur Internet.

## Icônes

Les icônes d'écran d'accueil de chaque voyage (montagne de la station, nom, année) se génèrent avec `python3 _app/icones/icones.py` (Chrome et la police Inter requis), puis `node _app/build.mjs` pour que les apps les rechargent. Pour une nouvelle station, ajoutez sa silhouette dans `MONTAGNES` du script. Champs facultatifs du voyage : `iconeNom`, `iconeAnnee`.

## Anglais

L'app et la page d'installation s'affichent en anglais quand le téléphone n'est pas en français (choix modifiable dans Infos › Langue · Language; `?lang=en` pour tester). Le code reste en français : `_app/i18n/runtime.js` traduit l'affichage à partir des dictionnaires, chaînes exactes et modèles (regex, groupes traduits à leur tour; un texte « a · b · c » est traduit morceau par morceau).

- `_app/i18n/en.json` : interface commune.
- `_app/i18n/stations/<station>.json` : textes de la fiche de station (urgences, faits, phrases utiles, points météo, webcams).
- `_app/i18n/voyages/<voyage>.json` : dates et crédits propres au voyage.

Le contenu de l'accompagnateur (programme, annonces, hôtel…) et les descriptions des pistes et restos restent tels qu'écrits. Pour une nouvelle station, ajoutez son fichier dans `stations/`; une chaîne absente du dictionnaire reste simplement en français.

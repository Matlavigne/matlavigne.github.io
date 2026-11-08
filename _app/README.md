# monaccompagnateur.ca : site et apps

Ce dossier contient le code commun des apps de voyage et les fiches des stations et des voyages. Le serveur (comptes, alertes, accès, publication) est décrit dans [`push-worker/README.md`](push-worker/README.md).

## Vue d'ensemble

```
monaccompagnateur.ca (GitHub Pages, ce dépôt)          api.monaccompagnateur.ca (Worker Cloudflare + base D1)
├── /                  page d'accueil (voyages.json)    ├── comptes, double authentification, sessions
├── /app/              app unique « Mon accompagnateur » ├── publication de <voyage>/voyage.json sur GitHub
│   ├── index.html         Mes voyages (voyageurs)      ├── alertes (notifications web) et calendrier
│   ├── accompagnateur.html accès accompagnateur        ├── demandes d'accès (approbation)
│   ├── groupe.html        Mon groupe                   └── Mon groupe : copie chiffrée, enveloppes de clé
│   ├── equipe.js          clé d'équipe, chiffrement, synchronisation de Mon groupe
│   ├── garde.js           installation obligatoire sur téléphone
│   └── sw.js              service worker (cache, notifications, pastille)
├── /admin/            administration (comptes, voyages)
├── /<voyage>/         app d'un voyage (GÉNÉRÉE) : index, editeur, installer, affiche, voyage.json chiffré
└── _app/              ce dossier (non publié : GitHub Pages ignore les dossiers qui commencent par « _ »)
    ├── gabarit/           code commun des apps de voyage
    ├── stations/          une fiche par station
    ├── voyages/           une fiche par voyage (+ photos/)
    ├── i18n/              dictionnaires anglais
    ├── icones/            préparation des icônes et des photos (robot)
    ├── build.mjs          génère les dossiers des voyages
    └── push-worker/       le serveur
```

**Une seule app installée.** Le manifeste `/app/manifest.webmanifest` a la portée « / » : les apps des voyages, l'accès accompagnateur, Mon groupe, l'éditeur et l'administration s'ouvrent tous dans la même app d'écran d'accueil. C'est essentiel sur iPhone, où chaque app installée et Safari gardent des données séparées (clés, session, liste du groupe).

| Qui | Où | Quoi |
|---|---|---|
| Voyageur | `/app/` | ses voyages; « Ajouter un voyage » : demande d'accès (approbation) ou phrase du voyage |
| Accompagnateur | `/app/accompagnateur.html` (roue dentée › Accès accompagnateur) | ses voyages, demandes d'accès, Mon groupe, éditeur, profil, alertes des demandes |
| Administrateur | `/admin/` (bouton « Administration ») | comptes, création, photo, accompagnateurs, clôture, suppression des voyages |

## Les trois couches d'un voyage

1. **Fiche de la station** (`_app/stations/<id>.json`). Elle contient :
   - les domaines et leurs flux Intermaps, avec les limites de carte et le plan officiel ;
   - les points météo, les webcams et les pistes suggérées ;
   - la neige, les avalanches et les urgences du pays ;
   - les faits pratiques, les phrases utiles et la prise électrique ;
   - les adresses de base, avec un `id` chacune.
2. **Fiche du voyage** (`_app/voyages/<id>.json`). Elle contient la station, le titre, les dates, le nom court de l'app, les textes de partage et le crédit de la photo. Elle est écrite par l'administration.
3. **Contenu du voyage** (`<id>/voyage.json`, rempli avec l'éditeur). Il contient le programme, les annonces, l'hôtel, les vols, les bagages, les accompagnateurs et les adresses. Tout ce contenu est **chiffré avec la phrase du voyage** (PBKDF2 600 000 tours, AES-256-GCM) dans le navigateur avant la publication. Seuls le titre, les dates, la météo, les webcams et les plans restent publics. Pour les adresses de la station :
   - `{ "ref": "id-station", "masquer": true }` retire une adresse de la station ;
   - `{ "ref": "id-station", "coupDeCoeur": true, "description": "…" }` la modifie ;
   - une adresse sans `ref` s'ajoute.

   Les points météo et les webcams du voyage remplacent ceux de la station.

## Générer les apps

Un robot GitHub (`.github/workflows/generer-apps.yml`) génère les apps à chaque poussée qui touche `_app/` :
- il prépare les images (photo recadrée ou illustration, icônes) avec `_app/icones/preparer.py` ;
- il lance `node _app/build.mjs` ;
- il publie le résultat.

Pour générer à la main :

```bash
node _app/build.mjs                       # tous les voyages
node _app/build.mjs solden-voyage-2027    # un seul
```

Le script :
- vérifie la fiche de la station et refuse de générer si quelque chose cloche ;
- ne réécrit que les fichiers qui changent ;
- change alors le numéro de cache du service worker, pour que les téléphones prennent la nouvelle version ;
- écrit `app/liste.json` (identifiants et noms des voyages, pour « Ajouter un voyage »).

Les jetons `{{NOM}}` du gabarit ne contiennent pas de chiffres. L'éditeur n'écrit que `voyage.json` : publier une annonce ne demande aucune génération.

## Ajouter un voyage ou une station

- **Voyage** : `monaccompagnateur.ca/admin` › Nouveau voyage. L'administration chiffre le contenu de départ, écrit la fiche, la photo et l'entrée de la page d'accueil en un seul commit, puis le robot génère l'app en 2 à 4 minutes. Ouvrez ensuite l'accès accompagnateur une fois : ça crée la clé d'équipe du voyage, qui sert à chiffrer les noms des demandes d'accès.
- **Station** (à la main) :
  1. Copiez une fiche dans `_app/stations/<id>.json`.
  2. Remplacez les domaines. Un domaine a `nom`, `feed` (le flux Intermaps `…/data?lang=en`, vide s'il n'y en a pas), `bounds`, `plan` et `meteoNom`.
     - Si plusieurs domaines partagent un même flux, chacun a une expression `secteur`.
     - `etatLien` (facultatif) pointe vers la page officielle de l'état des remontées.
  3. Indiquez `devises` (par exemple `["CHF", "EUR"]`) et remplacez la météo, les webcams, la neige, l'avalanche, les urgences et les faits. Pour un autre pays, ajoutez aussi le fuseau, la prise et les phrases.
  4. Ajoutez le dictionnaire `_app/i18n/stations/<id>.json` et la silhouette de la montagne dans `MONTAGNES` de `_app/icones/icones.py`.
  5. Lancez `node _app/build.mjs` : les erreurs de la fiche s'affichent. La station apparaît ensuite dans l'administration.

## Éditeur

`/<voyage>/editeur.html`, ouvert depuis l'accès accompagnateur :
- **Connexion pour publier** : se fait avec un compte (nom d'usager, mot de passe, double authentification). Chaque compte ne publie que ses voyages.
- **Phrase du voyage** : gardée sur l'appareil, elle sert à chiffrer et à ouvrir le contenu.
- **Tableau de bord** : tuiles et « Prêt pour le départ ».
- **Contenu** : programme en ligne du temps, carte avec pistes pour placer un point, annonces programmées. Les annonces déclenchent les alertes à la publication.
- **Accompagnateurs** : coordonnées reprises de leurs comptes.

## Données gardées sur le téléphone

| Clé (localStorage, sauf mention) | Contenu |
|---|---|
| `<voyage>-cle-v1` | clé de déchiffrement du voyage (`{salt, k}`) |
| `<voyage>-donnees-v1`, `-documents-v1` | contenu déchiffré gardé pour l'ouverture hors ligne |
| `monaccompagnateur-mes-voyages`, `-demandes`, `-acces` | liste des voyages, demandes d'accès en cours, accès approuvés (pour un retrait ou une nouvelle clé) |
| `monaccompagnateur-session` | session du compte (accompagnateur, administrateur) |
| `monaccompagnateur-theme`, `-langue` | apparence et langue |
| `<voyage>-groupe-local-v1`, `-presences-v1`, `-groupe-doc-v1` | Mon groupe (liste, appels, document fusionnable) |
| IndexedDB `monaccompagnateur` › `cles` | `appareil` (paire ECDH du voyageur), `equipe-appareil` (paire ECDH de l'accompagnateur), `equipe-<voyage>` (clé d'équipe) |

## Installation obligatoire sur téléphone (`app/garde.js`)

Sur iPhone, iPad et Android, Mes voyages, l'app du voyage, l'accès accompagnateur et Mon groupe ne s'ouvrent que dans l'app installée. Ouverts dans Safari ou Chrome, la page devient inerte et `garde.js` affiche les étapes d'installation. Dans Facebook ou Messenger, il propose plutôt d'ouvrir le lien dans Safari ou Chrome.

Ce n'est pas une protection de sécurité : ça garantit que tout le monde utilise l'app (données, clés, notifications).

Exceptions :
- les ordinateurs ;
- l'administration, l'éditeur, la page d'installation et la confidentialité ;
- le **mode dépannage** : « Je suis administrateur » mène à une connexion admin avec double authentification, puis ce navigateur est ouvert pendant 12 heures, avec un bandeau « Terminer ».

Les anciennes adresses `/mes-voyages/` et `/accompagnateur/` redirigent vers `/app/`. L'ancien service worker de `/accompagnateur/` se désinstalle de lui-même.

## Anglais

Les apps s'affichent en anglais quand le téléphone n'est pas en français. Le choix se change dans Réglages › Langue, et `?lang=en` permet de tester. Le code reste en français : `_app/i18n/runtime.js` traduit l'affichage à partir des dictionnaires, qui contiennent des chaînes exactes et des modèles (regex). Un texte « a · b · c » est traduit morceau par morceau.

Les dictionnaires :
- `_app/i18n/en.json` : interface commune des apps de voyage ;
- `_app/i18n/stations/<station>.json` : textes des fiches de station ;
- `_app/i18n/voyages/<voyage>.json` : dates et crédits propres au voyage.

Les pages de `/app/` ont leur petit dictionnaire intégré. Le contenu écrit par l'accompagnateur reste tel quel. Une chaîne absente du dictionnaire reste en français.

## Icônes

Les icônes d'écran d'accueil (montagne de la station, nom, année) se génèrent avec `python3 _app/icones/icones.py`, qui demande Chrome et la police Inter. Le robot le fait pour les nouveaux voyages. Champs facultatifs de la fiche du voyage : `iconeNom`, `iconeAnnee`.

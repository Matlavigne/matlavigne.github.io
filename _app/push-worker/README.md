# Alertes du voyage : Worker de notifications

Ce Worker Cloudflare envoie des notifications aux téléphones des voyageurs pour les apps de monaccompagnateur.ca.

Il ne voit jamais le contenu du voyage. Il garde seulement deux choses : les abonnements des téléphones (une adresse technique d'Apple, de Google ou de Mozilla, sans nom) et le calendrier des annonces (un identifiant et une heure). Le texte affiché sur le téléphone est générique, par exemple « Nouvelle annonce du groupe. Touchez pour la lire. ». L'app déchiffre ensuite l'annonce elle-même, avec la phrase du voyage, comme aujourd'hui.

```
Éditeur ──publie──▶ GitHub Pages (contenu chiffré)
   │
   └─ calendrier (id + heure) ──▶ Worker ──cron chaque minute──▶ Apple / Google ──▶ téléphones
                                     ▲
App du voyageur ── abonnement ───────┘
```

## Contenu

| Fichier | Rôle |
|---|---|
| `src/index.js` | Routes de l'API, envoi planifié, purge automatique |
| `src/webpush.js` | Signature VAPID et chiffrement aes128gcm (WebCrypto, sans dépendance) |
| `schema.sql` | Tables D1 : abonnements, calendrier, livraisons |
| `wrangler.toml` | Configuration et liste des voyages |
| `scripts/generate-keys.mjs` | Génère la paire VAPID et le jeton de l'éditeur |
| `client/push-client.js` | À inclure dans l'app : bouton « Activer les alertes » |
| `client/sw-push.js` | À importer dans le service worker de l'app |
| `client/editor-push.js` | À inclure dans l'éditeur : synchronise le calendrier à la publication |
| `test/e2e.mjs` | Test de bout en bout en local (`npm test`) |

## 1. Déployer le Worker (une seule fois, environ 10 minutes)

La base D1 `monaccompagnateur-push` est déjà créée, avec ses tables, et son identifiant est dans `wrangler.toml`. Il faut Node.js 20 ou plus.

```bash
git clone https://github.com/Matlavigne/matlavigne.github.io
cd matlavigne.github.io/_app/push-worker
npm install
npx wrangler login
npm run setup
```

`npm run setup` déploie le Worker, génère la paire VAPID et un jeton d'éditeur par voyage, puis les enregistre comme secrets dans Cloudflare. À la fin, il affiche les jetons d'éditeur : gardez-les dans votre gestionnaire de mots de passe. Il affiche aussi l'adresse du Worker, par exemple `https://monaccompagnateur-push.<compte>.workers.dev`. Mettez-la dans `_app/config.json`.

Pour les mises à jour suivantes du code du Worker, lancez `npm run deploy`. **Ne relancez pas `npm run setup`** : de nouvelles clés VAPID désabonneraient tous les téléphones.

### Ajouter un voyage

Ajoutez un bloc `[vars.TRIPS.<nom-du-dossier>]` dans `wrangler.toml`, par exemple pour St. Anton. Ajoutez son jeton au secret `EDITOR_TOKENS` : relancez `npx wrangler secret put EDITOR_TOKENS` et collez le JSON complet de tous les voyages (les anciens jetons, plus le nouveau, généré par exemple avec `npm run keys`). Puis lancez `npm run deploy`.

Chaque accompagnateur reçoit le jeton de ses propres voyages seulement. Une clé `"*"` dans `EDITOR_TOKENS` sert de jeton administrateur pour tous les voyages.

## 2. Brancher les apps

C'est déjà fait dans le code commun. Il suffit de mettre l'adresse du Worker dans `_app/config.json` (`"pushWorker": "https://…workers.dev"`), puis de lancer `node _app/build.mjs` à la racine du site et de publier. Le bouton « Activer les alertes » apparaît dans l'onglet Infos, et la section « Alertes sur les téléphones » dans l'éditeur. Les étapes ci-dessous décrivent ce que le code commun fait déjà.

## 2 bis. Détail du branchement (pour référence)

1. Copier `push-client.js` et `sw-push.js` à côté de `index.html` et du service worker.
2. En haut du service worker existant :
   ```js
   self.VOYAGE_PUSH = {
     worker: "https://monaccompagnateur-push.<compte>.workers.dev",
     trip: "solden-voyage-2027",
     icon: "icons/icon-192.png",
   };
   importScripts("sw-push.js");
   ```
   Le service worker change, il faut donc changer son numéro de version de cache pour que les téléphones le reprennent.
3. Dans l'app, à l'endroit voulu (accueil, fin de l'installation, section Annonces) :
   ```html
   <div id="alertes"></div>
   <script src="push-client.js"></script>
   <script>
     VoyagePush.init({ worker: "https://monaccompagnateur-push.<compte>.workers.dev", trip: "solden-voyage-2027" });
     VoyagePush.mountButton(document.getElementById("alertes"));
   </script>
   ```
   Le bouton gère lui-même les cas particuliers : iPhone pas encore installé à l'écran d'accueil, alertes refusées, navigateur non compatible.
4. **Recharger le contenu à la réception d'une alerte.** Quand une alerte arrive ou est touchée, le service worker envoie un message à l'app :
   ```js
   navigator.serviceWorker.addEventListener("message", (e) => {
     if (e.data && e.data.type === "voyage-push") rechargerContenu(); // votre fonction existante
   });
   ```
   **Important :** ce rechargement doit aller chercher le fichier de contenu sur le réseau (`fetch(url, { cache: "no-store" })`), pas dans le cache du service worker. Sinon, le voyageur touche l'alerte et voit l'ancienne version. Si la stratégie actuelle sert le contenu « cache d'abord », il faut passer à « réseau d'abord, cache si hors ligne » pour ce fichier.

## 3. Brancher l'éditeur

```html
<script src="editor-push.js"></script>
<script>
  VoyagePushEditor.init({ worker: "https://monaccompagnateur-push.<compte>.workers.dev", trip: "solden-voyage-2027" });
</script>
```

Après chaque publication réussie, envoyez la liste **complète** des annonces :

```js
await VoyagePushEditor.sync(annonces.map((a) => ({
  id: a.id,                  // identifiant stable : ne change pas quand on corrige le texte
  at: a.afficherA,           // heure ISO avec fuseau, ex. "2027-03-07T08:00:00+01:00"
  kind: "annonce",           // ou "rappel"
})));
```

Le jeton est demandé une seule fois, puis gardé dans le navigateur de l'accompagnateur.

Règles appliquées par le Worker :
- Une annonce ne part jamais avant **3 minutes** après la publication, le temps que GitHub Pages mette le site à jour.
- Une annonce déjà envoyée n'est jamais renvoyée, même si on la modifie. Pour réalerter le groupe, il faut créer une nouvelle annonce.
- Une annonce retirée de la liste avant son heure est déprogrammée.
- Une annonce nouvelle dont l'heure est passée depuis plus de 15 minutes est ignorée. Ça évite d'alerter pour tout l'historique la première fois.

Outils utiles dans la console de l'éditeur, ou à brancher sur des boutons :
- `VoyagePushEditor.test()` : envoie « Les alertes du voyage fonctionnent » à tout le groupe dans la minute.
- `VoyagePushEditor.status()` : nombre de téléphones abonnés et livraisons des dernières alertes.
- `VoyagePushEditor.purge()` : efface tout pour ce voyage.

## 4. Tester avant le voyage

- **iPhone :** iOS 16.4 ou plus. Ajouter l'app à l'écran d'accueil, l'ouvrir depuis l'icône, puis toucher « Activer les alertes ». Dans Safari seul, les alertes ne sont pas possibles.
- **Android :** Chrome. Les alertes fonctionnent même sans installation, mais l'installation reste recommandée.
- Lancer `VoyagePushEditor.test()` et vérifier la réception écran verrouillé, app fermée, puis en touchant l'alerte.
- Programmer une annonce dans 10 minutes et vérifier qu'elle arrive à l'heure.
- Mettre un téléphone en mode avion, envoyer un test, puis le rallumer : l'alerte arrive à la reconnexion, jusqu'à 12 heures plus tard.

Le meilleur moment pour faire activer les alertes au groupe : pendant la réunion Teams avant le départ, tous ensemble.

## Confidentialité (texte suggéré pour l'app)

> Si vous activez les alertes, votre téléphone reçoit une adresse de notification anonyme d'Apple ou de Google. Elle est conservée uniquement pour vous envoyer les alertes de ce voyage et est effacée automatiquement 7 jours après le retour. Aucun nom, numéro ni contenu du voyage n'y est associé. Vous pouvez désactiver les alertes à tout moment dans l'app.

## Limites et coûts

- **Forfait gratuit Cloudflare :** il couvre largement un groupe. Le cron tourne chaque minute (1 440 passages par jour) et chaque passage envoie au plus 40 alertes. Au-delà, la suite part au passage suivant, une minute plus tard.
- **Délai :** comptez 0 à 1 minute de cron, plus quelques secondes à quelques minutes chez Apple ou Google. Une heure d'annonce est une cible, pas une garantie à la seconde.
- **Abonnements expirés :** ils sont supprimés automatiquement dès qu'Apple ou Google répond qu'ils n'existent plus (codes 404 ou 410).
- **Purge automatique :** tout le voyage est effacé 7 jours après la date `end` du voyage.

## Tests

```bash
npm test
```

Le test démarre le Worker en local avec une base D1 locale et un faux service de push. Ce faux service vérifie la signature VAPID et déchiffre chaque message comme le ferait un téléphone. Le test couvre aussi les refus (origine, jeton, clés), le délai de publication, le plafond par passage, l'absence de renvoi, les abonnements expirés et la purge.

## Publication par clé d'éditeur (un accompagnateur = un voyage)

Les accompagnateurs n'ont pas de jeton GitHub. Dans l'éditeur, ils entrent la **clé de l'éditeur** de leur voyage (la même que le « jeton des alertes »). L'éditeur chiffre le contenu avec la phrase du voyage, puis l'envoie au Worker (`POST /api/publier`). Le Worker vérifie la clé et écrit **uniquement** `<voyage>/voyage.json` dans le dépôt, avec le seul jeton GitHub, gardé comme secret.

Garde-fous du Worker : chemin construit par le Worker (jamais reçu de l'éditeur), voyage connu dans `wrangler.toml`, contenu JSON de forme valide et de 600 Ko au plus, refus d'une version en clair si la version en ligne est protégée, refus si le fichier a changé depuis l'ouverture de l'éditeur (409). Chaque publication apparaît dans l'historique GitHub au nom « Éditeur <voyage> ».

Installation (une fois) :

1. Sur github.com, créez un jeton « fine-grained » : dépôt `matlavigne.github.io` seulement, permission **Contents : Read and write**, rien d'autre. Expiration : la plus longue que vous acceptez (à renouveler ensuite).
2. Dans ce dossier : `npx wrangler secret put GITHUB_TOKEN`, collez le jeton.
3. `npm run deploy`.

Clés : `npm run cle -- <voyage>` crée ou remplace la clé d'un voyage (l'ancienne cesse de fonctionner aussitôt). Le mode administrateur de l'éditeur (jeton GitHub personnel) reste disponible pour vous.

Tests : `npm test` (alertes et publication, avec un faux GitHub local).

## Administration (monaccompagnateur.ca/admin)

Créer un voyage sans coder, remettre ou remplacer la clé d'un accompagnateur, clore un voyage après le retour.

- La page `admin/index.html` se connecte avec un **compte** (voir « Comptes » plus bas). Seul un administrateur avec double authentification peut créer ou clore un voyage.
- À la création, le navigateur chiffre le contenu de départ avec la phrase du voyage; le Worker écrit en **un seul commit** la fiche `_app/voyages/<id>.json`, le contenu chiffré `<id>/voyage.json`, la photo éventuelle (`_app/voyages/photos/<id>.jpg`) et, au choix, l'entrée de la page d'accueil (`voyages.json`). Il enregistre le voyage et sa clé d'éditeur (hachée) dans la base D1 : pas besoin de modifier `wrangler.toml` ni de redéployer.
- Le robot GitHub (`.github/workflows/generer-apps.yml`) prépare ensuite les images (photo recadrée ou illustration, icônes) et génère l'app. Essai à blanc possible depuis l'onglet Actions (« Run workflow », case « Essai à blanc »).
- Clore un voyage efface ses abonnements aux alertes et sa clé d'éditeur; l'app reste en ligne.
- Supprimer un voyage (confirmation : taper son adresse) retire en un seul commit l'app, la fiche, la photo, l'icône, le dictionnaire anglais et l'entrée de la page d'accueil, puis efface ses alertes, sa clé et les accès des accompagnateurs. Récupérable au besoin dans l'historique GitHub.

Les nouvelles stations se préparent encore à la main (fiche `_app/stations/<id>.json`, dictionnaire anglais, silhouette de l'icône); elles apparaissent ensuite dans le menu de l'administration.

## Comptes : nom d'usager, mot de passe et double authentification

Chaque accompagnateur a son compte; l'administrateur lui confie un ou plusieurs voyages. La même connexion sert à `/admin` et à l'éditeur de chaque voyage (session partagée sur monaccompagnateur.ca).

- **Administrateur** : double authentification obligatoire (app d'authentification : Google Authenticator, 1Password, Authy…). Session de 12 h.
- **Accompagnateur** : publie seulement les voyages qui lui sont confiés. Double authentification obligatoire aussi (activée à la première connexion; impossible de la retirer soi-même, l'administrateur peut la réinitialiser). Session de 30 jours.
- Mot de passe temporaire à la création ou à la réinitialisation : la personne le remplace à sa première connexion (10 caractères minimum).
- 5 essais ratés : compte bloqué 15 minutes. Codes de secours (8, à usage unique) remis à l'activation de la double authentification.
- Rien n'est stocké en clair : mots de passe (PBKDF2), sessions et codes de secours (SHA-256) dans la base D1.

Première configuration (une fois) :

1. `npm run cle-config` : crée la clé de première configuration (secret `ADMIN_TOKEN`). Gardez-la dans votre gestionnaire de mots de passe.
2. `npm run deploy`.
3. Sur `monaccompagnateur.ca/admin` › « Première configuration » : collez la clé, choisissez votre nom d'usager et votre mot de passe, puis activez la double authentification et conservez les codes de secours. La clé ne sert plus ensuite (elle est refusée dès qu'un administrateur existe).
4. Onglet « Comptes » : créez les comptes des accompagnateurs et cochez leurs voyages. Transmettez le message affiché par un canal privé.

Téléphone perdu et plus de codes de secours : `npm run secours-admin -- <nom d'usager>` réinitialise le mot de passe et retire la double authentification de ce compte (directement dans la base, depuis votre ordinateur).

Les anciennes **clés d'éditeur** par voyage (`npm run cle`) fonctionnent encore (« Ancienne méthode » dans l'éditeur). Le jeton GitHub personnel reste disponible en mode administrateur.

Tests : `npm test` (alertes, publication, administration, comptes).

## App de l'accompagnateur (monaccompagnateur.ca/accompagnateur)

Page installable (icône « Accompagnateur » sur l'écran d'accueil) où chaque accompagnateur retrouve, après connexion avec son compte, tous les voyages qui lui sont confiés (l'administrateur les voit tous) :

- voyages à venir et en cours d'abord, avec les dates et un compte à rebours (« Départ dans 12 jours », « En cours · jour 3 sur 9 »), puis les voyages passés;
- boutons App du voyage, Éditeur, Mon groupe et Partager l'app (lien de la page d'installation);
- « Mon groupe » (`/accompagnateur/groupe.html?v=<voyage>`) : liste du groupe (import CSV ou saisie) et présences, gardées dans cette app sur le téléphone. L'app du voyage n'a plus aucune page d'accompagnateur; une ancienne liste qui y serait restée s'exporte depuis ses Réglages.
- nombre de téléphones abonnés aux alertes;
- réglages : apparence (auto, clair, sombre) et langue, partagés avec les apps des voyages.

Le Worker répond à `GET /api/mes-voyages` (session de compte; mot de passe temporaire changé; double authentification pour l'administrateur). Les dates viennent des champs publics de `<voyage>/voyage.json`.

## Adresse du Worker

Les apps appellent `https://api.monaccompagnateur.ca` (domaine monaccompagnateur.ca géré dans le DNS de Cloudflare; le site reste sur GitHub Pages en « DNS only »). L'ancienne adresse `monaccompagnateur-push.monaccompagnateur.workers.dev` reste active (`workers_dev = true`) pour les téléphones qui n'ont pas encore la nouvelle version des apps.

## Accès par approbation (sans phrase pour le voyageur)

- Le voyageur, dans l'app `/app/` : « Ajouter un voyage » › prénom, nom, notifications › « Demander l'accès ». Son téléphone crée une paire de clés ECDH P-256 (clé privée non exportable, dans IndexedDB). `POST /api/acces/demande` (nom, clé publique, abonnement aux notifications facultatif) renvoie un identifiant et un jeton (gardé haché).
- L'accompagnateur, dans l'accès accompagnateur : bouton « Demandes d'accès » du voyage (`GET /api/acces/demandes`). Les noms sont comparés à la liste du groupe sur son téléphone seulement. À l'approbation, son app dérive la clé du voyage depuis la phrase et la chiffre pour la clé publique de chaque téléphone (ECDH + AES-GCM); `POST /api/acces/decision` la transmet : le Worker ne peut pas la lire.
- Le Worker envoie la notification « Accès approuvé » et abonne le téléphone aux alertes du voyage. Le voyageur récupère la clé chiffrée (`GET /api/acces/etat`, avec son jeton) et l'app s'ouvre déverrouillée.
- Limites : 10 demandes par heure et par adresse IP pour un voyage, 400 demandes en attente par voyage. Les demandes sont effacées avec le voyage (clôture, suppression ou 7 jours après la fin).

- Alertes des demandes : l'accompagnateur touche « Activer » (liste de ses voyages ou Réglages) dans l'app installée; `POST /api/acces/alertes` garde l'abonnement de ce téléphone (table `comptes_subs`). Chaque nouvelle demande avertit les accompagnateurs du voyage, ou les administrateurs s'il n'y en a aucun. La notification ouvre la liste des demandes du voyage.
- Retirer un accès : « Déjà traitées » › Retirer (`decision` avec `retirer: true`). Statut `retire`, plus de clé, désabonné des alertes du voyage; l'app du voyageur efface le voyage (clé et contenu) à sa prochaine ouverture. « Redonner » le rétablit.
- Changement de phrase : chaque approbation retient le sel de la clé envoyée (`sel`). Si la phrase change dans l'éditeur, la page des demandes l'indique et « Leur envoyer la nouvelle clé » la rechiffre pour chaque voyageur approuvé; leur app la reprend à la prochaine ouverture. Les personnes retirées ne la reçoivent pas : c'est la coupure certaine.

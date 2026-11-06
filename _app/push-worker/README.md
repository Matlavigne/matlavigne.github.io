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

# Serveur de monaccompagnateur.ca (Worker Cloudflare)

Le Worker répond à `https://api.monaccompagnateur.ca`. L'ancienne adresse `monaccompagnateur-push.monaccompagnateur.workers.dev` reste active (`workers_dev = true`). Il gère :
- les **comptes** : accompagnateurs et administrateurs, double authentification obligatoire ;
- la **publication** du contenu des voyages sur GitHub ;
- les **alertes**, c'est-à-dire les notifications web aux téléphones ;
- les **demandes d'accès** des voyageurs (approbation) ;
- la copie chiffrée de **Mon groupe**.

Le site et les apps sont décrits dans [`../README.md`](../README.md).

**Principe :** le Worker ne lit jamais le contenu des voyages ni les renseignements des voyageurs.
- Le contenu est chiffré dans le navigateur avec la phrase du voyage.
- La liste du groupe est chiffrée avec la clé d'équipe des accompagnateurs.
- Le nom dans une demande d'accès est chiffré pour l'équipe.
- Les notifications portent un texte générique.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/index.js` | routes : publication, alertes, demandes d'accès, administration, cron (envois et purge) |
| `src/auth.js` | comptes, mots de passe (PBKDF2), double authentification (TOTP), sessions |
| `src/equipe.js` | Mon groupe partagé : appareils, enveloppes de la clé d'équipe, copie chiffrée |
| `src/webpush.js` | notifications web : signature VAPID et chiffrement aes128gcm (WebCrypto, sans dépendance) |
| `schema.sql` | tables de base (abonnements, calendrier, livraisons); les autres tables se créent seules |
| `wrangler.toml` | configuration (adresse, base D1, cron, variables) |
| `scripts/setup.mjs` | installation initiale des clés VAPID (**une seule fois**) |
| `scripts/cle-admin.mjs` | `npm run cle-config` : clé de première configuration (secret `ADMIN_TOKEN`) |
| `scripts/secours-admin.mjs` | `npm run secours-admin -- <usager>` : réinitialise le mot de passe et la double authentification d'un compte |
| `test/*.mjs` | tests de bout en bout en local (`npm test`) |

## Opérations courantes

```bash
cd _app/push-worker
git pull
npm install          # la première fois, ou après une mise à jour de wrangler
npm run deploy       # après chaque changement du code du Worker
npm test             # avant de déployer (environ 5 minutes)
```

**Ne relancez jamais `npm run setup`** sur le Worker en service : de nouvelles clés VAPID désabonneraient tous les téléphones.

**Secrets** (dans Cloudflare, jamais dans le dépôt) :

| Secret | Rôle |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK` | notifications |
| `GITHUB_TOKEN` | jeton GitHub « fine-grained », dépôt `matlavigne.github.io` seulement, *Contents : Read and write*; à renouveler avant son expiration (`npx wrangler secret put GITHUB_TOKEN`) |
| `ADMIN_TOKEN` | clé de première configuration; refusée dès qu'un administrateur existe |

L'ancien secret `EDITOR_TOKENS` ne sert plus : `npx wrangler secret delete EDITOR_TOKENS`.

**Téléphone d'authentification perdu, sans code de secours :** `npm run secours-admin -- <nom d'usager>` donne un mot de passe temporaire et retire la double authentification, qu'il faudra réactiver.

## Comptes

- Un compte par accompagnateur. L'administrateur lui confie un ou plusieurs voyages. La même session sert à l'accès accompagnateur, à l'éditeur, à Mon groupe et à l'administration.
- **Double authentification obligatoire pour tous** (app d'authentification). Elle ne peut pas être retirée soi-même ; l'administrateur peut la réinitialiser. Sans elle, le compte ne peut ni publier ni voir ses voyages.
- Mot de passe temporaire à la création, à changer à la première connexion (10 caractères minimum). Après 5 essais ratés, le compte est bloqué 15 minutes. Chaque compte reçoit 8 codes de secours à usage unique.
- Rien en clair dans la base : mots de passe (PBKDF2), sessions et codes de secours (SHA-256).
- Sessions : 12 heures pour un administrateur, 30 jours pour un accompagnateur.
- **Profil** (nom, cellulaire, courriel) : repris par l'éditeur dans la liste des accompagnateurs du voyage, publiée chiffrée.

**Première configuration** (une fois) :
1. Lancez `npm run cle-config`, puis `npm run deploy`.
2. Sur `/admin` › « Première configuration », entrez la clé, créez votre compte et activez la double authentification.

## Publication

L'éditeur chiffre le contenu avec la phrase du voyage, puis l'envoie (`POST /api/publier`, session d'un compte qui a le voyage). Le Worker écrit **uniquement** `<voyage>/voyage.json` avec son jeton GitHub. Chaque publication est signée « Éditeur <voyage> » dans l'historique.

Garde-fous :
- le chemin est construit par le Worker ;
- le voyage doit être connu ;
- le contenu doit être un JSON valide de 600 Ko au plus ;
- une version en clair est refusée si la version en ligne est protégée ;
- un conflit est signalé si le fichier a changé depuis l'ouverture (409).

## Administration (`/admin`, administrateur avec double authentification)

- **Créer un voyage** : le navigateur chiffre le contenu de départ, puis le Worker écrit en **un seul commit** :
  - la fiche `_app/voyages/<id>.json` ;
  - le contenu chiffré `<id>/voyage.json` ;
  - la photo (`_app/voyages/photos/<id>.jpg`) ;
  - au choix, l'entrée de `voyages.json`.

  Le voyage est enregistré dans la base D1 (table `trips`). Le robot GitHub génère ensuite l'app.
- **Photo d'en-tête**, **accompagnateurs** (un ou plusieurs comptes par voyage), **comptes** (création, voyages, mot de passe, double authentification, suppression).
- **Clore** : efface les abonnements, le calendrier, les demandes d'accès et la copie chiffrée de Mon groupe ; l'app reste en ligne.
- **Supprimer** (en tapant l'adresse) : retire en un commit l'app, la fiche, la photo, l'icône et le dictionnaire, puis efface tout dans la base. Le voyage reste récupérable dans l'historique GitHub.

Sölden 2027, créé avant l'administration, est encore décrit dans `wrangler.toml` (`[vars.TRIPS]`). Les voyages suivants sont dans la base.

## Alertes (notifications)

- **Abonnement** (`/api/subscribe`) : l'app du voyageur s'abonne dans Réglages › Alertes, ou automatiquement quand son accès est approuvé. Le Worker garde une adresse anonyme d'Apple ou de Google, sans nom.
- **Calendrier** (`/api/schedule`) : à chaque publication, l'éditeur envoie la liste complète des annonces (identifiant et heure, jamais le texte). Le cron, chaque minute, envoie un texte générique, par exemple « Nouvelle annonce du groupe ». L'app déchiffre ensuite l'annonce elle-même.
- **Règles d'envoi** :
  - jamais avant **3 minutes** après la publication (le temps que GitHub Pages se mette à jour) ;
  - jamais deux fois la même annonce ;
  - une annonce retirée avant son heure est déprogrammée ;
  - une annonce nouvelle dont l'heure est passée depuis plus de 15 minutes est ignorée.
- **Plafond** : 40 envois par passage du cron ; la suite part une minute plus tard. Les abonnements expirés (404 ou 410) sont supprimés.
- **Outils de l'éditeur** (section Alertes) : alerte de test, nombre d'abonnés, état des envois.
- **Pastille** sur l'icône : annonces non lues, demandes d'accès en attente (accompagnateur), accès approuvé pas encore vu (voyageur).

## Accès par approbation

1. **Le voyageur demande l'accès.** Dans `/app/`, il ouvre « Ajouter un voyage », entre son prénom et son nom, active les notifications et touche « Demander l'accès ». Son téléphone crée une paire ECDH P-256 (partie privée non exportable, dans IndexedDB). Le nom est **chiffré pour l'équipe d'accompagnateurs** avec la clé publique d'équipe (`GET /api/acces/cle-equipe`). `POST /api/acces/demande` reçoit le nom chiffré, la clé publique du téléphone et l'abonnement éventuel. Il renvoie un identifiant et un jeton, gardé haché.
2. **Les accompagnateurs sont avertis** par une notification générique, s'ils ont activé « Alertes des demandes » (`/api/acces/alertes`, table `comptes_subs`). Leur app déchiffre les noms et les compare à la liste du groupe, sur le téléphone seulement.
3. **L'approbation.** L'app de l'accompagnateur dérive la clé du voyage depuis la phrase et la chiffre pour le téléphone de chaque personne approuvée (`POST /api/acces/decision`). Le voyageur reçoit « Accès approuvé » et est abonné aux alertes du voyage. Son app récupère la clé chiffrée (`GET /api/acces/etat`) et le voyage s'ouvre.
4. **Retirer un accès.** Le statut passe à `retire` et le téléphone est désabonné. L'app du voyageur efface le voyage à sa prochaine ouverture.
5. **Phrase changée.** La page des demandes l'indique. « Leur envoyer la nouvelle clé » rechiffre la clé pour les voyageurs approuvés, mais pas pour les personnes retirées.

Limites : 10 demandes par heure et par adresse IP pour un voyage, et 400 demandes en attente par voyage. Sans clé d'équipe (aucun accompagnateur n'a encore ouvert son app pour ce voyage), le nom arrive en clair. Un nom en clair est refusé dès qu'une clé d'équipe existe.

## Mon groupe partagé (chiffré de bout en bout)

- **Clé d'équipe** (`app/equipe.js`) : 32 octets aléatoires (AES-256-GCM), plus une paire ECDH d'équipe, dont la partie publique sert à chiffrer les noms des demandes. Elle n'existe que sur les téléphones des accompagnateurs du voyage.
- **Appareils** : chaque téléphone d'accompagnateur a sa paire ECDH P-256, enregistrée sur son compte (`POST /api/equipe/appareil`, table `equipe_appareils`).
- **Création** : le premier accompagnateur qui ouvre son app ou Mon groupe crée la clé (`PUT /api/groupe`, table `groupes`).
- **Don de la clé** : un nouveau téléphone attend avec un code de vérification. Un collègue compare le code et touche « Donner la clé » (`POST /api/equipe/cles`, enveloppes dans `equipe_cles`). Le collègue est averti par notification.
- **Accès** : seulement les comptes assignés au voyage, avec double authentification. Un administrateur non assigné n'y a pas accès.
- **Accompagnateur retiré** : la clé change au prochain passage d'un collègue (`rotation`), et la liste s'efface du téléphone retiré.
- **Fusion** : chaque fiche, appel et coche porte l'heure et l'auteur du changement. Les écritures simultanées se fusionnent (conflit 409, fusion, renvoi). La liste est compressée (gzip) avant le chiffrement.
- **Code de secours** : la clé en base 32 (carte « Clé d'équipe »). Il change avec la clé.

## Données gardées dans la base D1

| Table | Contenu | Effacé |
|---|---|---|
| `trips` | voyages créés par l'administration | à la suppression (marqué supprimé) |
| `users`, `sessions`, `defis` | comptes, sessions, défis de connexion | suppression du compte, expiration |
| `subscriptions`, `announcements`, `deliveries` | abonnements anonymes, calendrier (id + heure), livraisons | clôture, suppression, ou 7 jours après la fin |
| `demandes` | nom **chiffré**, clé publique du téléphone, jeton haché, statut | idem |
| `comptes_subs` | abonnements des accompagnateurs aux alertes des demandes | désactivation, adresse expirée |
| `groupes`, `equipe_cles`, `equipe_attente` | Mon groupe **chiffré**, enveloppes de la clé d'équipe | clôture, suppression, ou 7 jours après la fin |
| `equipe_appareils` | clés publiques des téléphones des accompagnateurs | — |

Sont lisibles dans la base : les noms d'usager et les profils des accompagnateurs (nom, cellulaire, courriel). Rien de lisible n'y concerne les voyageurs.

## Tests

```bash
npm test
```

Chaque suite démarre le Worker en local (`wrangler dev`, base D1 locale), avec un faux GitHub et un faux service de notifications :
- **`e2e.mjs`** : alertes. Le faux service vérifie la signature VAPID et déchiffre chaque message comme un téléphone. Sont aussi couverts les refus, les délais, le plafond, l'absence de renvoi, les abonnements expirés et la purge.
- **`publier.mjs`** : publication. Un compte ne peut écrire que son voyage.
- **`comptes.mjs`** : comptes, double authentification et sessions.
- **`admin.mjs`** : administration, accompagnateurs, demandes d'accès, alertes des demandes, retrait d'un accès, Mon groupe partagé, noms chiffrés et suppression.

`test/outils.mjs` contient les voyages de test, le code TOTP et l'ouverture de sessions. Avec `SERVIR=1 node test/admin.mjs`, le Worker de test reste en marche pour les essais dans le navigateur.

## Limites et coûts

- **Coût** : le forfait gratuit de Cloudflare couvre largement l'usage (cron chaque minute, D1, requêtes).
- **Délai des alertes** : de 0 à 1 minute de cron, plus le délai d'Apple ou de Google. Un téléphone hors ligne reçoit l'alerte à sa reconnexion, jusqu'à 12 heures plus tard.
- **iPhone** : iOS 16.4 ou plus, app installée sur l'écran d'accueil et ouverte depuis son icône.

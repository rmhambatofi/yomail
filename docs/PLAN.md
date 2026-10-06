# Plan d'implémentation v2 — Webhook catcher `yo.manitra.fr`

> Ce document remplace le plan « boîte email jetable » (archivé dans `docs/archive/PLAN_v1_mailbox.md`).
> Le pivot est décidé le 2026-10-06 : la réception SMTP via pipe Exim n'est pas exploitable sur l'hébergement cPanel.
> Le projet devient un **webhook catcher** (type webhook.site). Le socle technique (monorepo, NestJS + TypeORM + MySQL, React + Vite, déploiement Passenger) est conservé ; le domaine métier est remplacé.
> Chaque phase est autonome, livrable et vérifiable. Ne pas passer à la phase suivante tant que les critères d'acceptation ne sont pas validés.

---

## 0. Récapitulatif des décisions

| Sujet              | Décision                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Produit            | Webhook catcher : l'utilisateur crée un endpoint, y envoie des requêtes HTTP (Postman, code, service tiers) et les consulte en temps réel dans une « inbox ». Aucune authentification : quiconque connaît l'UUID voit l'inbox                    |
| Endpoint           | `https://yo.manitra.fr/<uuid>` avec sous-chemin optionnel (`/<uuid>/any/sub/path`). UUID v4 généré **côté serveur** à la création, ce qui exclut les doublons                                                                                    |
| Méthodes capturées | GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD (toutes). Query string, en-têtes, corps et IP du client sont enregistrés                                                                                                                            |
| Réponse au client  | **Fixe en v1** : `200` + `{"ok":true,"id":"<request id>"}` (`application/json`). `HEAD` → 200 sans corps. CORS ouvert (`*`) sur les routes de capture. Réponse configurable = phase ultérieure                                                   |
| Contenus           | JSON, formulaire (`x-www-form-urlencoded`, `multipart/form-data` champs texte), HTML, XML, texte. **Pas de fichiers ni de médias** : les parties fichier d'un multipart sont ignorées (nom/taille notés), les corps binaires ne sont pas stockés |
| Taille max         | 512 Ko de corps par requête (`MAX_BODY_BYTES`), au-delà : `413`, rien n'est enregistré                                                                                                                                                           |
| Volume             | 500 requêtes max par endpoint (`MAX_REQUESTS_PER_ENDPOINT`) : à l'insertion, les plus anciennes au-delà du plafond sont supprimées                                                                                                               |
| Rétention          | 10 jours **par requête**, valeur globale en base (table `settings`, conservée). Un endpoint sans activité depuis plus de `retention_days` est supprimé                                                                                           |
| Temps réel         | **Oui.** Socket.IO (WebSocket avec repli automatique en long-polling HTTP). Sur cPanel/Apache, Passenger ne supporte pas WebSocket : le long-polling sera le transport effectif. Repli ultime côté client : polling REST toutes les 5 s          |
| Rendu              | Adapté au type : JSON formaté, formulaire en tableau clé/valeur, HTML en « Raw » + « Preview » dans une iframe sandbox (sanitisation serveur), XML/texte en `<pre>`. « Raw » toujours disponible                                                 |
| Hébergement        | Inchangé : cPanel mutualisé o2switch (sans root), Node 22, MySQL, Passenger. **L'app Node est désormais montée à la racine** de `yo.manitra.fr` et sert elle-même la SPA (plus de `.htaccess` SPA)                                               |
| Stack              | NestJS 10 + TypeORM + MySQL / React 18 + Vite + TypeScript + Tailwind / Socket.IO                                                                                                                                                                |
| Monorepo           | npm workspaces, nom `yomail` conservé (pas de renommage des packages)                                                                                                                                                                            |
| Langue UI          | Anglais                                                                                                                                                                                                                                          |
| Hors périmètre v1  | Réponse configurable, recherche/filtre, replay, export, notes, géolocalisation IP, auth, rate limiting, tests automatisés, CI                                                                                                                    |

### Défauts choisis (non discutés, modifiables)

- L'endpoint est **explicite** : créé via `POST /api/endpoints`, stocké en table `endpoints`. Une requête vers un UUID inconnu renvoie `404`. Cela évite d'enregistrer du trafic parasite et permet d'attacher plus tard une configuration de réponse.
- Identifiants courts affichés : endpoint = 8 premiers caractères de l'UUID (`13cc7e2a`), requête = `#` + 5 premiers caractères (`#1afe3`). Affichage uniquement, jamais utilisé comme clé.
- Les en-têtes sont stockés tels que reçus par Node (`rawHeaders` : casse et ordre préservés, doublons conservés), y compris ceux ajoutés par Apache/Passenger (`X-Forwarded-*`).
- Les requêtes `OPTIONS` (preflight CORS) sont capturées comme les autres et reçoivent les en-têtes CORS ouverts.
- Pas de limite de requêtes par IP ni de captcha (hors v1).
- `expires_at = received_at + retention_days`, calculé à la lecture et à la purge, jamais stocké (invariant conservé du v1).
- Liste d'une inbox : 50 requêtes par page, curseur `before=<received_at>`, max 200 par appel.
- L'UI mémorise les endpoints ouverts dans `localStorage` (« Recent endpoints »), sans aucun état côté serveur.

---

## 1. Architecture

```
            Postman / code / service tiers
                        │ HTTP (toute méthode)
                        ▼
       https://yo.manitra.fr/<uuid>[/sub/path]
                        │
              Apache + Passenger (cPanel)      ← monté à la racine du sous-domaine
                        │
                        ▼
                 NestJS (apps/api)
   ┌──────────────────────────────────────────────────────┐
   │ CaptureController  @All('/:uuid', '/:uuid/*')        │ → persiste `requests`, répond 200
   │ EndpointsController /api/endpoints/...               │ → création, lecture, suppression
   │ RequestsController  /api/endpoints/:id/requests/...  │ → liste, détail, suppression
   │ LiveGateway         Socket.IO sur /api/socket.io     │ → push `request:new` aux abonnés
   │ PurgeService        requêtes et endpoints expirés    │
   │ ServeStatic         apps/web/dist (SPA) pour le reste│
   └──────────────────────────────────────────────────────┘
                        │
                        ▼
                      MySQL
                        ▲
                        │ REST + Socket.IO
                 React SPA (apps/web)
          /  ·  /inbox/:uuid  ·  /inbox/:uuid/:rid
```

### Pourquoi monter l'app à la racine et servir la SPA depuis Nest

L'URL de capture doit être `yo.manitra.fr/<uuid>`. Avec la SPA statique dans le document root et l'API montée sur `/api`, un chemin racine arriverait au `.htaccess` d'Apache, pas à Node. Une réécriture `.htaccess` vers `/api/...` sous Passenger est fragile. Monter Passenger à la racine et laisser Nest servir `apps/web/dist` (`@nestjs/serve-static`) donne un seul point d'entrée et un ordre de routage déterministe : `/api/*` → API, `/:uuid` → capture, fichier statique existant → asset, sinon → `index.html`.

### Temps réel sur cPanel

- Passenger sous Apache **ne supporte pas l'upgrade WebSocket** ; Socket.IO détecte l'échec et reste en long-polling HTTP (cf. démo officielle Phusion). Le code est identique, seul le transport change. Si l'app est un jour hébergée derrière Nginx ou ailleurs, WebSocket s'active sans modification.
- Passenger peut lancer **plusieurs process** de l'app. Une requête capturée par le process A doit atteindre un client abonné sur le process B. Solution : le gateway ne se fie pas uniquement à l'événement en mémoire ; il interroge la base toutes les 2 s pour chaque endpoint ayant au moins un abonné (`SELECT ... WHERE endpoint_id IN (...) AND received_at > :lastSeen`, requête indexée, très bon marché) et émet ce qu'il trouve. Le process qui capture émet aussi immédiatement en mémoire (chemin rapide mono-process). Le client déduplique par `id`.
- Le long-polling multi-process requiert l'affinité de session : `PassengerStickySessions on` est ajouté dans `.htaccess` (directive autorisée en contexte `.htaccess`). À vérifier en phase 6 ; si l'affinité n'est pas respectée, forcer `transports: ['polling']` ne suffit pas, le repli est le polling REST côté client (5 s), déjà prévu.
- Côté client, le hook `useLiveRequests` expose un état `live | polling | offline` affiché dans l'en-tête ; en `polling`/`offline` il recharge la liste toutes les 5 s et à chaque reconnexion.

---

## 2. Structure du monorepo (delta par rapport au v1)

```
yomail/
├── docs/
│   ├── PLAN.md                     # ce fichier
│   ├── DEPLOY_CPANEL.md            # à mettre à jour en phase 6
│   └── archive/PLAN_v1_mailbox.md  # ancien plan, référence historique
├── packages/shared/src/index.ts    # DTO Endpoint*, Request*, ENDPOINT_ID_REGEX, extractEndpointId()
├── apps/
│   ├── api/src/
│   │   ├── main.ts                 # préfixe /api avec exclusion des routes de capture, trust proxy, Socket.IO adapter
│   │   ├── app.module.ts
│   │   ├── config/env.ts           # nouvelles variables (§7)
│   │   ├── database/               # datasource + migrations (drop emails, create endpoints/requests)
│   │   ├── settings/               # inchangé (retention_days)
│   │   ├── endpoints/              # entité Endpoint, service, controller /api/endpoints
│   │   ├── requests/               # entité Request, service (liste/détail/suppression/cap), controller
│   │   ├── capture/                # CaptureController @All, lecture du corps (limite), parseurs par type, CORS
│   │   ├── live/                   # LiveGateway Socket.IO + ChangeDetector (poll DB)
│   │   ├── purge/                  # adapté : requests puis endpoints
│   │   ├── health/
│   │   ├── static/                 # ServeStaticModule conditionnel (WEB_DIST_DIR)
│   │   └── cli/purge.ts
│   └── web/src/
│       ├── App.tsx                 # routes: /, /inbox/:uuid, /inbox/:uuid/:rid
│       ├── api/client.ts           # fetch + ApiError (inchangé dans l'esprit)
│       ├── lib/useLiveRequests.ts  # Socket.IO + repli polling
│       ├── lib/recentEndpoints.ts  # localStorage
│       ├── pages/HomePage.tsx      # Create endpoint / Open existing / Recent
│       ├── pages/InboxPage.tsx     # un seul écran : liste + panneau détail (details, headers, content) ; sert aussi /inbox/:uuid/:rid
│       └── components/             # EndpointPicker, RequestList, RequestPanel, RequestDetailsTable, HeadersTable, QueryParamsTable, viewers/{Json,Form,Html,Text}, HtmlFrame, CopyButton, LiveBadge
└── apps/ingest/                    # SUPPRIMÉ en phase 0
```

---

## 3. Modèle de données (MySQL, utf8mb4)

### `endpoints`

| Colonne           | Type                 | Notes                                       |
| ----------------- | -------------------- | ------------------------------------------- |
| `id`              | CHAR(36) PK          | UUID v4, `crypto.randomUUID()` côté serveur |
| `created_at`      | DATETIME(3) NOT NULL |                                             |
| `last_request_at` | DATETIME(3) NULL     | mis à jour à chaque capture ; index (purge) |

### `requests`

| Colonne         | Type                                                                | Notes                                                                               |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `id`            | CHAR(36) PK                                                         | UUID v4                                                                             |
| `endpoint_id`   | CHAR(36) NOT NULL                                                   | FK → `endpoints.id` ON DELETE CASCADE                                               |
| `method`        | VARCHAR(16) NOT NULL                                                | en majuscules                                                                       |
| `path`          | VARCHAR(2048) NOT NULL                                              | sous-chemin après l'UUID, `/` par défaut                                            |
| `query_params`  | JSON NULL                                                           | tableau de paires `[name, value]` (doublons préservés)                              |
| `headers`       | JSON NOT NULL                                                       | tableau de paires `[name, value]` depuis `rawHeaders`                               |
| `client_ip`     | VARCHAR(45) NULL                                                    | `req.ip` avec `trust proxy` (voir §7)                                               |
| `content_type`  | VARCHAR(255) NULL                                                   | en-tête brut                                                                        |
| `content_kind`  | ENUM('none','json','form','multipart','html','xml','text','binary') | déduit du `Content-Type` (+ sniff JSON sur `text/plain`)                            |
| `body`          | MEDIUMTEXT NULL                                                     | corps brut en texte (≤ `MAX_BODY_BYTES`). NULL pour `none`, `multipart` et `binary` |
| `form_fields`   | JSON NULL                                                           | paires `[name, value]` pour `form` et `multipart` (champs texte)                    |
| `dropped_files` | JSON NULL                                                           | `[{ field, filename, size }]` pour les parties fichier ignorées d'un multipart      |
| `size_bytes`    | INT UNSIGNED NOT NULL                                               | octets du corps reçu (fichiers inclus, même ignorés)                                |
| `received_at`   | DATETIME(3) NOT NULL                                                |                                                                                     |

Index : `idx_requests_endpoint_received (endpoint_id, received_at DESC)`, `idx_requests_received (received_at)`.

### `settings`

Inchangée. Seed `('retention_days', '10')`.

### Migration

Une migration `PivotToWebhooks` : `DROP TABLE emails`, création de `endpoints` et `requests` avec index et FK. Pas de reprise de données (les emails v1 n'ont aucune valeur).

Note : sur MariaDB, `JSON` est un alias de `LONGTEXT` avec contrainte de validité ; TypeORM `type: 'json'` fonctionne sur les deux. Vérifier le moteur réel sur o2switch en phase 1 (`SELECT VERSION()`).

---

## 4. API

### Routes de capture (sans préfixe)

| Méthode | Route      | Comportement                                                                                                                                                                                                                                                                                     |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ALL     | `/:uuid`   | Enregistre la requête, répond `200 {"ok":true,"id":"<request id>"}`. `404 {"ok":false,"error":"unknown endpoint"}` si l'endpoint n'existe pas (l'UUID est validé par regex avant toute lecture du corps). `413` si le corps dépasse `MAX_BODY_BYTES`. `HEAD` → 200 sans corps. En-têtes CORS `*` |
| ALL     | `/:uuid/*` | Idem, `path` = reste du chemin                                                                                                                                                                                                                                                                   |

Règles de capture :

1. Validation de l'UUID (regex v4, insensible à la casse, normalisé en minuscules) ; sinon la route n'est pas matchée (la SPA répond, ou 404 pour un asset inexistant).
2. `SELECT id FROM endpoints WHERE id=?` → 404 si absent. Le corps n'est pas lu.
3. Lecture du corps en flux (réutilisation de `raw-body.ts` du v1) avec compteur ; dépassement → `413` sans détruire le socket.
4. Classification `content_kind` :
   - absence de corps → `none` ;
   - `application/json`, `+json` → `json` (le corps reste stocké tel quel, formaté côté front ; JSON invalide → `text`) ;
   - `application/x-www-form-urlencoded` → `form`, `form_fields` via `URLSearchParams` ;
   - `multipart/form-data` → `multipart`, parsing en flux avec `busboy` : champs texte → `form_fields`, fichiers → comptés puis jetés → `dropped_files` ;
   - `text/html` → `html` ; `application/xml`, `text/xml`, `+xml` → `xml` ; `text/*` et absence de `Content-Type` → `text` (sniff : si le texte parse en JSON → `json`) ;
   - tout le reste (`image/*`, `application/octet-stream`, `application/pdf`, ...) → `binary`, corps non stocké, `size_bytes` renseigné.
5. Insertion, `UPDATE endpoints SET last_request_at=NOW(3)`, puis application du plafond : `DELETE FROM requests WHERE endpoint_id=? AND id NOT IN (SELECT id FROM (SELECT id FROM requests WHERE endpoint_id=? ORDER BY received_at DESC LIMIT :cap) t)`.
6. Émission `request:new` au gateway (en mémoire) et réponse 200.

### Routes REST (préfixe `/api`)

| Méthode | Route                          | Description                                                                                                                                                                        |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/health`                      | `{ status, db, retention_days, max_body_bytes }`                                                                                                                                   |
| POST    | `/endpoints`                   | Crée un endpoint. `201 { id, url, created_at }`. Pas de corps attendu                                                                                                              |
| GET     | `/endpoints/:id`               | `{ id, url, created_at, last_request_at, request_count, retention_days }`. 404 si inconnu                                                                                          |
| DELETE  | `/endpoints/:id`               | Supprime l'endpoint et ses requêtes (cascade). 204                                                                                                                                 |
| GET     | `/endpoints/:id/requests`      | Liste, tri `received_at DESC`, `?limit=50` (max 200), `?before=<ISO>` : `id, method, path, client_ip, content_kind, size_bytes, received_at, expires_at`                           |
| GET     | `/endpoints/:id/requests/:rid` | Détail : champs de la liste + `query_params, headers, content_type, body, form_fields, dropped_files, html_sanitized` (calculé à la volée si `content_kind = html`, jamais stocké) |
| DELETE  | `/endpoints/:id/requests/:rid` | 204                                                                                                                                                                                |
| DELETE  | `/endpoints/:id/requests`      | Vide l'inbox. 204                                                                                                                                                                  |

Règles :

- `:id` et `:rid` passent par `ParseUUIDPipe` (`400` sinon). Une requête dont l'`id` existe mais appartient à un autre endpoint → `404` (le service filtre toujours sur `{ id, endpointId }`).
- `url` = `PUBLIC_BASE_URL + '/' + id`.
- Les listes ne chargent jamais `body`, `headers`, `form_fields` (colonnes explicites `SUMMARY_COLUMNS` / `DETAIL_COLUMNS`, comme en v1).
- Réponses `Cache-Control: no-store`. CORS des routes `/api` : même origine en prod, `http://localhost:5173` en dev (inchangé). CORS des routes de capture : `*`, toutes méthodes, tous en-têtes, `Access-Control-Max-Age: 600`.
- Les routes `/api/endpoints` (POST sans corps) et `DELETE` n'ont pas besoin de parser JSON ; l'app reste en `bodyParser: false`. Si une route future a besoin de JSON, activer `express.json()` **sur cette route**.

### Socket.IO (`path: /api/socket.io`)

| Sens             | Événement          | Payload                                      |
| ---------------- | ------------------ | -------------------------------------------- |
| client → serveur | `subscribe`        | `{ endpointId }` (rejoint la room `ep:<id>`) |
| client → serveur | `unsubscribe`      | `{ endpointId }`                             |
| serveur → client | `request:new`      | `RequestSummary`                             |
| serveur → client | `request:deleted`  | `{ endpointId, id }`                         |
| serveur → client | `endpoint:cleared` | `{ endpointId }`                             |
| serveur → client | `endpoint:deleted` | `{ endpointId }`                             |

- `ChangeDetector` : toutes les 2 s, pour l'ensemble des rooms non vides, `SELECT <SUMMARY_COLUMNS> FROM requests WHERE endpoint_id IN (...) AND received_at > :since ORDER BY received_at` avec `since` = horodatage de la dernière détection (par endpoint). Émet `request:new` par ligne. Le client ignore les `id` déjà présents.
- Les suppressions ne sont pas détectées inter-process (événement en mémoire seulement) ; le client recharge de toute façon la liste à la reconnexion et sur action locale. Acceptable en v1.
- Limites : 10 abonnements par socket, `maxHttpBufferSize` 16 Ko (le client n'envoie que des ids).

---

## 5. Lecture du corps et sécurité

- L'HTML reçu est **non fiable**. `html_sanitized` est produit à la demande par le sanitiseur du v1 (`sanitize-html`, même whitelist : suppression `script`, `iframe`, `object`, `form`, `on*`, `style` avec `url(`, images distantes réécrites en `data-src`, liens `target=_blank rel=noopener noreferrer nofollow`). Le front le rend **uniquement** dans `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=...>` avec la CSP meta injectée. **Jamais `allow-same-origin`**, jamais `dangerouslySetInnerHTML` hors iframe. Le composant `EmailFrame` v1 est renommé `HtmlFrame` et conservé tel quel.
- Le JSON est affiché via `JSON.stringify(JSON.parse(body), null, 2)` dans un `<pre>` avec coloration minimale (tokens string/number/key) faite par un tokenizer maison, sans `innerHTML`.
- Les en-têtes et champs de formulaire sont affichés en texte dans des tableaux React (échappement natif).
- Le corps est stocké tel que reçu (pas de normalisation), limité à `MAX_BODY_BYTES` ; les corps `binary` et les fichiers ne touchent jamais la base.
- `trust proxy` activé uniquement si `TRUST_PROXY=1` (prod derrière Apache) pour que `req.ip` reflète le client et non `127.0.0.1`.
- Aucun secret partagé n'est plus nécessaire : `INGEST_SECRET` disparaît. La connaissance de l'UUID est la seule « clé », comme pour webhook.site.

---

## 6. Front React (`apps/web`)

- Vite + React 18 + TypeScript + React Router + Tailwind + `socket.io-client`. Pas de state manager global : `useAsync` (v1) + `useLiveRequests` + `useState`.
- Base URL de l'API : `/api` (même origine). URL publique d'un endpoint affichée = `window.location.origin + '/' + id` (identique à `url` renvoyé par l'API).
- Pages :
  - **Home `/`** : bouton **« Create endpoint »** (POST puis navigation vers `/inbox/<uuid>`), champ **« Open an existing endpoint »** acceptant un UUID ou une URL complète (`extractEndpointId()` partagé), liste **« Recent endpoints »** (localStorage, 10 derniers, avec suppression de la liste). Texte court : « Send any HTTP request to your endpoint URL and watch it appear here in real time. Requests are deleted after N days. »
  - **Inbox `/inbox/:uuid` et `/inbox/:uuid/:rid`** (même composant `InboxPage`, `:rid` = requête sélectionnée, ce qui rend chaque requête liable) : en-tête avec l'URL complète + **Copy**, **EndpointPicker** (champ permettant de saisir/coller un autre UUID ou de choisir un endpoint récent, puis navigation), badge **Live / Polling / Offline**, compteur `INBOX (n)`, boutons **New endpoint**, **Clear inbox** (confirmation), **Delete endpoint** (confirmation).
    - **Liste** (colonne gauche) : badge méthode coloré, `#short id`, IP, date/heure, taille. Nouvelle requête → insérée en tête avec surbrillance brève. « Load older » en bas si une page pleine a été reçue. Sélectionner une ligne met à jour `:rid` et le panneau de détail.
    - **Panneau de détail** (colonne droite, `RequestPanel`) : **toujours dans l'écran inbox**, jamais une page à part. Il contient, de haut en bas, trois sections repliables comme sur webhook.site : **Request Details & Headers**, **Query Parameters** (si présents) et **Request Content** (détail ci-dessous). À l'ouverture de l'inbox sans `:rid`, la requête la plus récente est sélectionnée automatiquement ; le panneau affiche « Select a request » si l'inbox est vide.
    - Desktop (≥ 1024 px) : liste et panneau côte à côte (≈ 1/3 – 2/3), chacun avec son propre défilement. Mobile : un seul des deux est visible ; la sélection d'une ligne fait glisser le panneau au premier plan avec un bouton « Back to inbox » qui revient à la liste **sans quitter la page ni perdre la connexion temps réel**.
    - État vide : « Waiting for requests… » + exemple `curl -X POST <url> -H 'Content-Type: application/json' -d '{"hello":"world"}'` avec bouton Copy.
    - Endpoint inconnu (404) : message « This endpoint does not exist or has expired » + bouton « Create a new endpoint ». `:rid` inconnu → le panneau affiche « Request not found » et la liste reste utilisable.
- **RequestPanel** (inspiré de la capture webhook.site, sans Share/Schedule/Export/Custom Actions/Replay/Redirect/Note) :
  - Section **Request Details & Headers**, en deux colonnes sur desktop (empilées sur mobile) :
    - gauche, `RequestDetailsTable` : badge méthode + URL complète appelée (`url + path + '?' + query`, bouton Copy), **Host** (en-tête `Host`), **Client IP**, **Date** (absolue + relative, ex. `06/10/2026 13:54:18 (a minute ago)`), **Size** (`size_bytes` lisible), **Content-Type**, **ID** complet (bouton Copy), **Expires** (`in X days`) ;
    - droite, `HeadersTable` : **tous** les en-têtes reçus, dans l'ordre d'arrivée, nom en minuscules et valeur en police mono, valeurs longues repliées avec retour à la ligne, bouton « Copy all » (format `name: value` par ligne). Les en-têtes ajoutés par Apache/Passenger (`x-forwarded-*`) sont affichés aussi, en grisé.
  - Section **Query Parameters** (`QueryParamsTable`, visible seulement si `query_params` non vide) : tableau nom / valeur, doublons conservés.
  - Section **Request Content** : barre de titre avec la vue active et bascule **Raw**, puis sélecteur de vue selon `content_kind` :
    - `json` → **Formatted** (défaut) / **Raw** ;
    - `form` / `multipart` → **Fields** (tableau) / **Raw** (pour `form` seulement) ; liste des fichiers ignorés « 2 file parts dropped (photo.jpg 1.2 MB, …) » ;
    - `html` → **Raw** (défaut) / **Preview** (iframe sandbox, bouton « Load images ») ;
    - `xml`, `text` → **Raw** ;
    - `none` → « No content » ; `binary` → « Binary content not stored (`image/png`, 48 kB) ».
  - Bouton **Delete** (puis sélection de la requête suivante, ou panneau vide si c'était la dernière).
  - Les données de détail (`headers`, `body`, …) sont chargées à la sélection via `GET /api/endpoints/:id/requests/:rid` et mises en cache en mémoire par `id` pendant la session de la page, pour que revenir sur une requête soit instantané.
- Responsive mobile-first, menus de confirmation natifs (`window.confirm`) en v1.
- Pas d'analytics, pas de tracking.

---

## 7. Configuration (`.env`)

```
NODE_ENV=production
PORT=3000                           # ignoré par Passenger
API_PREFIX=api
PUBLIC_BASE_URL=https://yo.manitra.fr   # base des URLs d'endpoint renvoyées par l'API
WEB_DIST_DIR=../web/dist            # SPA servie par Nest ; vide = ne pas servir (dev avec Vite)
TRUST_PROXY=1                       # 1 derrière Apache/Passenger, 0 en dev
DB_HOST=localhost
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=
MAX_BODY_BYTES=524288               # 512 Ko
MAX_REQUESTS_PER_ENDPOINT=500
RETENTION_DAYS_DEFAULT=10           # utilisé si la table settings est vide
CORS_ORIGIN=https://yo.manitra.fr   # routes /api seulement ; la capture est toujours en *
```

Supprimées : `MAIL_DOMAIN`, `INGEST_SECRET`, `MAX_EMAIL_BYTES`, tout `apps/ingest/.env`. Mettre `.env.example` à jour (dev : `DB_PORT=3307`, `WEB_DIST_DIR=` vide, `TRUST_PROXY=0`, `PUBLIC_BASE_URL=http://localhost:5173`).

Dev : Vite sur 5173 proxie vers 3000 les chemins `/api` (avec `ws: true` pour Socket.IO) **et** `^/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` (capture), afin que l'URL affichée (`http://localhost:5173/<uuid>`) fonctionne telle quelle depuis Postman.

---

## 8. Phases d'exécution pour Claude Code

### Phase 0 — Pivot et nettoyage

- Supprimer `apps/ingest`, `apps/api/src/ingest`, `apps/api/src/emails`, `apps/api/src/inbox`, les fixtures `.eml`, `make-oversized.cjs`, les dépendances `mailparser` et `@types/mailparser`. Conserver `ingest/raw-body.ts` (déplacé dans `capture/`) et `ingest/html-sanitizer.ts` (déplacé dans `requests/`).
- `packages/shared` : remplacer les DTO email par `EndpointSummary`, `RequestSummary`, `RequestDetail`, `RequestListResponse`, `ContentKind`, `HealthStatus`, `LiveEvents` (types des événements Socket.IO), `ENDPOINT_ID_REGEX`, `extractEndpointId(input)` (UUID ou URL → UUID minuscule ou `null`).
- `config/env.ts` : nouvelles variables (§7). `.env.example` et `docker-compose.yml` ajustés.
- Réécrire `CLAUDE.md` (§9) et la description des `package.json`. `apps/web` : retirer les pages v1, garder `Layout`, `CopyButton`, `Feedback`, `useAsync`, `client.ts`, `EmailFrame` → `HtmlFrame`.
- `scripts/deploy.sh` : retirer `apps/ingest` de la liste, ajouter `apps/web/dist` dans l'upload de `~/yomail` (plus de copie vers le docroot, voir phase 6).
- **Acceptation** : `npm run build`, `npm run lint`, `npm run typecheck` passent ; `GET /api/health` répond ; aucune référence à `ingest`, `email`, `local_part`, `MAIL_DOMAIN` dans `apps/` et `packages/` (`grep -ri`).

### Phase 1 — Base de données

- Entités `Endpoint`, `Request` (colonnes snake_case explicites, `content_kind` en `enum`, colonnes JSON avec `type: 'json'`).
- Migration `PivotToWebhooks` : drop `emails`, create `endpoints`, `requests`, index, FK cascade. Ajout à `migrations/index.ts`.
- **Acceptation** : `npm run migration:run -w apps/api` sur la MySQL docker ; `migration:generate` ne produit **aucun diff** après coup ; `migration:revert` restaure ; `/api/health` → `db: ok`.

### Phase 2 — Capture

- `CaptureModule` : `CaptureController` avec `@All(':uuid')` et `@All(':uuid/*')`, exclu du préfixe global (`setGlobalPrefix('api', { exclude: [...] })`), pipe UUID v4, garde d'existence de l'endpoint, lecture en flux limitée, classification, parsing `form` (`URLSearchParams`) et `multipart` (`busboy`), capture `rawHeaders`, `req.ip`, query (`URLSearchParams` sur `req.url`), insertion, mise à jour `last_request_at`, plafond par endpoint, en-têtes CORS, réponse 200/404/413, `HEAD`.
- `POST /api/endpoints` (création seule) est livré dès cette phase pour que le script de test crée ses endpoints ; le reste de l'API REST reste en phase 3.
- Fixtures de test manuel dans `apps/api/test/requests/` : fichiers `.json`, `.html`, `.xml`, `.txt`, un script `send-all.sh` qui envoie chaque cas en `curl` (JSON, form, multipart avec champ fichier, HTML, XML, texte, binaire, sans corps, GET avec query, PUT, PATCH, DELETE, OPTIONS, HEAD, > 512 Ko, UUID inconnu, UUID mal formé).
- **Acceptation** : chaque cas de `send-all.sh` renvoie le code attendu ; en base, `content_kind`, `form_fields`, `dropped_files`, `query_params`, `headers`, `client_ip`, `size_bytes` sont corrects ; la 501e requête d'un endpoint supprime la plus ancienne ; un corps > 512 Ko donne `413` et aucune ligne.

### Phase 3 — API REST et purge

- `EndpointsModule` (`POST`, `GET`, `DELETE`), `RequestsModule` (liste paginée, détail avec `html_sanitized` à la volée, suppressions), calcul `expires_at`, 404 croisés, `no-store`, CORS `/api`.
- `PurgeService.run()` : suppression par lots de 1000 des `requests` avec `received_at < cutoff`, puis `DELETE FROM endpoints WHERE COALESCE(last_request_at, created_at) < cutoff` ; `--dry-run` compte les deux. Cron cPanel et job horaire interne conservés.
- **Acceptation** : parcours `curl` complet (create, detail, list, pagination `before`, detail d'une requête, delete, clear, delete endpoint → requêtes disparues) ; `400` sur UUID mal formé ; `404` si `rid` appartient à un autre endpoint ; purge : une requête datée de 11 jours est supprimée, un endpoint inactif de 11 jours est supprimé, `retention_days=30` en base les conserve.

### Phase 4 — Temps réel

- `LiveModule` : `LiveGateway` (`@nestjs/websockets` + `@nestjs/platform-socket.io`, `path` = `/${API_PREFIX}/socket.io`, CORS identique à `/api`), rooms `ep:<id>`, `ChangeDetector` (poll 2 s, uniquement si des rooms sont actives, re-entrancy flag), émission depuis `CaptureService` et `RequestsService` via un `EventEmitter` interne.
- Script de vérification `apps/api/test/live-client.cjs` (`socket.io-client`, s'abonne à un endpoint, affiche les événements).
- **Acceptation** : avec deux instances de l'API (`PORT=3000` et `PORT=3010`, même base), un client abonné sur 3010 reçoit en moins de 3 s une requête capturée sur 3000 ; en forçant `transports: ['polling']` côté client, le comportement est identique ; aucun doublon côté client.

### Phase 5 — Front

- Pages Home / Inbox (liste + `RequestPanel` : details, headers, query, content), `useLiveRequests` (Socket.IO + repli polling 5 s + rechargement à la reconnexion), `EndpointPicker`, `recentEndpoints`, viewers par type, `HtmlFrame` + « Load images », états chargement/erreur/vide/404, responsive master-detail.
- Proxy Vite `/api` (ws) et chemins UUID → 3000.
- **Acceptation** : scénario manuel desktop + mobile : créer un endpoint, copier l'URL, envoyer depuis Postman un POST JSON, un formulaire, un HTML, un GET avec query ; chaque requête apparaît sans rafraîchir ; la sélectionner affiche dans le même écran ses détails (méthode, URL, IP, date, taille, ID) et la totalité de ses en-têtes ; les vues Formatted/Fields/Preview/Raw sont correctes ; Preview n'exécute pas de script et ne charge pas d'image avant « Load images » ; changer d'endpoint via le champ de sélection ; Clear et Delete endpoint ; rouvrir un endpoint depuis « Recent » ; couper l'API → badge Offline, relancer → reconnexion et liste à jour.

### Phase 6 — Déploiement cPanel

- `StaticModule` : `ServeStaticModule.forRoot({ rootPath: WEB_DIST_DIR, exclude: ['/api/{*path}'], serveStaticOptions: { immutable + maxAge 1 an pour assets hashés, index.html en no-cache } })`, activé seulement si `WEB_DIST_DIR` est renseigné. Vérifier localement que l'ordre est : API → capture → asset → `index.html`.
- cPanel _Setup Node.js App_ : supprimer l'app existante, en recréer une avec **Application URL = `yo.manitra.fr` (racine)**, même root `yomail/apps/api`, startup `dist/main.js`. Le docroot `~/yo.manitra.fr` ne contient plus que le `.htaccess` (bloc Passenger de cPanel + `deploy/htaccess` réduit : `PassengerStickySessions on`, en-têtes de sécurité, suppression des règles SPA).
- `scripts/deploy.sh` : uploader `apps/web/dist` dans `~/yomail/apps/web/dist`, ne plus toucher au docroot sauf fusion `.htaccess`, retirer le `chmod` du pipe.
- cPanel _Default Address_ : remettre `:fail:` ou _Discard_ (le pipe Exim est abandonné). Supprimer `~/yomail/apps/ingest`.
- Vérifier `req.ip` (si `127.0.0.1`, examiner `X-Forwarded-For` et ajuster `TRUST_PROXY`), le transport Socket.IO effectif (console réseau : `transport=polling` attendu), l'affinité de session avec plusieurs onglets ouverts, et que `curl -I https://yo.manitra.fr/assets/<hash>.js` renvoie `immutable`.
- Réécrire `docs/DEPLOY_CPANEL.md` (sections mail/pipe supprimées, nouvelle Application URL, table de vérification du préfixe conservée, nouvelle section temps réel).
- **Acceptation** : depuis Postman, `POST https://yo.manitra.fr/<uuid>` apparaît en direct dans `https://yo.manitra.fr/inbox/<uuid>` ; `https://yo.manitra.fr/inbox/<uuid>` chargée directement (deep link) fonctionne ; `GET /api/health` ok ; log du cron de purge présent.

### Phase 7 — Ultérieur (hors v1)

- Réponse configurable par endpoint (status, content-type, corps, en-têtes, délai) et bouton **Edit** dans l'UI.
- Recherche/filtre côté client (méthode, chemin, IP, contenu), **Replay** (renvoyer la requête vers une URL), export cURL d'une requête, notes.
- Anti-abus : rate limiting par IP sur la capture et sur `POST /api/endpoints`, plafond global de lignes, blocage d'IP.
- Tests : Jest unitaires (classification, parseurs, sanitizer, purge), e2e Supertest (capture, REST, gateway) avec MySQL docker ; CI.
- Observabilité : compteur de requêtes capturées/rejetées, logs structurés.
- Troncature du corps au lieu du `413` (stocker les N premiers Ko avec un marqueur `truncated`).

---

## 9. Contenu de `CLAUDE.md` (à réécrire en phase 0)

Conserver les sections opérationnelles encore valables (monorepo, commandes, migrations, cPanel : chemins, `npm ci` à la racine, `.env` seul source de config, préfixe Passenger, purge) et remplacer le reste par :

```md
# yomail — webhook catcher for yo.manitra.fr

## Context

Webhook catcher (webhook.site-like). A user creates an endpoint (server-generated UUID v4) and sends any HTTP request to
https://yo.manitra.fr/<uuid>[/sub/path]; requests show up live in /inbox/<uuid>. No auth: knowing the UUID is the only key.
Hosting: cPanel shared (no root), Node 22, MySQL, Passenger mounted at the ROOT of the subdomain; Nest serves the SPA from
apps/web/dist. Passenger on Apache has no WebSocket support: Socket.IO runs over long-polling there, and the client falls back to
REST polling (5 s) when the socket is down. Retention: settings.retention_days (default 10) per request, never stored as expires_at;
endpoints idle longer than that are purged. See docs/PLAN.md.

## Key invariants

- Capture routes (`/:uuid`, `/:uuid/*`) are excluded from the `/api` prefix, answer 200 `{ok:true,id}` with CORS `*`, 404 for
  unknown endpoints before reading any body, 413 above MAX_BODY_BYTES (nothing stored). Max 500 requests per endpoint (oldest dropped).
- Request bodies are untrusted text. HTML is sanitized on read (never stored sanitized) and rendered only inside
  `<iframe sandbox>` without `allow-same-origin`; JSON is pretty-printed as text. Never use dangerouslySetInnerHTML outside the iframe.
- Files and binary bodies are never stored (multipart file parts are counted and dropped; binary content types keep metadata only).
- Live updates must work across several Passenger processes: the gateway polls the DB for subscribed endpoints every 2 s in
  addition to in-memory events; clients dedupe by id.
- Lists never select body/headers/form_fields columns. ParseUUIDPipe on ids; an id from another endpoint is a 404.
- TypeORM synchronize: false; every schema change is a migration listed in migrations/index.ts.

## Don'ts

- Don't add `allow-same-origin` to the HTML preview iframe.
- Don't store expires_at or html_sanitized.
- Don't read the request body before the endpoint existence check.
- Don't rely on WebSocket being available in production; keep the polling fallback working.
```

---

## 10. Outils de test manuel

- Création : `curl -s -X POST http://localhost:3000/api/endpoints` → `{ "id": "...", "url": "..." }`.
- Capture : `curl -i -X POST http://localhost:3000/<uuid>/orders -H 'Content-Type: application/json' -d '{"hello":"world"}'`, `curl -i "http://localhost:3000/<uuid>?a=1&a=2"`, `curl -i -X PUT http://localhost:3000/<uuid> -F name=bob -F file=@photo.jpg`, `curl -i -X POST http://localhost:3000/<uuid> -H 'Content-Type: image/png' --data-binary @img.png` (→ `binary`), `head -c 600000 /dev/zero | curl -i -X POST http://localhost:3000/<uuid> --data-binary @-` (→ 413).
- Lecture : `curl -s "http://localhost:3000/api/endpoints/<uuid>/requests?limit=10"`, puis `/requests/<rid>`.
- Temps réel : `node apps/api/test/live-client.cjs <uuid>` dans un terminal, capture dans un autre.
- Depuis Postman en prod : collection avec les mêmes cas sur `https://yo.manitra.fr/<uuid>`.
- SPA headless (sans outil navigateur) : `chrome --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom http://localhost:5173/inbox/<uuid>` ; captures mobile avec `--screenshot --window-size=390,844`.

---

## 11. Risques et points de vigilance

| Risque                                                                                 | Mitigation                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pas de WebSocket sous Apache/Passenger                                                 | Socket.IO en long-polling ; polling REST 5 s côté client ; badge d'état visible. Vérifié en phase 6, pas de code spécifique au transport          |
| Plusieurs process Passenger : événements en mémoire perdus, long-polling sans affinité | `ChangeDetector` sur la base (2 s) ; `PassengerStickySessions on` dans `.htaccess` ; déduplication client ; rechargement à la reconnexion         |
| Passenger met l'app en veille                                                          | Moins gênant qu'en v1 : la première requête réveille l'app et le client Socket.IO se reconnecte seul. Purge toujours pilotée par le cron cPanel   |
| Conflit de routage racine (`/:uuid` vs SPA vs assets)                                  | Regex UUID stricte sur la route de capture ; ServeStatic enregistré après les contrôleurs ; `exclude` sur `/api` ; test d'ordre en phase 6        |
| Montage Passenger à la racine : préfixe `/api` strippé ou non                          | Table de vérification v1 conservée (`API_PREFIX=` vide si besoin) ; le chemin Socket.IO suit `API_PREFIX`                                         |
| `req.ip` = `127.0.0.1` derrière Apache                                                 | `TRUST_PROXY=1` + `X-Forwarded-For` ; vérifier en phase 6                                                                                         |
| Endpoint « deviné » ou partagé par erreur                                              | UUID v4 (122 bits) ; aucune énumération possible (pas de liste d'endpoints) ; suppression par quiconque connaît l'UUID, assumé comme webhook.site |
| Inondation d'un endpoint ou création massive d'endpoints                               | Plafond 500 par endpoint, 512 Ko par corps, purge 10 jours ; rate limiting en phase 7                                                             |
| Contenu HTML/JSON malveillant                                                          | Sanitisation à la lecture + iframe sandbox + CSP ; JSON rendu en texte ; en-têtes en texte                                                        |
| `max_allowed_packet` MySQL mutualisé                                                   | Corps ≤ 512 Ko, bien en dessous des 4 Mo déjà vérifiés en v1                                                                                      |
| Colonnes JSON sur MariaDB                                                              | `type: 'json'` TypeORM compatible ; vérifier `SELECT VERSION()` et l'absence de diff `migration:generate` sur le moteur de prod                   |

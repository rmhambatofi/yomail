# Plan d'implémentation v2 — Webhook catcher `yo.manitra.fr`

> Ce document remplace le plan « boîte email jetable » (archivé dans `docs/archive/PLAN_v1_mailbox.md`).
> Le pivot est décidé le 2026-10-06 : la réception SMTP via pipe Exim n'est pas exploitable sur l'hébergement cPanel.
> Le projet devient un **webhook catcher** (type webhook.site). Le socle technique (monorepo, NestJS + TypeORM + MySQL, React + Vite, déploiement Passenger) est conservé ; le domaine métier est remplacé.
> Le 2026-10-07, après les phases 0 à 6, les comptes utilisateurs sont ajoutés (phase 7, conception en §12) ; les fonctionnalités de l'ancienne phase « ultérieur » deviennent la phase 8, réservée aux inscrits.
> Chaque phase est autonome, livrable et vérifiable. Ne pas passer à la phase suivante tant que les critères d'acceptation ne sont pas validés.

---

## 0. Récapitulatif des décisions

| Sujet              | Décision                                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Produit            | Webhook catcher : l'utilisateur crée un endpoint, y envoie des requêtes HTTP (Postman, code, service tiers) et les consulte en temps réel dans une « inbox ». Aucune authentification : quiconque connaît l'UUID voit l'inbox                                                             |
| Endpoint           | `https://yo.manitra.fr/<uuid>` avec sous-chemin optionnel (`/<uuid>/any/sub/path`). UUID v4 généré **côté serveur** à la création, ce qui exclut les doublons                                                                                                                             |
| Méthodes capturées | GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD (toutes). Query string, en-têtes, corps et IP du client sont enregistrés                                                                                                                                                                     |
| Réponse au client  | **Fixe en v1** : `200` + `{"ok":true,"id":"<request id>"}` (`application/json`). `HEAD` → 200 sans corps. CORS ouvert (`*`) sur les routes de capture. Réponse configurable = phase ultérieure                                                                                            |
| Contenus           | JSON, formulaire (`x-www-form-urlencoded`, `multipart/form-data` champs texte), HTML, XML, texte. **Pas de fichiers ni de médias** : les parties fichier d'un multipart sont ignorées (nom/taille notés), les corps binaires ne sont pas stockés                                          |
| Taille max         | 512 Ko de corps par requête (`MAX_BODY_BYTES`), au-delà : `413`, rien n'est enregistré                                                                                                                                                                                                    |
| Volume             | 500 requêtes max par endpoint (`MAX_REQUESTS_PER_ENDPOINT`) : à l'insertion, les plus anciennes au-delà du plafond sont supprimées                                                                                                                                                        |
| Rétention          | 10 jours **par requête**, valeur globale en base (table `settings`, conservée). Un endpoint sans activité depuis plus de `retention_days` est supprimé                                                                                                                                    |
| Temps réel         | **Oui.** Socket.IO (WebSocket avec repli automatique en long-polling HTTP). Sur cPanel/Apache, Passenger ne supporte pas WebSocket : le long-polling sera le transport effectif. Repli ultime côté client : polling REST toutes les 5 s                                                   |
| Rendu              | Adapté au type : JSON formaté, formulaire en tableau clé/valeur, HTML en « Raw » + « Preview » dans une iframe sandbox (sanitisation serveur), XML/texte en `<pre>`. « Raw » toujours disponible                                                                                          |
| Hébergement        | Inchangé : cPanel mutualisé o2switch (sans root), Node 22, MySQL, Passenger. **L'app Node est désormais montée à la racine** de `yo.manitra.fr` et sert elle-même la SPA (plus de `.htaccess` SPA)                                                                                        |
| Stack              | NestJS 10 + TypeORM + MySQL / React 18 + Vite + TypeScript + Tailwind / Socket.IO                                                                                                                                                                                                         |
| Monorepo           | npm workspaces, nom `yomail` conservé (pas de renommage des packages)                                                                                                                                                                                                                     |
| Langue UI          | Anglais                                                                                                                                                                                                                                                                                   |
| Hors périmètre v1  | Réponse configurable, recherche/filtre, replay, export, notes, géolocalisation IP, auth (ajoutée en phase 7 le 2026-10-07, voir §12), rate limiting, tests automatisés, CI                                                                                                                |
| Comptes (phase 7)  | Inscription username + email + mot de passe, confirmation par email (statut `DISABLED` → `ENABLED`), rôles `ADMIN` (CLI seulement) / `STANDARD`, sessions en base, SMTP cPanel. Les fonctions de la phase 8 seront réservées aux inscrits ; l'usage anonyme reste possible. Détail en §12 |

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

Phase 7 (comptes, §12) ajoute dans `apps/api/src/` : `users/` (entités `User`, `Session`, `UserToken`, `UsersService`, `PasswordService`), `auth/` (contrôleurs `/api/auth` et `/api/account`, sessions, jetons, gardes, pipe zod), `mail/` (`MailService`, templates), `cli/user.ts` ; dans `apps/web/src/` : `lib/auth.tsx`, pages `SignupPage`, `LoginPage`, `ConfirmPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `AccountPage`, composants de formulaire ; dans `packages/shared` : types et constantes utilisateur.

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

Phase 7 : tables `users`, `sessions`, `user_tokens` et colonne `endpoints.owner_id` (migration `AddUsers`), voir §12.2.

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

Phase 7 : routes `/api/auth/*` et `/api/account` (JSON, cookie de session), voir §12.3 ; `POST /api/endpoints` renseigne `owner_id` quand une session est présente. Phase 8 : routes membres (`/api/account/endpoints`, `PATCH /api/endpoints/:id`, `claim`, notes, replay) et réponse configurable, voir §13.

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

Phase 7 : variables `SESSION_TTL_DAYS`, `*_TOKEN_TTL_*`, `UNCONFIRMED_USER_TTL_DAYS`, `AUTH_RATE_*`, `SMTP_*` (production seulement), `MAIL_FROM`, voir §12.8 ; hors production les emails sont capturés sur `/devmailcatcher` (qui existe aussi en production, pour d'autres applications).

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

### Phase 7 — Comptes utilisateurs (inscription, confirmation par email, connexion)

> Ajoutée le 2026-10-07. Conception détaillée en §12 ; cette section ne donne que le découpage et les critères d'acceptation. Les fonctionnalités de la phase 8 seront réservées aux utilisateurs inscrits (gratuitement dans un premier temps) ; la phase 7 ne livre que les comptes eux-mêmes. **Le comportement anonyme actuel ne change pas** : créer un endpoint et ouvrir une inbox par UUID restent possibles sans compte, la phase 7 ne met rien derrière une connexion.

Chaque sous-phase est livrable et vérifiable ; ne pas commencer la suivante tant que l'acceptation de la précédente ne passe pas.

#### 7.1 — Données et purge

- `packages/shared` : `UserRole`, `UserStatus`, `UserProfile`, `AuthErrorCode`, DTO des réponses auth (§12.3), constantes `USERNAME_REGEX`, `USERNAME_MIN_LENGTH`, `USERNAME_MAX_LENGTH`, `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `EMAIL_MAX_LENGTH` (source unique des règles pour l'API, le front et la CLI, comme `ENDPOINT_ID_REGEX`).
- Entités `User`, `Session`, `UserToken` (§12.2) dans `apps/api/src/users/` ; colonne `endpoints.owner_id` nullable sur `Endpoint` (`fk_endpoints_owner`, `ON DELETE SET NULL`, index `idx_endpoints_owner`).
- Migration `AddUsers` (tables `users`, `sessions`, `user_tokens`, colonne + FK + index sur `endpoints`), ajoutée à `migrations/index.ts`.
- `PurgeService.run()` étendu, dans cet ordre après les requêtes et endpoints : `sessions` expirées, `user_tokens` expirés ou utilisés, comptes `DISABLED` jamais confirmés (`enabled_at IS NULL`) créés il y a plus de `UNCONFIRMED_USER_TTL_DAYS` (suppression **physique**, qui libère l'email ; cascade sur sessions/jetons ; `owner_id` → NULL par la FK). `--dry-run` compte les trois ; le rapport et la ligne de log du cron les affichent.
- **Acceptation** : `migration:run` sur la MySQL docker ; `migration:generate` ne produit aucun diff ; `migration:revert` restaure (y compris la suppression de `owner_id` et de sa FK) ; `purge:dry-run` affiche les nouveaux compteurs à 0 ; `npm run build`, `lint`, `typecheck` passent ; la capture et l'API existantes sont inchangées (`send-all.sh` et `rest-flow.sh` passent).

#### 7.2 — Envoi d'email

- `MailModule` / `MailService.send({ to, subject, text, html })` sur `nodemailer`. **Le transport suit l'environnement, pas une variable** : `NODE_ENV=production` → SMTP du compte mail cPanel (§12.5) ; tout autre environnement → aucun envoi, le message est stocké par `DevMailboxService` (table `caught_mails`) et consultable sur le **dev mail catcher** `http://localhost:<PORT>/devmailcatcher` (chemin fixe, hors préfixe `/api`). `isProduction(NODE_ENV)` dans `config/env.ts` est le seul point de décision (ajouté le 2026-10-07 à la demande de l'utilisateur, à la place de Mailpit et du transport `console`).
- Templates en code (`mail/templates.ts`, pas de moteur de template) : `confirmEmail({ username, link })` et `resetPassword({ username, link })`, texte + HTML minimal avec un **bouton** (lien stylé inline, pas d'image), en anglais, pied « If you did not create an account, ignore this email ».
- Dev mail catcher (`mail/dev-mail-catcher.controller.ts`) : `GET /devmailcatcher` (liste HTML, bouton Clear), `GET /devmailcatcher/:id` (en-têtes, texte, HTML dans une iframe `sandbox` servie par `GET /devmailcatcher/:id/html` avec CSP `default-src 'none'`), `GET /devmailcatcher/messages.json?to=<email>` (pour les scripts : `{ id, to, from, subject, text, html, sentAt, links[] }`), `POST /devmailcatcher/messages.json` (ingestion : `{ to, subject, from?, text?, html? }`, 96 Ko max, `text` ou `html` requis → `201` + message ; `400 VALIDATION` sinon), `DELETE /devmailcatcher`. Aucun service docker supplémentaire. **Depuis le 2026-10-07, réservé au rôle `ADMIN`** (`AuthGuard` + `RolesGuard` : `401` sans session, `403` pour un membre `STANDARD`) : les messages contiennent les liens de confirmation et de réinitialisation de tous les comptes. La page `/account` d'un admin affiche une section « Administration » avec le bouton **Open the dev mail catcher**. **Depuis le 2026-10-07 (décision de l'utilisateur), le catcher existe aussi en production** : il sert de puits à e-mails pour le développement d'autres applications, qui poussent leurs messages via le `POST` (avec le cookie d'une session admin). Pour cela il est passé de la mémoire du processus à la table `caught_mails` (migration `AddCaughtMails`, 200 lignes max, les plus anciennes supprimées à l'insertion) : Passenger lance plusieurs processus et le navigateur de l'admin ne tombe pas forcément sur celui qui a reçu le `POST`. En production les e-mails de yomail partent toujours en SMTP et ne sont jamais copiés dans le catcher.
- Un échec d'envoi est loggé (`MailService` ne lève pas) ; les appelants décident (§12.3 : l'inscription réussit quand même, « Resend » existe).
- **Acceptation** : hors production, une inscription fait apparaître le message sur `/devmailcatcher` (liste, détail, lien d'activation extrait dans `links`, HTML rendu dans l'iframe sandbox) et le log de l'API cite `/devmailcatcher/<id>` ; `NODE_ENV=production` sans `SMTP_HOST` → l'API refuse de démarrer en nommant la clé ; `/devmailcatcher` répond `401` sans session, `403` pour un membre, `200` pour un admin, en production comme ailleurs ; `POST /devmailcatcher/messages.json` → `401` anonyme, `400` sans `to` ou sans contenu, `201` pour un admin et le message est listé (`?to=`), consultable, et visible depuis un autre processus (même base) ; SMTP injoignable → erreur loggée, l'API reste en vie.

#### 7.3 — API d'authentification et de compte

- `UsersModule` : `UsersService` (création, recherche par email ou username, transitions de statut, anonymisation à la suppression), `PasswordService` (hachage et vérification `scrypt`).
- `AuthModule` : `AuthController` (`/api/auth/*`), `AccountController` (`/api/account`), `SessionsService` (création, lecture par hash, révocation, `last_seen_at`), `TokensService` (jetons email single-use), `AuthGuard` (401 si pas de session valide ou utilisateur non `ENABLED`), `OptionalAuthGuard` (attache l'utilisateur s'il existe, ne refuse jamais), décorateur `@CurrentUser()`, `RolesGuard` + `@Roles('ADMIN')` (livrés, inutilisés en phase 7), `ZodValidationPipe` (schémas zod par route, `400` avec la liste des champs en erreur).
- Parsing JSON **limité aux contrôleurs auth/account** : `consumer.apply(json({ limit: '16kb' })).forRoutes(AuthController, AccountController)` ; l'app reste en `bodyParser: false`. `cookie-parser` monté globalement (lecture seule, inoffensif pour la capture).
- `@nestjs/throttler` sur `signup`, `login`, `confirm`, `resend-confirmation`, `forgot-password`, `reset-password` : 10 requêtes par 15 min et par IP (mémoire du process, §12.9), `429`.
- `POST /api/endpoints` : `owner_id` renseigné quand la requête porte une session valide (`OptionalAuthGuard`), NULL sinon. Aucune autre route existante ne change.
- Script de test `apps/api/test/auth/auth-flow.sh [BASE_URL]` (curl + `GET /devmailcatcher/messages.json?to=` pour récupérer les liens, avec la session d'un admin jetable créé par `dist/cli/user.js` au début du script ; l'API doit tourner hors production et `apps/api` doit être compilé).
- **Acceptation** (via le script) : signup → `201` ; même email → `409 EMAIL_TAKEN`, même username avec une autre casse → `409 USERNAME_TAKEN` ; username/mot de passe invalides → `400` ; login avant confirmation → `403 ACCOUNT_DISABLED` ; lien récupéré dans le dev mail catcher → confirm → `200` + cookie + profil `ENABLED` ; jeton rejoué → `400 TOKEN_INVALID` ; `me` → profil ; logout → `me` `401` ; login par email puis par username → cookie ; mauvais mot de passe et compte inconnu → même `401 INVALID_CREDENTIALS` ; `POST /api/endpoints` avec cookie → `owner_id` renseigné en base, sans cookie → NULL ; forgot → email → reset → les sessions précédentes sont invalides, le nouveau mot de passe fonctionne, l'ancien non ; change password → les autres sessions sont révoquées, la courante reste ; delete account → `401` ensuite, ligne `DELETED` anonymisée, les endpoints restent avec `owner_id` NULL ; 11e login en 15 min → `429` ; corps > 16 Ko → `413` ; la capture `send-all.sh` passe toujours.

#### 7.4 — CLI admin

- `src/cli/user.ts` → `dist/cli/user.js` (même `rootDir` que `purge.ts`, pas de `bin/`), contexte Nest sans HTTP ni scheduler (`ConfigModule` + `DatabaseModule` + `UsersModule`), commande `create-admin --username <u> --email <e> [--password <p>]`. Mot de passe : `--password`, sinon variable `YOMAIL_USER_PASSWORD`, sinon saisie masquée sur le TTY (`readline`, echo coupé) ; l'option `--password` est déconseillée dans l'usage (historique du shell). Compte créé `ENABLED` + `ADMIN`, `enabled_at = now`, **aucun email envoyé**. Mêmes règles de validation que l'inscription (constantes partagées).
- Scripts `npm run user -w apps/api -- create-admin ...` et `user:dev` (ts-node). Toute inscription web reste `STANDARD` : il n'existe aucune route API qui crée ou promeut un `ADMIN`.
- **Acceptation** : création → ligne `ADMIN`/`ENABLED` en base et login possible via l'API ; email ou username déjà pris → code 1 et message explicite ; mot de passe < 8 → code 1 ; sans sous-commande ou `--help` → usage, code 2 ; fonctionne depuis `dist/` (`npm run build` puis `npm run user`).

#### 7.5 — Front

- `lib/auth.tsx` : `AuthProvider` (appelle `GET /api/auth/me` au montage ; expose `user | null`, `loading`, `refresh()`, `logout()`), hook `useAuth()`, composant `RequireAuth` (redirige vers `/login?next=<path>` quand `loading` est fini et `user` est null).
- `Layout` : à droite de l'en-tête, bouton **« Sign in / Sign up »** (→ `/login`) quand déconnecté ; `username` (→ `/account`) + **« Sign out »** quand connecté. Le pied de page sur les endpoints publics reste.
- Pages : `/signup`, `/login` (champ « Email or username », « Forgot password? », « Create an account », `?next=`), `/confirm/:token` (appelle `POST /api/auth/confirm` au montage ; succès → « Your account is active » + bouton Home, connecté ; échec → message + champ email « Resend the confirmation email »), `/forgot-password`, `/reset-password/:token`, `/account` (protégée : profil, rôle, formulaire de changement de mot de passe, suppression de compte avec confirmation et mot de passe). Composants `AuthForm`/`Field`/`PasswordField` partagés ; les codes `AuthErrorCode` sont traduits en messages ; validation native (`minLength`, `pattern`, `type=email`) doublée des messages serveur.
- `api/client.ts` : méthodes auth/account ; `fetch` reste en `credentials: 'same-origin'` (défaut, SPA et API partagent l'origine, y compris via le proxy Vite) ; un `401` reste une `ApiError` ordinaire, pas de redirection globale.
- **Acceptation** (desktop + mobile, headless Chrome comme en phase 5) : inscription → message « Check your inbox » → lien ouvert depuis `/devmailcatcher` → page de confirmation → en-tête affichant le username ; login d'un compte non confirmé → message + Resend fonctionnel ; mauvais mot de passe → message ; `/account` sans session → `/login?next=/account` puis retour sur `/account` après connexion ; rechargement de page → toujours connecté ; changement de mot de passe ; suppression → retour Home, déconnecté ; Sign out → bouton « Sign in / Sign up » de retour ; HomePage et InboxPage inchangées pour un anonyme ; un endpoint créé connecté a bien `owner_id` renseigné.

#### 7.6 — Déploiement et documentation

- cPanel : créer la boîte `no-reply@manitra.fr` (_Email Accounts_), relever hôte et port SMTP (`465` SSL, voir _Connect Devices_), renseigner `SMTP_*`/`MAIL_FROM` dans `~/yomail/apps/api/.env` (`NODE_ENV=production` y est déjà : c'est lui qui active le SMTP) ; vérifier SPF/DKIM du domaine dans _Email Deliverability_ ; ajouter les clés de §12.8 avec leurs défauts.
- `npm run deploy` (la migration `AddUsers` s'exécute), puis `create-admin` sur le serveur via un one-liner `ssh` donné à l'utilisateur (`cd ~/yomail/apps/api && YOMAIL_USER_PASSWORD=... ~/nodevenv/yomail/apps/api/22/bin/node dist/cli/user.js create-admin --username ... --email ...`).
- `docs/DEPLOY_CPANEL.md` (section « Comptes » : variables, boîte mail, commande admin, checklist), `README.md`, `docs/ARCHITECTURE.md` (composants, cycle de vie d'un compte, modèle de données) et `CLAUDE.md` mis à jour ; diagrammes Archify régénérés si le schéma de données est cité.
- **Acceptation prod** : inscription avec une vraie adresse (Gmail) → email reçu hors spam, bouton → compte activé et connecté ; session conservée avec plusieurs process Passenger (deux onglets, `me` toujours `200`, cookie `Secure` présent) ; cron de purge logue les nouveaux compteurs ; l'admin créé en CLI se connecte ; `send-all.sh https://yo.manitra.fr` passe toujours.

### Phase 8 — Fonctionnalités réservées aux utilisateurs inscrits

> Ajoutée le 2026-10-07, conception détaillée en §13. Réservées aux comptes `ENABLED` (gratuit dans un premier temps). **Le comportement anonyme ne change pas** : créer un endpoint et lire une inbox par UUID restent possibles sans compte ; un endpoint anonyme n'a simplement pas ces fonctions. Règle unique : ce qui modifie le serveur (nom, réponse, notes, replay, suppression d'un endpoint possédé) est réservé au **propriétaire** de l'endpoint ; ce qui est purement côté client (filtre, export cURL) est offert à tout utilisateur connecté. Un membre peut **revendiquer** (claim) un endpoint sans propriétaire pour en faire le sien. **Révision du 2026-10-07 : un endpoint possédé est privé.** Son détail, son inbox (liste, détail, suppression, vidage) et sa room Socket.IO ne sont servis qu'à son propriétaire (`401 UNAUTHENTICATED` sans session, `403 NOT_OWNER` pour un autre membre) ; seule la capture reste ouverte à tous. Un endpoint anonyme reste lisible par quiconque connaît l'UUID.

Chaque sous-phase est livrable et vérifiable ; ne pas commencer la suivante tant que l'acceptation de la précédente ne passe pas. Script d'acceptation commun : `apps/api/test/members/members-flow.sh [BASE_URL]` (API hors production, comme `auth-flow.sh`), étendu à chaque sous-phase.

#### 8.1 — Mes endpoints, nom, propriété

- Migration `AddMemberFeatures` : `endpoints.name VARCHAR(80) NULL`, `endpoints.response_config JSON NULL`, `requests.note TEXT NULL` (les deux dernières colonnes servent en 8.2 et 8.3 ; une seule migration pour la phase).
- `packages/shared` : `ENDPOINT_NAME_MAX_LENGTH`, `OwnedEndpointSummary`, `AccountEndpointsResponse`, `UpdateEndpointRequest`, `EndpointDetail` étendu (`name`, `has_owner`, `owned`, `response`, `max_requests`), code `NOT_OWNER`.
- API : `GET /api/account/endpoints` ; `PATCH /api/endpoints/:id { name }` ; `POST /api/endpoints/:id/claim` ; `DELETE /api/endpoints/:id` réservé au propriétaire quand l'endpoint en a un ; `GET /api/endpoints/:id` passe par `OptionalAuthGuard` pour renseigner `owned`. `express.json` monté sur `EndpointsController` et `RequestsController` (16 Ko). Le throttler devient un module global (`ThrottlingModule`) pour être utilisable hors de `AuthModule`.
- Front : HomePage connectée → liste **« My endpoints »** (nom ou id court, dernière activité, nombre de requêtes) qui remplace « Recent endpoints » ; les recents du navigateur non possédés restent affichés en dessous. InboxPage : nom au-dessus de l'URL, bouton **Edit** (propriétaire) → panneau `EndpointSettings` avec le champ Name ; bouton **Claim this endpoint** (connecté, endpoint sans propriétaire) ; page « This endpoint is private » (avec lien Sign in pour un anonyme) pour les non-propriétaires ; l'`EndpointPicker` liste aussi les endpoints possédés.
- **Acceptation** : `members-flow.sh` : création connectée → présent dans `/api/account/endpoints` avec `request_count` juste ; endpoint anonyme absent ; `PATCH name` par le propriétaire `200`, par un autre membre `403 NOT_OWNER`, anonyme `401` ; nom trop long `400 VALIDATION` ; `name: null` efface ; `claim` d'un endpoint anonyme `200`, d'un endpoint déjà possédé `403 NOT_OWNER` ; `DELETE` d'un endpoint possédé par un anonyme `401`, par un autre membre `403`, par le propriétaire `204` ; `DELETE` d'un endpoint anonyme par un anonyme `204` (inchangé) ; `GET /api/endpoints/:id` → `owned: true` pour le propriétaire, `401` pour un anonyme, `403 NOT_OWNER` pour un autre membre (idem liste, détail, suppression et vidage des requêtes ; `subscribe` Socket.IO refusé avec le même code) ; la capture reste `200` pour tous. Headless Chrome : Home connectée affiche « My endpoints » avec le nom ; inbox du propriétaire montre Edit, renommage immédiat ; inbox vue anonyme : page « This endpoint is private », rien de l'inbox n'apparaît ; `rest-flow.sh` et `send-all.sh` passent toujours.

#### 8.2 — Réponse configurable

- `packages/shared` : `ResponseConfig { status, content_type, body, headers, delay_ms }`, bornes (`RESPONSE_BODY_MAX_LENGTH` 64 Ko, `RESPONSE_MAX_HEADERS` 20, `RESPONSE_MAX_DELAY_MS` 10 000), `RESPONSE_FORBIDDEN_HEADERS`.
- API : `PATCH /api/endpoints/:id { response: ResponseConfig | null }` (propriétaire ; zod ; `null` = réponse par défaut). Capture : `EndpointsService.findForCapture()` renvoie `{ id, ownerId, responseConfig }` en une requête ; après l'insertion (l'inbox voit la requête avant la réponse) : attente `delay_ms`, puis statut, `Content-Type`, en-têtes personnalisés, corps. Les en-têtes CORS `*` restent toujours posés ; `Content-Security-Policy: sandbox` et `X-Content-Type-Options: nosniff` sont ajoutés à toute réponse personnalisée (§13.5) ; `HEAD` → sans corps ; les erreurs 404/413/500 ne sont jamais personnalisées.
- Front : panneau `EndpointSettings` complété d'un formulaire **Response** (statut, Content-Type, délai, corps, en-têtes dynamiques, bouton « Reset to default »), hint quand la réponse est personnalisée dans l'en-tête de l'inbox.
- **Acceptation** : `members-flow.sh` : `PATCH response` propriétaire `200`, autre membre `403` ; statut hors bornes, délai > max, en-tête interdit (`Set-Cookie`), corps > 64 Ko → `400 VALIDATION` nommant le champ ; capture ensuite → statut, `Content-Type`, en-tête et corps personnalisés + `Access-Control-Allow-Origin: *` + `Content-Security-Policy: sandbox` ; `HEAD` → statut personnalisé sans corps ; `delay_ms: 1500` → temps de réponse ≥ 1,5 s et la requête est déjà listée pendant l'attente ; `response: null` → retour à `200 {"ok":true,"id"}` ; endpoint inconnu → toujours `404 {"ok":false}`. Headless Chrome : édition et enregistrement du formulaire, hint affiché.

#### 8.3 — Filtre, export cURL, notes, replay

- Filtre côté client (connecté) : barre au-dessus de la liste, texte libre sur méthode, chemin, IP, id court, et sélecteur de méthode ; compteur « n of m » ; aucune route API.
- Export cURL (connecté) : bouton **Copy as cURL** dans `RequestPanel` (méthode, URL complète, en-têtes sans `Host`/`Content-Length`/en-têtes de proxy, corps échappé ; multipart/binaire → commentaire).
- Notes (propriétaire) : `PATCH /api/endpoints/:id/requests/:rid { note }` (≤ `NOTE_MAX_LENGTH` 2000, `null` efface), `RequestDetail.note`, section **Note** dans le panneau (textarea + Save), cache local mis à jour.
- Replay (propriétaire) : `POST /api/endpoints/:id/requests/:rid/replay { target_url }` → `200 ReplayResult { status, headers, body, truncated, duration_ms }` ou `502 REPLAY_FAILED`. Implémentation `ReplayService` sur `http`/`https` de Node avec `lookup` gardé anti-SSRF (§13.5), pas de suivi de redirection, délai 10 s, corps de réponse tronqué à 64 Ko, en-têtes de proxy/hop-by-hop retirés, `Host` recalculé ; throttler 30 / min / IP. Section **Replay** dans le panneau (URL cible mémorisée par endpoint dans localStorage, résultat affiché).
- **Acceptation** : `members-flow.sh` : note posée/lue/effacée par le propriétaire, `403` pour un autre membre, `400` au-delà de 2000 caractères ; replay vers un second endpoint yomail du même serveur (`target_url = BASE/<B>`, possible seulement quand `BASE` est une adresse publique ou que `REPLAY_ALLOW_PRIVATE=1` est posé sur l'API de test) → `200`, la requête apparaît dans l'inbox de B avec la même méthode, le même corps et l'en-tête `X-Test` d'origine, sans `X-Forwarded-*` ; `target_url` en `http://127.0.0.1`, `http://localhost`, `http://10.0.0.1`, `ftp://…`, hôte inexistant → `400 VALIDATION` ou `502 REPLAY_FAILED` selon le cas, jamais de requête émise vers une adresse privée (vérifié sans `REPLAY_ALLOW_PRIVATE`) ; `403` pour un non-propriétaire. Headless Chrome : filtre réduit la liste, cURL copié valide (rejoué par `bash`), note sauvegardée visible après rechargement, replay affiche le statut.

#### 8.4 — Limites par appartenance

- `settings` : nouvelle clé `retention_days_members` (défaut `RETENTION_DAYS_MEMBERS_DEFAULT` = 30) ; `.env` : `MAX_REQUESTS_PER_ENDPOINT_MEMBERS` (défaut 2000). Un endpoint **possédé** a la rétention et le plafond membres ; un endpoint anonyme garde les valeurs actuelles. Le rôle `ADMIN` ne change rien aux limites.
- `SettingsService.getRetentionDays(owned)` ; `expires_at`, `retention_days` (liste, détail, `ChangeDetector`) et `enforceCap` suivent la propriété de l'endpoint ; `PurgeService` applique deux cutoffs (requêtes et endpoints idle, `owner_id IS NULL` vs `IS NOT NULL`) ; `/api/health` expose `retention_days_members` et les deux plafonds ; la Home et l'inbox affichent les limites qui s'appliquent.
- **Acceptation** : `members-flow.sh` : liste d'un endpoint possédé → `retention_days` = valeur membres, anonyme → valeur de base ; `expires_at` cohérent ; `/api/health` renvoie les deux rétentions ; cap membres vérifié avec `MAX_REQUESTS_PER_ENDPOINT_MEMBERS=3` sur l'API de test (`CAP_MEMBERS=3` dans le script) ; `purge --dry-run` ne compte pas comme expirée une requête possédée plus vieille que la rétention anonyme mais plus jeune que la rétention membres (ligne insérée par SQL de test).

#### 8.5 — Documentation

- `README.md` (fonctionnalités membres, routes, variables), `docs/ARCHITECTURE.md` (propriété, réponse configurable, replay et anti-SSRF, limites, invariants), `docs/DEPLOY_CPANEL.md` (variables, checklist), `CLAUDE.md` (état, invariants), `.env.example`. Diagrammes inchangés (aucun ne cite les tables modifiées).

### Phase 9 — Transverse (ultérieur, ni réservé ni spécifique aux comptes)

- Anti-abus : rate limiting par IP sur la capture et sur `POST /api/endpoints`, plafond global de lignes, blocage d'IP ; limiteur partagé entre process (table ou fichier) si la limite mémoire de la phase 7 se révèle insuffisante.
- Administration : CLI étendue (lister, activer, désactiver, supprimer un utilisateur), puis page admin protégée par `RolesGuard`.
- Tests : Jest unitaires (classification, parseurs, sanitizer, purge, hachage et jetons, garde anti-SSRF), e2e Supertest (capture, REST, auth, gateway) avec MySQL docker ; CI.
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
| Comptes utilisateurs (phase 7) : sessions, jetons, emails, force brute                 | Voir le tableau dédié §12.9                                                                                                                       |
| Colonnes JSON sur MariaDB                                                              | `type: 'json'` TypeORM compatible ; vérifier `SELECT VERSION()` et l'absence de diff `migration:generate` sur le moteur de prod                   |

---

## 12. Comptes utilisateurs — conception (phase 7)

> Ajouté le 2026-10-07. Découpage et acceptation en §8 (phase 7). Les décisions ci-dessous ont été prises avec l'utilisateur ; les « défauts choisis » sont modifiables.

### 12.1 Décisions

| Sujet            | Décision                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inscription      | Formulaire username + email + mot de passe. Compte créé en statut `DISABLED`, email de confirmation avec un bouton d'activation ; le clic passe le compte en `ENABLED` et connecte l'utilisateur                                                                                                                                                                                                           |
| Statuts          | `DISABLED` (créé, email non confirmé : connexion refusée), `ENABLED` (actif), `DELETED` (supprimé par son propriétaire : ligne conservée mais anonymisée, connexion refusée)                                                                                                                                                                                                                               |
| Rôles            | `ADMIN` et `STANDARD`. Toute inscription web crée un `STANDARD`. Un `ADMIN` ne se crée **que** par la CLI `dist/cli/user.js create-admin` ; aucune route API ne crée ni ne promeut un admin. Aucune fonction admin dans l'UI en phase 7 (`RolesGuard` prêt pour la phase 8)                                                                                                                                |
| Session          | **En base** (table `sessions`) : jeton opaque de 32 octets aléatoires, seul son SHA-256 est stocké ; cookie `yomail_session` `HttpOnly`, `SameSite=Lax`, `Secure` en production, `Path=/`, durée `SESSION_TTL_DAYS` (30). Révocable (logout, reset, suppression), valable dans tous les process Passenger, aucun secret de signature à gérer                                                               |
| Mots de passe    | `crypto.scrypt` de Node (N = 2^15, r = 8, p = 1, sel 16 octets, 64 octets de sortie), chaîne `scrypt$N$r$p$<sel b64>$<hash b64>`, comparaison `timingSafeEqual`. **Pourquoi pas argon2/bcrypt** : modules natifs, `npm ci --omit=dev` sur cPanel sans chaîne de compilation est un risque inutile ; scrypt est intégré à Node et accepté par l'OWASP                                                       |
| Email            | SMTP du compte mail cPanel (`no-reply@manitra.fr`) via `nodemailer` **en production seulement** ; dans tout autre environnement, aucun envoi : les messages sont stockés en base (table `caught_mails`) et lus sur `http://localhost:<PORT>/devmailcatcher` (chemin fixe). L'application détecte l'environnement par `NODE_ENV` (`isProduction()`)                                                         |
| Jetons par email | 32 octets aléatoires en base64url dans le lien, SHA-256 stocké, usage unique, expiration 48 h (confirmation) / 60 min (reset) ; émettre un nouveau jeton invalide les précédents du même type. **L'activation se fait par la SPA** (`/confirm/:token` → `POST /api/auth/confirm`), jamais par un `GET` : les antivirus et aperçus de liens préchargent les URL des emails et consommeraient un jeton `GET` |
| Connexion        | Par **email ou username** + mot de passe. Erreur unique `INVALID_CREDENTIALS` pour compte inconnu, mot de passe faux ou compte `DELETED` ; `ACCOUNT_DISABLED` seulement quand le mot de passe est correct sur un compte non confirmé (l'UI propose « Resend »)                                                                                                                                             |
| Énumération      | Acceptée à l'inscription (`409 EMAIL_TAKEN` / `USERNAME_TAKEN`, comme la plupart des sites). `forgot-password` et `resend-confirmation` répondent toujours `200`                                                                                                                                                                                                                                           |
| Propriété        | `endpoints.owner_id` nullable, renseigné quand un endpoint est créé avec une session valide. Aucun changement de comportement en phase 7 (l'inbox reste publique par UUID) ; c'est le socle de « My endpoints » et des fonctions de la phase 8                                                                                                                                                             |
| Validation       | `zod` (déjà présent pour `env.ts`) via un `ZodValidationPipe` ; règles partagées dans `packages/shared` : username 3–32 caractères `[A-Za-z0-9_]`, unique **insensible à la casse** (collation `utf8mb4_unicode_ci` de l'index unique), email ≤ 254 caractères, mis en minuscules, unique ; mot de passe 8–128 caractères, aucune règle de composition (NIST)                                              |
| Anti-abus        | `@nestjs/throttler` en mémoire : 10 requêtes / 15 min / IP sur les routes auth sensibles. Par process, donc limite effective ≈ 10 × nombre de process Passenger : suffisant contre la force brute naïve, pas contre un attaquant distribué (phase 8)                                                                                                                                                       |
| Périmètre        | Inclus : inscription, confirmation, renvoi de confirmation, connexion, déconnexion, mot de passe oublié / reset, page compte (changement de mot de passe, suppression), CLI `create-admin`. Exclus : changement d'email ou de username, OAuth, 2FA, gestion admin des utilisateurs (phase 8)                                                                                                               |

### 12.2 Modèle de données

#### `users`

| Colonne         | Type                                          | Notes                                                                                               |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `id`            | CHAR(36) PK                                   | UUID v4                                                                                             |
| `username`      | VARCHAR(32) NOT NULL                          | casse d'origine conservée ; index unique `uq_users_username` (insensible à la casse par collation)  |
| `email`         | VARCHAR(254) NOT NULL                         | minuscules ; index unique `uq_users_email`                                                          |
| `password_hash` | VARCHAR(255) NOT NULL                         | format scrypt ci-dessus ; vidé (`''`) à la suppression                                              |
| `status`        | ENUM('DISABLED','ENABLED','DELETED') NOT NULL | défaut `DISABLED` ; index `idx_users_status_created (status, created_at)` (purge des non confirmés) |
| `role`          | ENUM('ADMIN','STANDARD') NOT NULL             | défaut `STANDARD`                                                                                   |
| `created_at`    | DATETIME(3) NOT NULL                          |                                                                                                     |
| `updated_at`    | DATETIME(3) NOT NULL                          | mis à jour par le service (pas de trigger)                                                          |
| `enabled_at`    | DATETIME(3) NULL                              | date de confirmation (ou de création pour un admin CLI) ; NULL = jamais confirmé                    |
| `deleted_at`    | DATETIME(3) NULL                              |                                                                                                     |
| `last_login_at` | DATETIME(3) NULL                              |                                                                                                     |

Suppression par l'utilisateur (`DELETE /api/account`) : `status = DELETED`, `deleted_at = now`, `email = 'deleted+<id>@invalid'`, `username = 'deleted_<8 premiers caractères de l'id>'`, `password_hash = ''`, toutes les sessions et jetons supprimés, `UPDATE endpoints SET owner_id = NULL`. L'anonymisation libère l'email et le username pour une nouvelle inscription tout en gardant une trace (statut demandé). Les endpoints survivent en anonymes jusqu'à la purge normale.

#### `sessions`

| Colonne        | Type                 | Notes                                                                                      |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `id`           | CHAR(36) PK          |                                                                                            |
| `user_id`      | CHAR(36) NOT NULL    | FK `fk_sessions_user` → `users.id` ON DELETE CASCADE ; index `idx_sessions_user`           |
| `token_hash`   | CHAR(64) NOT NULL    | SHA-256 hex du jeton du cookie ; index unique `uq_sessions_token`                          |
| `created_at`   | DATETIME(3) NOT NULL |                                                                                            |
| `last_seen_at` | DATETIME(3) NOT NULL | réécrit au plus une fois toutes les 5 min pour limiter les écritures                       |
| `expires_at`   | DATETIME(3) NOT NULL | `created_at + SESSION_TTL_DAYS`, fixe (pas de prolongation) ; index `idx_sessions_expires` |
| `user_agent`   | VARCHAR(255) NULL    | tronqué                                                                                    |
| `ip`           | VARCHAR(45) NULL     | `req.ip`                                                                                   |

#### `user_tokens`

| Colonne      | Type                                            | Notes                                                                                  |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`         | CHAR(36) PK                                     |                                                                                        |
| `user_id`    | CHAR(36) NOT NULL                               | FK `fk_user_tokens_user` → `users.id` ON DELETE CASCADE ; index `idx_user_tokens_user` |
| `kind`       | ENUM('CONFIRM_EMAIL','RESET_PASSWORD') NOT NULL |                                                                                        |
| `token_hash` | CHAR(64) NOT NULL                               | SHA-256 hex ; index unique `uq_user_tokens_token`                                      |
| `created_at` | DATETIME(3) NOT NULL                            |                                                                                        |
| `expires_at` | DATETIME(3) NOT NULL                            | index `idx_user_tokens_expires`                                                        |
| `used_at`    | DATETIME(3) NULL                                | renseigné à la consommation ; un jeton utilisé ou expiré est refusé                    |

#### `endpoints` (delta)

| Colonne    | Type          | Notes                                                                                 |
| ---------- | ------------- | ------------------------------------------------------------------------------------- |
| `owner_id` | CHAR(36) NULL | FK `fk_endpoints_owner` → `users.id` ON DELETE SET NULL ; index `idx_endpoints_owner` |

Mêmes conventions que §3 : colonnes snake_case explicites, FK et index nommés, index ascendants, `migration:generate` sans diff après la migration `AddUsers`. Les ENUM MySQL sont volontairement utilisés (comme `content_kind`) ; ajouter une valeur = une migration.

### 12.3 API (préfixe `/api`)

Toutes les routes ci-dessous lisent un corps JSON (`express.json({ limit: '16kb' })` appliqué à ces contrôleurs seulement) sauf mention contraire, et répondent `Cache-Control: no-store` comme le reste de l'API. `[T]` = soumise au throttler (10 / 15 min / IP). `[A]` = `AuthGuard` (401 sans session valide ou si l'utilisateur n'est plus `ENABLED`).

| Méthode | Route                           | Corps                                | Réponse et règles                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST    | `/auth/signup` [T]              | `{ username, email, password }`      | Crée l'utilisateur `DISABLED`/`STANDARD`, émet un jeton `CONFIRM_EMAIL`, envoie l'email. `201 { ok: true }` même si l'envoi échoue (loggé ; l'UI renvoie vers « Resend »). `409 { code: 'EMAIL_TAKEN' \| 'USERNAME_TAKEN' }`, `400` validation                                                                                                |
| POST    | `/auth/confirm` [T]             | `{ token }`                          | Jeton valide, non utilisé, non expiré, utilisateur `DISABLED` → `ENABLED`, `enabled_at = now`, jeton marqué utilisé, **session créée** (cookie). `200 UserProfile`. Sinon `400 { code: 'TOKEN_INVALID' }` (un compte déjà `ENABLED` avec un jeton périmé → `TOKEN_INVALID` aussi, l'UI dit de se connecter)                                   |
| POST    | `/auth/resend-confirmation` [T] | `{ email }`                          | Si un compte `DISABLED` existe pour cet email : nouveau jeton (les anciens sont supprimés), nouvel email. Toujours `200 { ok: true }`                                                                                                                                                                                                         |
| POST    | `/auth/login` [T]               | `{ identifier, password }`           | `identifier` = email (contient `@`, minuscules) ou username. `200 UserProfile` + cookie, `last_login_at` mis à jour. `401 { code: 'INVALID_CREDENTIALS' }` (inconnu, mot de passe faux, `DELETED`), `403 { code: 'ACCOUNT_DISABLED' }` (mot de passe correct, non confirmé). Le hachage est toujours vérifié (pas de court-circuit mesurable) |
| POST    | `/auth/logout`                  | aucun                                | Supprime la session courante et efface le cookie. `204` même sans session                                                                                                                                                                                                                                                                     |
| GET     | `/auth/me`                      | aucun                                | `200 UserProfile` ou `401 { code: 'UNAUTHENTICATED' }`. Met à jour `last_seen_at` (au plus toutes les 5 min)                                                                                                                                                                                                                                  |
| POST    | `/auth/forgot-password` [T]     | `{ email }`                          | Si un compte `ENABLED` existe : jeton `RESET_PASSWORD` (anciens supprimés) + email. Toujours `200 { ok: true }`                                                                                                                                                                                                                               |
| POST    | `/auth/reset-password` [T]      | `{ token, password }`                | Jeton valide → nouveau hash, jeton utilisé, **toutes** les sessions révoquées. `204`. `400 TOKEN_INVALID` sinon                                                                                                                                                                                                                               |
| PATCH   | `/account/password` [A]         | `{ current_password, new_password }` | Vérifie l'actuel (`400 { code: 'WRONG_PASSWORD' }`), remplace, révoque les **autres** sessions. `204`                                                                                                                                                                                                                                         |
| DELETE  | `/account` [A]                  | `{ password }`                       | Vérifie le mot de passe, applique l'anonymisation §12.2, efface le cookie. `204`                                                                                                                                                                                                                                                              |

`UserProfile` = `{ id, username, email, role, status, created_at }` (jamais `password_hash`, jamais les jetons). `AuthErrorCode` = `'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' | 'EMAIL_TAKEN' | 'USERNAME_TAKEN' | 'TOKEN_INVALID' | 'WRONG_PASSWORD' | 'UNAUTHENTICATED' | 'VALIDATION'`. Les erreurs ont la forme `{ statusCode, code, message, fields? }` ; `fields` liste les champs en erreur de zod. Le front se base sur `code`, jamais sur `message`.

Route existante modifiée : `POST /api/endpoints` passe par `OptionalAuthGuard` et renseigne `owner_id` s'il y a un utilisateur. `GET /api/endpoints/:id` et les routes de requêtes ne changent pas (lecture publique par UUID, comme avant).

### 12.4 Sessions, garde et cookies

- Création : `token = randomBytes(32).toString('base64url')` ; ligne `sessions` avec `token_hash = sha256(token)` ; `Set-Cookie: yomail_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>` + `Secure` quand `NODE_ENV=production` (site en HTTPS ; derrière Passenger, `trust proxy` est déjà activé).
- `AuthGuard` : lit le cookie (`cookie-parser`), `SELECT` de la session par hash joint à l'utilisateur, refuse si absente, expirée, ou utilisateur non `ENABLED` (un compte passé `DISABLED`/`DELETED` perd l'accès immédiatement, sans attendre l'expiration). Attache `req.user: UserProfile`. `OptionalAuthGuard` fait la même chose mais laisse passer avec `req.user = undefined`.
- Pas de prolongation glissante en v1 : une session dure 30 jours puis l'utilisateur se reconnecte. Simple et borné.
- CSRF : `SameSite=Lax` empêche l'envoi du cookie sur les requêtes cross-site non-navigationnelles, et toutes les routes mutantes exigent un corps `application/json` (impossible depuis un formulaire HTML sans preflight CORS, lequel est refusé par la configuration `CORS_ORIGIN` même origine). Suffisant en v1 ; pas de jeton CSRF.
- Socket.IO et les routes de capture ignorent totalement les sessions : rien ne change pour le temps réel ni pour la capture.

### 12.5 Email

- `MailService.send()` : en production, `nodemailer.createTransport` construit une fois avec `{ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE === 1, auth: SMTP_USER ? { user, pass } : undefined }` ; hors production, `DevMailboxService.store()` (table `caught_mails`) et une ligne de log citant `/devmailcatcher/<id>` et les liens du message.
- Expéditeur `MAIL_FROM` (`yomail <no-reply@manitra.fr>`), `Reply-To` absent. Sujets : « Confirm your yomail account », « Reset your yomail password ». Liens : `${PUBLIC_BASE_URL}/confirm/<token>` et `${PUBLIC_BASE_URL}/reset-password/<token>`.
- HTML minimal (table centrée, bouton = `<a>` stylé inline, fond uni, pas d'image distante) + version texte équivalente ; aucune donnée utilisateur autre que le username (échappé) n'est injectée.
- cPanel/o2switch : le SMTP authentifié du compte mail est joignable depuis l'app Node sur le même serveur (`465` SSL) ; SPF/DKIM sont gérés par cPanel pour `manitra.fr` (à vérifier dans _Email Deliverability_). Un quota d'envois par heure existe sur l'hébergement mutualisé : sans conséquence au volume attendu, mais le throttler évite qu'un tiers le vide via `resend`/`forgot`.
- Dev et tests : dev mail catcher intégré, `http://localhost:<PORT>/devmailcatcher` (UI) et `/devmailcatcher/messages.json?to=<email>` (utilisé par `auth-flow.sh` pour extraire le lien, avec une session admin). Rien ne sort de la machine, aucun port SMTP n'est nécessaire (le réseau d'entreprise bloque le port 25 sortant). Le même catcher, en production, reçoit les e-mails d'autres applications en développement (`POST /devmailcatcher/messages.json`).

### 12.6 CLI `user`

- `apps/api/src/cli/user.ts`, compilé en `dist/cli/user.js` (à côté de `purge.js`, même `rootDir`). Analyse d'arguments maison (`--key value`), pas de dépendance.
- `create-admin --username <u> --email <e> [--password <p>]` : validation avec les constantes partagées, hachage, insertion `ADMIN`/`ENABLED`/`enabled_at = now`, sortie « Admin user <username> created (<id>) ». Mot de passe : `--password`, sinon `YOMAIL_USER_PASSWORD`, sinon saisie masquée (deux fois) sur le TTY ; sans TTY et sans valeur → code 1.
- Codes de sortie : 0 succès, 1 erreur (doublon, validation, DB), 2 usage.
- Sur cPanel : `cd ~/yomail/apps/api && ~/nodevenv/yomail/apps/api/22/bin/node dist/cli/user.js create-admin ...` (même convention que la purge : `.env` lu depuis `apps/api`).

### 12.7 Front

- `AuthProvider` au-dessus du routeur ; `useAuth()` dans `Layout` et les pages. `GET /api/auth/me` au montage (une fois), `refresh()` après login/confirm, `logout()` appelle l'API puis vide l'état.
- Routes ajoutées à `App.tsx` : `/signup`, `/login`, `/confirm/:token`, `/forgot-password`, `/reset-password/:token`, `/account` (dans `RequireAuth`). Les routes existantes ne bougent pas.
- Formulaires : `useState` + `onSubmit` asynchrone, bouton désactivé pendant l'appel, erreur serveur affichée au-dessus du bouton (`Feedback` existant), messages par code (`INVALID_CREDENTIALS` → « Wrong email/username or password », `ACCOUNT_DISABLED` → « Confirm your email first » + bouton Resend, `EMAIL_TAKEN`, `USERNAME_TAKEN`, `TOKEN_INVALID` → « This link is invalid or has expired », `429` → « Too many attempts, try again later »).
- Après `login` : navigation vers `?next=` si présent (chemin relatif seulement, pour éviter une redirection ouverte), sinon `/`. Après `signup` : page « Check your inbox » (pas de connexion automatique). Après `confirm` : connecté, bouton « Go to home ».
- `/account` : username, email, rôle (badge `ADMIN` le cas échéant), date de création ; formulaire « Change password » ; zone « Delete account » (mot de passe + `window.confirm`), puis retour Home déconnecté.
- La Home et l'Inbox restent identiques pour un anonyme ; pour un connecté, la Home garde « Recent endpoints » en phase 7 (« My endpoints » arrive en phase 8).

### 12.8 Configuration (`.env`, ajouts)

```
# Comptes (phase 7)
SESSION_TTL_DAYS=30                 # durée d'une session (cookie et table sessions)
CONFIRM_TOKEN_TTL_HOURS=48          # validité du lien de confirmation
RESET_TOKEN_TTL_MINUTES=60          # validité du lien de réinitialisation
UNCONFIRMED_USER_TTL_DAYS=7         # purge des comptes jamais confirmés
AUTH_RATE_LIMIT=10                  # requêtes par IP et par fenêtre sur les routes auth sensibles
AUTH_RATE_WINDOW_MINUTES=15
# SMTP_* : utilisés en production seulement (hors production : /devmailcatcher, qui existe aussi en production pour d'autres applications)
SMTP_HOST=mail.manitra.fr           # requis si NODE_ENV=production
SMTP_PORT=465
SMTP_SECURE=1                       # 1 = TLS implicite (465), 0 = clair/STARTTLS
SMTP_USER=no-reply@manitra.fr       # vide = pas d'authentification
SMTP_PASSWORD=
MAIL_FROM="yomail <no-reply@manitra.fr>"
```

Toutes ont un défaut dans `env.ts` sauf `SMTP_HOST`, requis uniquement quand `NODE_ENV=production` (validation conditionnelle zod) ; `SMTP_USER`/`SMTP_PASSWORD` vides = SMTP sans authentification. Pas de variable de transport : `isProduction(NODE_ENV)` décide (SMTP ou dev mail catcher), comme pour le cookie `Secure`. `.env.example` mis à jour. Dépendances ajoutées à `apps/api` : `nodemailer`, `@types/nodemailer` (dev), `cookie-parser`, `@types/cookie-parser` (dev), `@nestjs/throttler`. Aucune dépendance native.

### 12.9 Sécurité et points de vigilance

| Risque                                  | Mitigation                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vol de session                          | Cookie `HttpOnly` + `Secure` + `SameSite=Lax`, jeton jamais loggé, seul le hash est en base ; révocation au reset et à la suppression                          |
| Force brute sur le login                | scrypt (coût ≈ 50–100 ms), throttler 10 / 15 min / IP par process, message d'erreur unique                                                                     |
| Jetons email interceptés ou préchargés  | Hash stocké, usage unique, courte durée, consommation par `POST` depuis la SPA uniquement                                                                      |
| Emails en spam (Gmail)                  | Envoi depuis le SMTP du domaine, SPF/DKIM cPanel, texte + HTML, pas d'image ni de raccourcisseur ; vérifier en 7.6 avec une vraie boîte                        |
| SMTP indisponible                       | `MailService` logue sans lever ; l'inscription réussit et « Resend » permet de réessayer ; `/api/health` n'inclut pas le SMTP (pas de dépendance au démarrage) |
| Plusieurs process Passenger             | Sessions et jetons en base (aucun état mémoire nécessaire) ; le throttler mémoire est la seule exception, assumée                                              |
| Modules natifs sur cPanel               | scrypt intégré à Node ; aucune dépendance native ajoutée ; `npm ci --omit=dev` inchangé                                                                        |
| Énumération des comptes                 | Acceptée à l'inscription ; `forgot`/`resend` neutres ; `login` ne distingue que le cas « non confirmé » après vérification du mot de passe                     |
| Redirection ouverte via `?next=`        | Seuls les chemins commençant par `/` (et pas `//`) sont acceptés                                                                                               |
| Corps JSON sur une app sans body parser | `express.json` limité à 16 Ko et aux contrôleurs auth/account ; la capture continue de lire son corps en flux                                                  |
| Comptes abandonnés                      | Purge des `DISABLED` non confirmés après 7 jours ; sessions et jetons expirés purgés à chaque run                                                              |

---

## 13. Fonctionnalités membres — conception (phase 8)

> Ajoutée le 2026-10-07. Complète §12 (comptes). Les règles de validation (longueurs, bornes, en-têtes interdits) vivent dans `packages/shared`, les schémas zod dans `apps/api/src/endpoints/schemas.ts` et `requests/schemas.ts`.

### 13.1 Décisions

- **Propriété** : un endpoint a au plus un propriétaire (`endpoints.owner_id`, phase 7). « Possédé » = `owner_id IS NOT NULL`. Le propriétaire est le seul à pouvoir nommer, configurer la réponse, annoter, rejouer et **supprimer** un endpoint possédé. **Un endpoint possédé est privé** (révision du 2026-10-07, remplaçant la lecture publique initiale) : détail, inbox (liste, détail, suppression d'une requête, vidage) et room Socket.IO sont réservés au propriétaire (`401 UNAUTHENTICATED` sans session, `403 NOT_OWNER` pour un autre membre). La capture reste ouverte à tous. Un endpoint sans propriétaire reste lisible, vidable et supprimable par quiconque connaît l'UUID.
- **Claim** : un membre peut s'approprier un endpoint sans propriétaire (`POST /api/endpoints/:id/claim`). Pas de transfert ni d'abandon de propriété en v1 (supprimer le compte libère les endpoints : `owner_id = NULL` par la FK).
- **Fonctions côté client** (filtre, export cURL) : offertes à tout utilisateur connecté, quel que soit l'endpoint ; elles n'ont aucune route API et ne gagneraient rien à être liées à la propriété.
- **Codes d'erreur** : `AuthErrorCode` gagne `NOT_OWNER` (`403`, endpoint possédé par quelqu'un d'autre, ou déjà possédé pour `claim`) et `REPLAY_FAILED` (`502`). Les routes qui exigent une session renvoient `401 UNAUTHENTICATED` comme en phase 7. Même forme `{ statusCode, code, message, fields? }`.
- **Limites par appartenance** : rétention et plafond par endpoint suivent la propriété (membres : `retention_days_members`, `MAX_REQUESTS_PER_ENDPOINT_MEMBERS`), pas le rôle. `ADMIN` est un rôle d'administration, pas un palier de service.
- **Corps JSON** : `express.json({ limit: '16kb' })` est monté sur `EndpointsController` et `RequestsController` en plus des contrôleurs auth/account ; le corps de `PATCH response` peut atteindre 64 Ko + en-têtes, la limite de ces deux contrôleurs est donc portée à `96kb`. La capture continue de lire son corps en flux (contrôleur distinct, hors `/api`).

### 13.2 Modèle de données (delta)

```sql
ALTER TABLE endpoints ADD name VARCHAR(80) NULL;            -- affichage, aucune unicité
ALTER TABLE endpoints ADD response_config JSON NULL;        -- ResponseConfig ou NULL (réponse par défaut)
ALTER TABLE requests  ADD note TEXT NULL;                   -- ≤ 2000 caractères (zod), jamais dans les listes
INSERT INTO settings (`key`, value) VALUES ('retention_days_members', '30');  -- lu avec cache 60 s comme retention_days
```

`response_config` est stocké tel que validé (`{ status, content_type, body, headers: Pair[], delay_ms }`), relu à chaque capture dans la même requête SQL que l'existence de l'endpoint. `note` rejoint `DETAIL_COLUMNS` seulement.

### 13.3 API (préfixe `/api`)

`[A]` = `AuthGuard` ; `[O]` = `AuthGuard` + propriétaire (`403 NOT_OWNER` sinon) ; `[?]` = `OptionalAuthGuard`.

| Méthode | Route                                     | Corps                                                          | Réponse et règles                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/account/endpoints` [A]                  | aucun                                                          | `{ endpoints: OwnedEndpointSummary[] }` = `{ id, url, name, created_at, last_request_at, request_count }`, triés par `COALESCE(last_request_at, created_at) DESC`, 200 au plus                                                                                                                                          |
| GET     | `/endpoints/:id` [?]                      | aucun                                                          | `EndpointDetail` + `name`, `has_owner`, `owned`, `custom_response`, `response`, `max_requests`, `retention_days` selon la propriété. Endpoint possédé : propriétaire seulement (`401` sans session, `403 NOT_OWNER` pour un autre membre)                                                                               |
| PATCH   | `/endpoints/:id` [O]                      | `{ name?: string \| null, response?: ResponseConfig \| null }` | Champs absents inchangés. `name` trim, 1–80 caractères, `null` efface. `response` validé (§13.4), `null` = défaut. `200 EndpointDetail`                                                                                                                                                                                 |
| POST    | `/endpoints/:id/claim` [A]                | aucun                                                          | `owner_id IS NULL` → devient le propriétaire, `200 EndpointDetail` ; déjà possédé (même par soi) → `403 NOT_OWNER`                                                                                                                                                                                                      |
| DELETE  | `/endpoints/:id` [?]                      | aucun                                                          | Endpoint sans propriétaire : `204` pour tout le monde (inchangé). Possédé : `401` sans session, `403 NOT_OWNER` pour un autre membre, `204` pour le propriétaire                                                                                                                                                        |
| PATCH   | `/endpoints/:id/requests/:rid` [O]        | `{ note: string \| null }`                                     | ≤ 2000 caractères après trim, chaîne vide = `null`. `200 RequestDetail`. `404` si la requête n'appartient pas à l'endpoint                                                                                                                                                                                              |
| POST    | `/endpoints/:id/requests/:rid/replay` [O] | `{ target_url }`                                               | Rejoue la requête vers `target_url` (§13.5). `200 ReplayResult { status, headers: Pair[], body: string \| null, truncated, duration_ms }` quelle que soit la réponse de la cible ; `502 REPLAY_FAILED` si la cible n'est pas joignable / délai dépassé ; `400 VALIDATION` si l'URL est refusée. Throttler 30 / min / IP |
| GET     | `/health`                                 | aucun                                                          | + `retention_days_members`, `max_requests_per_endpoint`, `max_requests_per_endpoint_members`                                                                                                                                                                                                                            |

Le propriétaire est résolu par `EndpointsService.loadOwned(id, user)` : `404` si l'endpoint n'existe pas, `403 NOT_OWNER` si `owner_id !== user.id`. Les routes de lecture existantes (`GET requests`, `GET requests/:rid`, `DELETE requests/:rid`, `DELETE requests`) et `GET /endpoints/:id` passent par `EndpointsService.loadReadable(id, user)` / `assertReadable` (`OptionalAuthGuard`) : endpoint sans propriétaire → tout le monde, endpoint possédé → propriétaire seulement (`401` / `403 NOT_OWNER`). La `LiveGateway` applique la même règle à `subscribe` à partir du cookie de session du handshake (`sessionTokenFromCookieHeader`) et renvoie l'ack `{ ok: false, error: <code> }` ; `claim` émet `endpoint:claimed` (les sockets de la room sur ce process sont retirés, la SPA recharge et retombe sur la page privée).

### 13.4 Réponse configurable

```ts
interface ResponseConfig {
  status: number; // 100–599
  content_type: string; // 1–255 caractères, défaut 'application/json'
  body: string; // ≤ RESPONSE_BODY_MAX_LENGTH (65 536 caractères), peut être vide
  headers: Pair[]; // ≤ RESPONSE_MAX_HEADERS (20) ; nom = token HTTP (≤ 64), valeur ≤ 1024 sans CR/LF
  delay_ms: number; // 0–RESPONSE_MAX_DELAY_MS (10 000)
}
```

- Ordre dans la capture : validation de l'UUID → `findForCapture` (`id`, `owner_id`, `response_config`) → lecture du corps → insertion + événement live → **attente `delay_ms`** → réponse. L'inbox voit donc la requête pendant le délai.
- La réponse personnalisée pose d'abord les en-têtes CORS `*` (invariant), puis `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, puis les en-têtes de l'utilisateur, puis `Content-Type`. `HEAD` : statut et en-têtes sans corps. Les erreurs (`404` endpoint inconnu, `413`, `400`, `500`) gardent la forme `{ ok: false, error }` et ne sont jamais personnalisées.
- `RESPONSE_FORBIDDEN_HEADERS` (refusés à la validation, `400 VALIDATION` sur `headers`) : `content-length`, `transfer-encoding`, `connection`, `keep-alive`, `upgrade`, `trailer`, `te`, `host`, `set-cookie`, `set-cookie2`, `content-type` (champ dédié), `content-security-policy`, `x-content-type-options`, `access-control-allow-origin`, `access-control-allow-methods`, `access-control-allow-headers`, `access-control-max-age`.

### 13.5 Sécurité

| Risque                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS sur l'origine de l'app via une réponse `text/html` configurée       | Les URLs de capture partagent l'origine de la SPA (`yo.manitra.fr/<uuid>`). Toute réponse personnalisée part avec `Content-Security-Policy: sandbox` (le document s'exécute dans une origine opaque : pas de cookies, pas d'accès à `/api` avec la session, pas de `localStorage` de l'app) et `X-Content-Type-Options: nosniff`. Les clients non navigateurs ignorent ces en-têtes. `Set-Cookie` est interdit (il pourrait écraser `yomail_session`). Les en-têtes CORS et CSP ne sont pas surchargeables                                                            |
| SSRF par le replay                                                      | `target_url` : `http:`/`https:` seulement, pas d'identifiants dans l'URL, port 80/443/1024–65535. Résolution DNS par un `lookup` personnalisé passé à `http.request` : chaque adresse résolue est vérifiée **au moment de la connexion** (pas de fenêtre entre vérification et connexion) ; refus de loopback, lien-local, privé (RFC 1918, RFC 4193), CGNAT, multicast, non spécifié, IPv4 mappé en IPv6 ; pas de suivi de redirection (un `3xx` est rendu tel quel). `REPLAY_ALLOW_PRIVATE=1` lève la restriction hors production uniquement, pour les tests locaux |
| Replay utilisé comme relais de spam/DoS                                 | Propriétaire seulement, throttler 30 / min / IP, délai 10 s, une seule requête, réponse tronquée à 64 Ko ; l'`User-Agent` sortant est `yomail-replay/1 (+https://yo.manitra.fr)` ajouté si absent                                                                                                                                                                                                                                                                                                                                                                     |
| Fuite de la configuration de réponse ou du contenu d'une inbox possédée | Un endpoint possédé est privé : détail, inbox et room Socket.IO répondent `401` / `403` à tout autre lecteur ; `response` n'est donc jamais vu que par le propriétaire                                                                                                                                                                                                                                                                                                                                                                                                |
| Réponse lente qui bloque un process Passenger                           | `delay_ms` ≤ 10 s ; l'attente est un `setTimeout` asynchrone, pas un blocage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plafond et rétention membres plus généreux                              | Valeurs dans `settings` / `.env`, modifiables sans déploiement ; la purge applique les deux cutoffs à chaque run                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 13.6 Front

- `HomePage` : connecté → section **My endpoints** (`GET /api/account/endpoints`, `useAsync`), lignes `name ?? shortId`, `request_count`, dernière activité relative, lien vers l'inbox ; **Recent endpoints** (localStorage) reste dessous, filtré des ids possédés. Anonyme : inchangé.
- `InboxPage` : charge `GET /api/endpoints/:id` (déjà disponible via `api.endpoint`) pour `name`, `owned`, `has_owner`, `response`, `max_requests`, `retention_days` ; l'en-tête affiche le nom, le badge « Yours », le hint « Custom response » ; un `401` / `403` sur l'inbox (`useLiveRequests` → `status: 'forbidden'`, `denied: 'unauthenticated' | 'not-owner'`) affiche la page « This endpoint is private » avec un lien Sign in (`/login?next=`) pour un anonyme ; boutons selon le cas : **Edit** (propriétaire) ouvre `EndpointSettings` (panneau repliable sous l'en-tête : Name, Response), **Claim this endpoint** (connecté + sans propriétaire), **Delete endpoint** (propriétaire ou endpoint anonyme).
- `RequestFilter` (connecté) : champ texte + sélecteur de méthode ; filtre `live.requests` en mémoire (méthode, chemin, IP, id court) ; « n of m » dans l'en-tête de la liste.
- `RequestPanel` : **Copy as cURL** (connecté) ; sections **Note** et **Replay** (propriétaire). `useRequestDetail` expose `update(detail)` pour mettre le cache à jour après une note.
- `api/client.ts` : `myEndpoints()`, `updateEndpoint(id, body)`, `claimEndpoint(id)`, `updateNote(id, rid, note)`, `replay(id, rid, targetUrl)`.
- `lib/curl.ts` : `toCurl(request, endpointUrl)` ; en-têtes exclus : `host`, `content-length`, `connection`, en-têtes de proxy (même regex que `HeadersTable`), corps en quote POSIX simple (`'` → `'\''`), `--data-binary` ; multipart/binaire → commentaire `# body not stored`.

### 13.7 Configuration (`.env`, ajouts)

```
RETENTION_DAYS_MEMBERS_DEFAULT=30   # rétention des endpoints possédés quand settings.retention_days_members est absent
MAX_REQUESTS_PER_ENDPOINT_MEMBERS=2000
REPLAY_TIMEOUT_MS=10000
REPLAY_ALLOW_PRIVATE=0              # 1 = autoriser les cibles privées/loopback (hors production seulement, tests)
```

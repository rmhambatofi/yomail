# Plan d'implémentation — Boîte email jetable `yo.manitra.fr`

> Document destiné à être placé à la racine du repo (`docs/PLAN.md`) et exécuté phase par phase avec Claude Code.
> Chaque phase est autonome, livrable et vérifiable. Ne pas passer à la phase suivante tant que les critères d'acceptation ne sont pas validés.

---

## 0. Récapitulatif des décisions

| Sujet             | Décision                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Produit           | Boîte mail jetable type YopMail, réception uniquement, aucune authentification : quiconque saisit `xxx@yo.manitra.fr` voit la boîte |
| Domaine mail      | `yo.manitra.fr` (MX, rDNS, TLS déjà en place)                                                                                       |
| Rétention         | 10 jours **par email**, valeur globale modifiable en base (table `settings`), sans UI admin                                         |
| Taille max        | 2 Mo par email (MIME brut), au-delà : rejeté silencieusement                                                                        |
| Pièces jointes    | Non exposées (on conserve le MIME brut, on affiche un marqueur "has attachments")                                                   |
| Rendu             | HTML sanitisé dans une iframe sandbox, images distantes bloquées par défaut, liens cliquables en nouvel onglet                      |
| Temps réel        | Non, bouton "Refresh"                                                                                                               |
| Hébergement       | cPanel mutualisé (sans root), Node 22, MySQL                                                                                        |
| Réception SMTP    | Exim (cPanel) → adresse par défaut du domaine en **pipe vers un script Node** → `POST /api/internal/ingest`                         |
| Stack             | NestJS 10 + TypeORM + MySQL / React 18 + Vite + TypeScript + Tailwind                                                               |
| Monorepo          | npm workspaces (pnpm non disponible nativement sur cPanel)                                                                          |
| Langue UI         | Anglais                                                                                                                             |
| Hors périmètre v1 | Tests automatisés, CI, anti-abus, modération, RGPD, API publique, chiffrement au repos, logs IP                                     |

### Défauts choisis (non discutés, modifiables)

- Nom du projet / package : `yomail`
- Local-part autorisé : `^[a-z0-9][a-z0-9._-]{0,63}$`, normalisé en minuscules. Le `+tag` est ignoré (`test+abc@` → boîte `test`).
- Liste d'une boîte limitée aux 200 derniers emails.
- Purge : cron cPanel toutes les heures (`npm run purge`) **et** `@nestjs/schedule` en secours (Passenger peut mettre l'app en veille, le cron cPanel est la source de vérité).
- La date d'expiration n'est pas stockée : `expires_at = received_at + retention_days`, calculée à la lecture et à la purge. Ainsi un changement de `retention_days` s'applique immédiatement à tous les emails.
- Le front est servi en statique depuis `public_html` du sous-domaine `yo.manitra.fr`, l'API est montée par Passenger sur `yo.manitra.fr/api`.

---

## 1. Architecture

```
                 Internet
                    │ SMTP (25, STARTTLS)
                    ▼
            Exim (cPanel MTA)
   "Default address" yo.manitra.fr → pipe
                    │ stdin = MIME brut
                    ▼
      apps/ingest/bin/ingest.sh  →  node ingest.js
        - lit stdin, refuse > 2 Mo (exit 0 = discard)
        - POST https://yo.manitra.fr/api/internal/ingest
          header X-Ingest-Secret, body = MIME brut
                    │
                    ▼
        NestJS (Passenger)  /api
        - IngestController : parse (mailparser), sanitize (sanitize-html), persiste
        - InboxController : lecture / suppression
        - PurgeService : suppression des emails expirés
                    │
                    ▼
                 MySQL
                    ▲
                    │ fetch /api/...
        React SPA (static, public_html)
```

Pourquoi un pipe Exim et non `smtp-server` dans Nest : sur cPanel mutualisé le port 25 appartient à Exim et Passenger ne permet pas de process persistant hors HTTP. Le pipe est le mécanisme standard cPanel, robuste et sans configuration root.

---

## 2. Structure du monorepo

```
yomail/
├── package.json              # workspaces: apps/*, packages/*
├── .nvmrc                    # 22
├── .env.example
├── CLAUDE.md
├── docs/
│   ├── PLAN.md               # ce fichier
│   └── DEPLOY_CPANEL.md
├── packages/
│   └── shared/               # types DTO partagés (EmailSummary, EmailDetail, ...)
│       ├── package.json
│       └── src/index.ts
├── apps/
│   ├── api/                  # NestJS
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── config/        # validation env (zod ou class-validator)
│   │   │   ├── database/      # datasource, migrations/
│   │   │   ├── settings/      # entité + service (retention_days)
│   │   │   ├── emails/        # entité Email, repository
│   │   │   ├── ingest/        # controller + guard secret + parser + sanitizer
│   │   │   ├── inbox/         # controller lecture/suppression + validation local-part
│   │   │   ├── purge/         # service + commande CLI
│   │   │   └── health/
│   │   └── bin/purge.ts       # point d'entrée CLI pour le cron cPanel
│   ├── ingest/               # script pipe Exim (dépendances minimales, Node natif)
│   │   ├── package.json
│   │   ├── bin/ingest.sh
│   │   └── src/ingest.js
│   └── web/                  # React + Vite
│       ├── package.json
│       └── src/
│           ├── main.tsx
│           ├── App.tsx        # routes: /, /inbox/:local, /inbox/:local/:id
│           ├── api/client.ts
│           ├── pages/HomePage.tsx
│           ├── pages/InboxPage.tsx
│           ├── pages/EmailPage.tsx
│           └── components/   # AddressForm, EmailList, EmailFrame, CopyButton, ...
└── scripts/
    └── deploy.sh             # build web + api, rsync vers cPanel (optionnel)
```

---

## 3. Modèle de données (MySQL, utf8mb4)

### `emails`

| Colonne           | Type                 | Notes                                                  |
| ----------------- | -------------------- | ------------------------------------------------------ |
| `id`              | CHAR(36) PK          | UUID v4                                                |
| `local_part`      | VARCHAR(64) NOT NULL | index, minuscules, sans `+tag`                         |
| `recipient`       | VARCHAR(255)         | adresse complète telle que reçue (champ `To`/envelope) |
| `from_address`    | VARCHAR(255)         |                                                        |
| `from_name`       | VARCHAR(255) NULL    |                                                        |
| `subject`         | VARCHAR(998) NULL    |                                                        |
| `text_body`       | MEDIUMTEXT NULL      |                                                        |
| `html_body`       | MEDIUMTEXT NULL      | HTML original                                          |
| `html_sanitized`  | MEDIUMTEXT NULL      | HTML nettoyé prêt à afficher                           |
| `raw_mime`        | MEDIUMBLOB NOT NULL  | ≤ 2 Mo                                                 |
| `size_bytes`      | INT UNSIGNED         |                                                        |
| `has_attachments` | TINYINT(1)           |                                                        |
| `message_id`      | VARCHAR(255) NULL    |                                                        |
| `received_at`     | DATETIME(3) NOT NULL | index (purge, tri)                                     |

Index : `idx_emails_local_received (local_part, received_at DESC)`, `idx_emails_received (received_at)`.

### `settings`

| Colonne | Type           |
| ------- | -------------- |
| `key`   | VARCHAR(64) PK |
| `value` | VARCHAR(255)   |

Seed : `('retention_days', '10')`. Pour étendre la durée : `UPDATE settings SET value='30' WHERE \`key\`='retention_days';`

Pas de table `inbox` : une boîte est l'ensemble des emails partageant un `local_part`.

---

## 4. API (préfixe `/api`)

| Méthode | Route                          | Description                                                                                                                                                                  |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/health`                      | `{ status: "ok", db: "ok" }`                                                                                                                                                 |
| GET     | `/inbox/:local`                | Liste (max 200, tri `received_at DESC`) : `id, from_address, from_name, subject, received_at, expires_at, size_bytes, has_attachments`                                       |
| GET     | `/inbox/:local/emails/:id`     | Détail : champs de la liste + `text_body`, `html_sanitized`, `recipient`                                                                                                     |
| GET     | `/inbox/:local/emails/:id/raw` | `text/plain`, MIME brut                                                                                                                                                      |
| DELETE  | `/inbox/:local/emails/:id`     | Supprime un email                                                                                                                                                            |
| DELETE  | `/inbox/:local`                | Vide la boîte                                                                                                                                                                |
| POST    | `/internal/ingest`             | Body brut (`Content-Type: message/rfc822`), header `X-Ingest-Secret`. 201 `{ id }`, 401 si secret invalide, 413 si > 2 Mo, 422 si aucun destinataire valide `@yo.manitra.fr` |

Règles :

- `:local` validé par `ParseLocalPartPipe` (regex, lowercase, retrait `+tag`) → 400 sinon.
- 404 si l'email n'existe pas **ou** n'appartient pas à `:local`.
- `expires_at` = `received_at + retention_days` calculé dans le service, jamais persisté.
- Réponses `Cache-Control: no-store`.
- CORS : même origine en prod, `http://localhost:5173` en dev.

### Pipeline d'ingestion

1. Guard `IngestSecretGuard` compare `X-Ingest-Secret` à `INGEST_SECRET` (comparaison constante).
2. Body lu en `raw` (désactiver le body-parser JSON sur cette route, `bodyParser.raw({ type: '*/*', limit: '2mb' })`).
3. `mailparser.simpleParser(raw)`.
4. Destinataires : union de `to`, `cc`, `bcc` (+ header `Delivered-To` / `X-Original-To` si présent, Exim les ajoute). Garder ceux en `@yo.manitra.fr`. Si plusieurs local-parts distincts → une ligne par boîte (même `raw_mime`). Si aucun → 422.
5. Sanitisation (`sanitize-html`) : whitelist de tags/attributs de mise en forme, suppression `script`, `iframe`, `object`, `form`, handlers `on*`, `style` avec `url(`. Les `<img src="http...">` sont réécrits en `data-src` (chargement différé côté front sur clic "Load images"). Liens : `target="_blank"`, `rel="noopener noreferrer nofollow"`.
6. Insertion, retour 201.

---

## 5. Script pipe Exim (`apps/ingest`)

`bin/ingest.sh` (chemin absolu vers le Node de cPanel, à adapter au déploiement) :

```sh
#!/bin/sh
exec /home/<user>/nodevenv/apps/yomail/apps/api/22/bin/node /home/<user>/apps/yomail/apps/ingest/src/ingest.js
```

`src/ingest.js` (Node natif, zéro dépendance) :

- Lit `stdin` intégralement dans un Buffer ; si `> MAX_EMAIL_BYTES` → log sur stderr, `exit 0` (Exim considère le message livré, pas de bounce).
- `POST` vers `INGEST_URL` avec `X-Ingest-Secret` (lus depuis `apps/ingest/.env` ou variables en dur dans `ingest.sh`), timeout 15 s.
- Codes de sortie : `0` en cas de succès ou de rejet volontaire (401/413/422 → on jette) ; `75` (EX_TEMPFAIL) si l'API est injoignable ou 5xx → Exim réessaie plus tard.
- Ne jamais écrire sur stdout (Exim l'interpréterait).

Configuration cPanel : _Email → Default Address → yo.manitra.fr → Advanced Options → Pipe to a Program_ : `apps/yomail/apps/ingest/bin/ingest.sh` (chemin relatif au home). `chmod +x` sur le script.

---

## 6. Front React (`apps/web`)

- Vite + React 18 + TypeScript + React Router + Tailwind. Pas de state manager global (fetch + `useState`/`useEffect` suffisent). Optionnel : TanStack Query pour le cache/refetch.
- Base URL de l'API : `import.meta.env.VITE_API_URL` (défaut `/api`).
- Pages :
  - **Home `/`** : champ texte "Choose your address" + suffixe fixe `@yo.manitra.fr`, validation locale (même regex que l'API), bouton "Open inbox" → `/inbox/:local`. Explication courte : réception uniquement, emails supprimés après N jours (valeur lue depuis `/health` ou en dur).
  - **Inbox `/inbox/:local`** : en-tête avec l'adresse complète + bouton copier, boutons "Refresh" et "Delete all" (confirmation), liste (expéditeur, sujet, date relative, badge pièce jointe, "expires in X days"), état vide "No emails yet — send one to this address and hit Refresh".
  - **Email `/inbox/:local/:id`** : en-tête (from, to, subject, date), onglets **HTML** (défaut) / **Text** / **Source**, boutons "Load images", "Delete", "Back".
- **Rendu HTML** : `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc={...}>`. Le `srcdoc` injecte une balise `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:">` et un petit CSS de base. "Load images" remplace `data-src` par `src` dans le HTML avant réinjection. Hauteur auto via `onLoad` (lecture de `contentDocument.body.scrollHeight`, possible car `srcdoc` est same-origin si on ajoute `allow-same-origin` — **ne pas** l'ajouter ; préférer une hauteur fixe 70vh scrollable).
- Responsive mobile-first ; liste → cartes sur petit écran.
- Pas d'analytics, pas de tracking.

---

## 7. Configuration (`.env`)

```
NODE_ENV=production
PORT=3000                        # ignoré par Passenger
API_PREFIX=api
MAIL_DOMAIN=yo.manitra.fr
DB_HOST=localhost
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=
INGEST_SECRET=                   # openssl rand -hex 32
MAX_EMAIL_BYTES=2097152
RETENTION_DAYS_DEFAULT=10        # utilisé si la table settings est vide
CORS_ORIGIN=https://yo.manitra.fr
```

`apps/ingest` : `INGEST_URL=https://yo.manitra.fr/api/internal/ingest`, `INGEST_SECRET`, `MAX_EMAIL_BYTES`.

---

## 8. Phases d'exécution pour Claude Code

### Phase 0 — Bootstrap du monorepo

- Initialiser npm workspaces, `.nvmrc` 22, ESLint + Prettier partagés, `tsconfig.base.json`.
- Créer `packages/shared` avec les DTO (`EmailSummary`, `EmailDetail`, `IngestResult`, `HealthStatus`, `LOCAL_PART_REGEX`, `normalizeLocalPart()`).
- Scaffold `apps/api` (Nest CLI), `apps/web` (Vite react-ts), `apps/ingest` (package minimal).
- Écrire `CLAUDE.md` (voir §9) et `.env.example`.
- **Acceptation** : `npm install` à la racine OK ; `npm run build -w apps/api` et `-w apps/web` passent ; `npm run dev` lance l'API et le front.

### Phase 1 — Base de données

- `TypeOrmModule.forRootAsync` avec config validée (zod). `synchronize: false`, `migrationsRun: false`.
- Entités `Email`, `Setting` ; migration initiale (tables + index) ; migration seed `retention_days=10`.
- `SettingsService.getRetentionDays()` avec cache 60 s.
- Scripts : `migration:generate`, `migration:run`, `migration:revert`.
- **Acceptation** : `npm run migration:run` crée les tables sur une MySQL locale (docker-compose fourni pour le dev) ; `GET /api/health` renvoie `db: ok`.

### Phase 2 — Ingestion

- `IngestModule` : guard secret, body raw 2 Mo, parsing `mailparser`, extraction des destinataires, sanitisation, persistance multi-boîtes.
- `apps/ingest/src/ingest.js` + `bin/ingest.sh`.
- Fixtures `.eml` dans `apps/api/test/fixtures/` : texte simple, HTML avec images distantes et script, multipart avec pièce jointe, destinataire en `Cc`, `+tag`, hors domaine, > 2 Mo.
- **Acceptation** : `curl -X POST --data-binary @fixture.eml -H "X-Ingest-Secret: ..." -H "Content-Type: message/rfc822" localhost:3000/api/internal/ingest` → 201 et ligne en base ; `cat fixture.eml | node apps/ingest/src/ingest.js` → même résultat ; les cas 401/413/422 renvoient les bons codes ; le HTML sanitisé ne contient ni `<script>` ni `on*` ni `src="http`.

### Phase 3 — API de lecture

- `InboxModule` : pipe de validation, controller, service (calcul `expires_at`), 404 croisés, `no-store`, CORS.
- **Acceptation** : parcours complet en `curl` : liste, détail, raw, suppression unitaire, vidage ; 400 sur local-part invalide ; 404 si l'`id` appartient à une autre boîte.

### Phase 4 — Purge

- `PurgeService.run()` : `DELETE FROM emails WHERE received_at < NOW() - INTERVAL :days DAY` par lots de 1000, log du nombre supprimé.
- `bin/purge.ts` (CLI, charge le contexte Nest en mode `createApplicationContext`, exécute, quitte) → script npm `purge`.
- `@nestjs/schedule` cron horaire en complément.
- **Acceptation** : insérer un email avec `received_at` vieux de 11 jours, `npm run purge` le supprime ; passer `retention_days` à 30 en base → il n'est plus supprimé.

### Phase 5 — Front

- Pages Home / Inbox / Email, client API typé via `packages/shared`, composants, iframe sandbox, "Load images", états chargement/erreur/vide, responsive.
- Proxy Vite `/api` → `localhost:3000` en dev.
- **Acceptation** : scénario manuel complet sur mobile et desktop : saisir une adresse, envoyer un mail de test (voir §10), Refresh, ouvrir, lien de vérification s'ouvre dans un nouvel onglet, images bloquées puis chargées, suppression.

### Phase 6 — Déploiement cPanel

- Rédiger `docs/DEPLOY_CPANEL.md` et `scripts/deploy.sh` :
  1. Build local : `npm run build` (web → `apps/web/dist`, api → `apps/api/dist`).
  2. Upload (rsync/SFTP/Git Version Control cPanel) vers `~/apps/yomail`.
  3. _Setup Node.js App_ : Node 22, application root `apps/yomail/apps/api`, application URL `yo.manitra.fr/api`, startup file `dist/main.js`, variables d'env saisies dans l'UI (ou `.env` lu par `dotenv`). `npm install --omit=dev` depuis l'UI.
  4. `main.ts` : si `process.env.PASSENGER_APP_ENV` (ou si `PORT` absent), écouter sur le socket/port fourni par Passenger (`app.listen(process.env.PORT ?? 3000)` suffit, Passenger injecte `PORT`). Préfixe global `api` **sans** doubler avec le montage Passenger : tester les deux variantes (`setGlobalPrefix` vs chemin déjà strippé par Passenger) et documenter le résultat.
  5. Copier `apps/web/dist/*` dans le `document root` du sous-domaine `yo.manitra.fr` ; `.htaccess` avec fallback SPA (`RewriteRule . /index.html`) **en excluant** `/api`.
  6. Migrations : `cd apps/api && source ~/nodevenv/.../activate && npm run migration:run`.
  7. Default Address → pipe vers `apps/yomail/apps/ingest/bin/ingest.sh` ; `chmod +x`.
  8. Cron cPanel : `0 * * * * cd ~/apps/yomail/apps/api && ~/nodevenv/.../bin/node dist/bin/purge.js >> ~/logs/yomail-purge.log 2>&1`.
- **Acceptation** : envoyer un mail réel depuis Gmail vers `test@yo.manitra.fr`, il apparaît sur https://yo.manitra.fr/inbox/test ; log du cron de purge présent.

### Phase 7 — Ultérieur (hors v1)

- Tests : Jest unitaires (sanitizer, normalisation, purge), e2e Supertest avec MySQL via docker-compose, fixtures `.eml`.
- CI GitLab/GitHub : lint, build, tests, artefact de build.
- Anti-abus : rate limiting sur `/inbox/*`, blocage de local-parts réservés (`admin`, `postmaster`, `abuse`), liste noire d'expéditeurs, quota par boîte.
- Observabilité : logs structurés, compteur d'emails ingérés/rejetés.
- Robustesse : rejet des boucles (header `Auto-Submitted`), taille de la liste paginée.

---

## 9. Contenu de `CLAUDE.md` (à placer à la racine)

```md
# yomail — disposable inbox for yo.manitra.fr

## Context

Receive-only disposable mailbox (YopMail-like). No auth: anyone opening /inbox/<local> sees that inbox.
Hosting: cPanel shared (no root), Node 22, MySQL. Inbound mail arrives via Exim "default address" piped to apps/ingest/bin/ingest.sh, which POSTs the raw MIME to the API.
Retention: `settings.retention_days` (default 10), applied per email, never stored as expires_at.
See docs/PLAN.md for the full plan and phases.

## Stack & conventions

- npm workspaces: apps/api (NestJS 10, TypeORM, MySQL), apps/web (React 18 + Vite + TS + Tailwind), apps/ingest (plain Node, zero deps), packages/shared (DTOs).
- TypeScript strict everywhere. ESLint + Prettier at root.
- TypeORM: `synchronize: false`; every schema change = a migration in apps/api/src/database/migrations.
- API prefix `/api`. Responses `Cache-Control: no-store`.
- Local-part rule lives in packages/shared (`LOCAL_PART_REGEX`, `normalizeLocalPart`) and is the single source of truth for API and web.
- HTML from emails is untrusted: sanitize server-side (sanitize-html), render client-side only inside `<iframe sandbox>` without `allow-same-origin`. Remote images blocked until the user clicks "Load images".
- Max email size 2 MB (MAX_EMAIL_BYTES); larger messages are dropped silently (exit 0 in the pipe script).
- UI language: English. No analytics, no IP logging.
- No tests/CI in v1 (planned later); keep code testable (services without HTTP concerns).

## Commands

- `npm run dev` — api (3000) + web (5173, proxies /api)
- `npm run build` — builds all workspaces
- `npm run migration:run -w apps/api`
- `npm run purge -w apps/api`
- `docker compose up -d` — local MySQL

## Don'ts

- Don't add `allow-same-origin` to the email iframe.
- Don't store expires_at; compute from received_at + retention_days.
- Don't write to stdout in apps/ingest (Exim reads it).
- Don't add WebSocket/SSE, attachments download, auth, or public API in v1.
```

---

## 10. Outils de test manuel

- Envoi SMTP direct en dev (si un serveur local est branché) ou via l'API : `curl -X POST --data-binary @apps/api/test/fixtures/html-with-images.eml -H "Content-Type: message/rfc822" -H "X-Ingest-Secret: $INGEST_SECRET" http://localhost:3000/api/internal/ingest`
- Simulation du pipe : `cat fixture.eml | INGEST_URL=http://localhost:3000/api/internal/ingest INGEST_SECRET=... node apps/ingest/src/ingest.js; echo "exit=$?"`
- En production : `swaks --to test@yo.manitra.fr --from me@example.com --server yo.manitra.fr --header "Subject: hello" --body "verify: https://example.com/verify?token=abc"` ou simplement un mail depuis Gmail.

---

## 11. Risques et points de vigilance

| Risque                                                                   | Mitigation                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Passenger met l'app en veille → premier appel lent, cron Nest non fiable | Purge pilotée par le cron cPanel ; `ingest.js` renvoie `75` pour qu'Exim réessaie si l'API dort                                 |
| Double préfixe `/api/api` selon le montage Passenger                     | Tester dès la phase 6, rendre `API_PREFIX` configurable                                                                         |
| Chemin du binaire Node dans `ingest.sh`                                  | Documenter `ls ~/nodevenv/` ; vérifier avec `which node` depuis le shell activé                                                 |
| Limites MySQL mutualisé (`max_allowed_packet` < 2 Mo)                    | Vérifier `SHOW VARIABLES LIKE 'max_allowed_packet'` ; si < 4 Mo, demander l'augmentation ou stocker `raw_mime` compressé (gzip) |
| HTML malveillant                                                         | Sanitisation serveur + iframe sandbox + CSP ; jamais `dangerouslySetInnerHTML` hors iframe                                      |
| Boîte inondée (spam)                                                     | Hors v1 ; la limite de 200 en liste évite l'explosion de l'UI                                                                   |

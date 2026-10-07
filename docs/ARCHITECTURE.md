# yomail architecture

This document describes how yomail is built and why. It complements the product plan in [PLAN.md](PLAN.md) (French) and the operations guide in [DEPLOY_CPANEL.md](DEPLOY_CPANEL.md). The diagrams are generated from the repository sources; their JSON definitions live in [diagrams/src](diagrams/src) (see [Regenerating the diagrams](#regenerating-the-diagrams)).

## 1. Context and constraints

yomail is a webhook catcher: a user creates an endpoint identified by a server-generated UUID v4, sends HTTP requests to `https://yo.manitra.fr/<uuid>[/sub/path]`, and reads them live at `/inbox/<uuid>`.

Three constraints shape the architecture:

| Constraint                                                                                              | Consequence                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared cPanel hosting**: Node 22 under Phusion Passenger on Apache, MySQL, no root, no extra daemons. | One Node process tree per app, started by Passenger; no Redis, no message broker; background work runs through cPanel cron.                                                                                                                                               |
| **Passenger on Apache has no WebSocket upgrade** and may run several app processes.                     | Socket.IO runs over HTTP long-polling with sticky sessions, and live updates must work across processes without shared memory (see §4).                                                                                                                                   |
| **Anonymous inboxes have no authentication** by design: the UUID is the only secret.                    | Every read and clear of an ownerless endpoint is open to anyone who knows the id; bodies are treated as untrusted text and rendered defensively (see §6). An endpoint owned by a member is private to that member (details, inbox, live events); only capture stays open. |

## 2. System overview

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/system-dark.svg">
  <img alt="yomail system overview" src="diagrams/system-light.svg">
</picture>

### Runtime components

| Component                           | Location                                                                 | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache + Passenger                  | cPanel, `deploy/htaccess`                                                | Mounts the Nest app at the root of the subdomain, `PassengerStickySessions on`, security headers. The document root holds nothing but `.htaccess`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CaptureController`                 | `apps/api/src/capture`                                                   | `@All('/:uuid')` and `@All('/:uuid/*')`, excluded from the `/api` prefix. Validates the id, loads the endpoint (`id`, `owner_id`, `response_config` in one query), streams the body with a size cap, classifies and parses it, stores one `requests` row, answers `200 {ok, id}` with CORS `*`, or the owner-configured response (phase 8) after its `delay_ms`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| REST API                            | `apps/api/src/endpoints`, `apps/api/src/requests`, `apps/api/src/health` | `/api/endpoints`, `/api/endpoints/:id/requests`, `/api/health`, plus the owner routes (`PATCH` endpoint, `claim`, `PATCH` note, `replay`) and `GET /api/account/endpoints`. Lists never load bodies, headers or notes; details compute `html_sanitized` on read. `EndpointsService.loadOwned()` resolves `404` / `403 NOT_OWNER` for every owner route.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ReplayService`                     | `apps/api/src/requests/replay.service.ts`, `address-guard.ts`            | Re-sends a stored request to a URL chosen by the owner over Node `http`/`https` with a custom `lookup` that refuses non-public addresses at connection time; no redirects, one attempt, `REPLAY_TIMEOUT_MS`, response cut at 64 KB, hop-by-hop and proxy headers stripped, `User-Agent` `yomail-replay/1` when absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LiveGateway` + `LiveEventsService` | `apps/api/src/live`                                                      | Socket.IO on `/api/socket.io`, one room per endpoint (`ep:<id>`), max 10 rooms per socket. `subscribe` applies the inbox read rule (the handshake cookie identifies the member; an owned endpoint is refused to anyone else) and `endpoint:claimed` drops the room's sockets. The in-process event bus connects capture/delete/clear/claim to the gateway.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ChangeDetector`                    | `apps/api/src/live`                                                      | Polls MySQL every 2 s for endpoints that have subscribers on this process, with a 1 s overlap, and delivers rows not emitted in the last 15 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ServeStaticModule`                 | `apps/api/src/static`                                                    | Serves `apps/web/dist` when `WEB_DIST_DIR` is set: `assets/` immutable for a year, everything else `no-cache`, `GET *` fallback to `index.html` except under `/api`. Registered **last** in `AppModule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PurgeService`                      | `apps/api/src/purge`, `apps/api/src/cli/purge.ts`                        | Deletes expired requests in batches of 1000 and idle endpoints. Triggered hourly by the cPanel cron (`npm run purge`, source of truth) and by an in-process `@nestjs/schedule` job as backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AuthModule` + `UsersModule`        | `apps/api/src/auth`, `apps/api/src/users`                                | `/api/auth/*` and `/api/account`: sign-up (`DISABLED` until the email is confirmed), login by email or username, DB-backed sessions in an `HttpOnly` cookie, single-use email tokens, scrypt hashing, zod validation, in-process throttler. `AuthGuard` / `OptionalAuthGuard` / `RolesGuard`; `POST /api/endpoints` records the owner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MailService` + dev mail catcher    | `apps/api/src/mail`                                                      | Confirmation and reset emails. In production (`isProduction(NODE_ENV)`), nodemailer over the cPanel mailbox (`SMTP_*`); in every other environment nothing is sent: `DevMailboxService` stores the messages in the table `caught_mails` (last 200) and `DevMailCatcherController` serves them at the fixed path `/devmailcatcher` (outside the `/api` prefix, `AuthGuard` + `RolesGuard("ADMIN")`: the messages carry confirmation and reset links, so only an admin may read them; the account page of an admin links to it). The catcher exists in every environment, production included: other applications under development push their emails to it with `POST /devmailcatcher/messages.json` (admin session, 96 KB JSON). DB-backed because Passenger runs several processes. `send()` never throws. |
| `user` CLI                          | `apps/api/src/cli/user.ts`                                               | `create-admin`: the only way to create an `ADMIN` (no API route creates or promotes one). Boots a Nest context without HTTP, like the purge CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| React SPA                           | `apps/web`                                                               | `/` (create, open by id or URL, recent endpoints in `localStorage`), `/inbox/:uuid[/:rid]` (list + detail panel). `useLiveRequests` merges REST pages and socket events, deduped by id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@yomail/shared`                    | `packages/shared`                                                        | DTOs, Socket.IO event maps, `ENDPOINT_ID_REGEX`, `extractEndpointId()`. Dual ESM/CJS build because Nest compiles to CommonJS and Vite consumes ESM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Request routing

Everything on the subdomain goes to Node. Inside Nest, routes are matched in this order:

1. `/api/...`: REST controllers and the Socket.IO handler.
2. `/<uuid>` and `/<uuid>/*`: capture (only when the first segment matches the UUID regex).
3. Anything else: static files from `apps/web/dist`, then `index.html` for SPA deep links. Unknown `/api` paths still get a JSON `404`.

The `/api` prefix is applied with `setGlobalPrefix(prefix, { exclude })`. The exclude list contains the escaped literal capture route strings, because path-to-regexp tests patterns against route _definitions_, not URLs (a bare `:id` pattern would strip the prefix from every single-segment route).

## 3. Request lifecycle: capture and live delivery

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/capture-live-dark.svg">
  <img alt="Capture and live delivery sequence" src="diagrams/capture-live-light.svg">
</picture>

Steps in the capturing process (process A):

1. **Validate** the UUID with `ENDPOINT_ID_REGEX`, then **check the endpoint exists** (`findForCapture` also returns `owner_id` and `response_config`). Both happen before a single body byte is read; failure answers `404 {ok:false, error}` with CORS headers.
2. **Stream the body** through `raw-body.ts` up to `MAX_BODY_BYTES`. Above the limit the stream is aborted, `413` is returned and nothing is stored.
3. **Classify and parse** (`content.ts`): `content_kind` is one of `none | json | form | multipart | html | xml | text | binary`. Form bodies become `form_fields`; multipart text parts become `form_fields` while file parts are counted into `dropped_files` and discarded; binary bodies keep metadata only.
4. **Store** one `requests` row, update `endpoints.last_request_at`, and enforce the cap (`MAX_REQUESTS_PER_ENDPOINT`, or `MAX_REQUESTS_PER_ENDPOINT_MEMBERS` when the endpoint has an owner) by deleting the oldest rows of that endpoint.
5. **Emit** `request:new` on the in-process bus. `LiveGateway` forwards it to room `ep:<id>` and tells `ChangeDetector` to remember the id.
6. **Reply** `200 {ok:true, id}`, or, when the owner configured a response, wait `delay_ms` (asynchronous `setTimeout`, at most 10 s) and send the configured status, headers, `Content-Type` and body, always preceded by the CORS headers, `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` (§6). The wait happens after the insert and the live event, so the inbox shows the request while the sender is still waiting. `HEAD` gets the status and headers without a body; `OPTIONS` is captured like any other method, which is why the CORS middleware is only mounted outside capture paths. `404` and `413` are never customised.

Everything else is done by the REST layer: deletes return `204`, a request id that belongs to another endpoint is a `404` (the service always filters on `{ id, endpointId }`), and malformed ids are `400` through `ParseUUIDPipe`.

## 4. Real time without WebSocket and across processes

Design goals: keep working under Apache + Passenger (HTTP long-polling only), with any number of app processes, and degrade gracefully.

| Mechanism                                                                                                            | Role                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Socket.IO over long-polling** on `/api/socket.io` (`ConfiguredIoAdapter`, 16 KB buffer, same CORS as `/api`).      | Transport that Passenger can proxy. `PassengerStickySessions` keeps a client's consecutive polls on the same process. |
| **In-process bus** (`LiveEventsService`).                                                                            | Immediate delivery to sockets connected to the process that captured the row.                                         |
| **DB polling** (`ChangeDetector`, every 2 s, 1 s overlap, only for endpoints with subscribers, ids remembered 15 s). | Delivery to sockets connected to _other_ processes; also catches rows committed slightly late.                        |
| **Client dedupe by id** (`useLiveRequests`).                                                                         | Both server paths may emit the same row; the client keeps one.                                                        |
| **REST polling fallback** every 5 s while the socket is down, full reload on reconnect.                              | Keeps the inbox moving when long-polling fails; the badge shows `polling`, then `offline` when REST fails too.        |

The gateway's `@WebSocketGateway()` options are set in `main.ts` rather than in the decorator because the decorator runs before `.env` is loaded.

## 5. Data model and retention

```
endpoints                          requests
---------                          --------
id              char(36) PK        id               char(36) PK
created_at      datetime(3)        endpoint_id      char(36) FK -> endpoints (ON DELETE CASCADE)
last_request_at datetime(3) NULL   method           varchar(16)
owner_id        char(36) NULL      path             varchar(2048)
name            varchar(80) NULL   query_params     json NULL        [name, value][]
response_config json NULL          headers          json             [name, value][]
                                   client_ip        varchar(45) NULL
settings                           content_type     varchar(255) NULL
--------                           content_kind     enum(none,json,form,multipart,html,xml,text,binary)
key             varchar(64) PK     body             mediumtext NULL  (never for multipart/binary)
value           varchar(255)       form_fields      json NULL
  retention_days = 10              dropped_files    json NULL        [{field, filename, size}]
  retention_days_members = 30      size_bytes       int unsigned
                                   received_at      datetime(3)
                                   note             text NULL        (owner's note, detail only; phase 8)

indexes: idx_requests_endpoint_received (endpoint_id, received_at), idx_requests_received (received_at),
         idx_endpoints_last_request (last_request_at)

Accounts (phase 7):

endpoints.owner_id  char(36) NULL FK -> users (ON DELETE SET NULL), idx_endpoints_owner

users                                       sessions
-----                                       --------
id            char(36) PK                   id           char(36) PK
username      varchar(32)  uq (collation-insensitive)   user_id  char(36) FK -> users (CASCADE)
email         varchar(254) uq, lowercase    token_hash   char(64) uq   (sha256 of the cookie token)
password_hash varchar(255) scrypt$N$r$p$salt$hash        created_at, last_seen_at, expires_at datetime(3)
status        enum(DISABLED,ENABLED,DELETED)             user_agent varchar(255) NULL, ip varchar(45) NULL
role          enum(ADMIN,STANDARD)
created_at, updated_at datetime(3)          user_tokens
enabled_at, deleted_at, last_login_at NULL  -----------
                                            id, user_id FK (CASCADE), kind enum(CONFIRM_EMAIL,RESET_PASSWORD)
                                            token_hash char(64) uq, created_at, expires_at, used_at NULL

Dev mail catcher (every environment, admin-only, last 200 rows kept):

caught_mails
------------
id char(12) PK, to_address varchar(320) (idx), from_address varchar(320), subject varchar(998),
text mediumtext, html mediumtext, links json (string[]), sent_at datetime(3) (idx)
```

- **Account statuses**: `DISABLED` = created, email not confirmed (login refused with `ACCOUNT_DISABLED`); `ENABLED` = active; `DELETED` = removed by its owner, row kept but anonymized (`deleted+<id>@invalid`, `deleted_<8 chars>`, empty hash) so the identifiers are free again, sessions and tokens deleted, endpoints kept with `owner_id = NULL`. Accounts never confirmed are hard-deleted by the purge after `UNCONFIRMED_USER_TTL_DAYS`.

- **Retention is computed, never stored.** `expires_at = received_at + retention` is derived at read time and at purge time, where the retention is `settings.retention_days` (default `10`) for an anonymous endpoint and `settings.retention_days_members` (default `30`) when the endpoint has an owner; both rows are seeded by migrations and changing them applies immediately. The same rule picks the row cap (`MAX_REQUESTS_PER_ENDPOINT` vs `MAX_REQUESTS_PER_ENDPOINT_MEMBERS`). Limits follow **ownership, not role**: an `ADMIN` gets nothing more. An endpoint is idle, and purged, when `COALESCE(last_request_at, created_at)` is older than its cutoff.
- **Ownership** (`endpoints.owner_id`): set at creation when a session is present, or later through `claim` on an endpoint without owner. No transfer or release; deleting the account sets it to `NULL` through the FK. `name` and `response_config` are owner-edited; `response_config` is stored exactly as validated and read back on every capture.
- **Purge** runs raw `DELETE ... ORDER BY received_at LIMIT 1000` in a loop (TypeORM's `delete()` has no `LIMIT`) with two cutoffs (rows of anonymous endpoints vs rows of owned endpoints, joined on `owner_id IS NULL`), then deletes idle endpoints with the same two cutoffs, expired sessions, used or expired tokens and stale unconfirmed accounts. A re-entrancy flag skips overlapping runs. The CLI entry (`dist/cli/purge.js`) boots its own `PurgeCliModule` with `createApplicationContext`, so no HTTP server and no scheduler run inside the cron.
- **Schema changes are migrations** (`synchronize: false`), listed explicitly in `migrations/index.ts` so ts-node and the compiled `dist/` share one list. Column names are snake_case, FK and index names are explicit, so `migration:generate` sees no spurious diff.
- **Lists never load `body`, `headers`, `form_fields`, `note`**: queries use explicit column lists (`SUMMARY_COLUMNS` / `DETAIL_COLUMNS` in `request.mapper.ts`). Lists are newest first, 50 per page (max 200), cursor `?before=<received_at>`.

## 6. Security model

Anonymous inboxes have no authentication: the UUID is the capability, as on webhook.site, and reading, deleting a request or clearing such an inbox stay open to whoever knows it. An endpoint owned by a member (created while signed in, or claimed) is **private**: its details, inbox, request details, deletes, clear and Socket.IO room are served to the owner only (`401 UNAUTHENTICATED` without a session, `403 NOT_OWNER` for another member), and only the owner can rename it, configure its response, annotate or replay its requests, and delete it. Capture stays open on every endpoint: a private endpoint still receives webhooks from anyone. What the system defends against is hostile _content_, account credentials, and the two attack surfaces the member features open: a configurable response served from the app origin, and an outgoing request chosen by a user.

- **Bodies are untrusted text.** Files and binary bodies are never persisted. HTML is sanitized **on read** (`html-sanitizer.ts`; `html_sanitized` is never stored) and rendered client-side only inside `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=...>` with an injected `Content-Security-Policy` meta that blocks scripts and, unless the user opts in, images. `allow-same-origin` is never added, so the document gets an opaque origin. `dangerouslySetInnerHTML` is not used outside that iframe. JSON is tokenized into React spans, never injected as HTML.
- **Capture replies are hand-written** (`@Res()`) so `404` and `413` carry the same CORS headers and `{ok, error}` body as success.
- **Every API response is `Cache-Control: no-store`**; CORS on `/api` is restricted to the configured origin (same origin in production).
- **Proxy awareness**: `TRUST_PROXY=1` in production so `client_ip` reflects `X-Forwarded-For`; the headers table in the UI dims proxy-added headers.
- **Input validation**: ids go through `ParseUUIDPipe` (`400`), dates through `ParseIsoDatePipe`, environment through a `zod` schema at boot.
- **Bounded resources**: body size cap, per-endpoint row cap, retention purge, max 10 rooms per socket, 16 KB Socket.IO buffer.
- **Ownership checks** go through two helpers of `EndpointsService`: `loadReadable` / `assertReadable` for reads (an ownerless endpoint is readable by anyone, an owned one only by its owner: `404` unknown, `401 UNAUTHENTICATED` without a session, `403 NOT_OWNER` for another member) and `loadOwned` for writes (`404`, then `403 NOT_OWNER`). The gateway applies the read rule to `subscribe` from the session cookie of the Socket.IO handshake (`sessionTokenFromCookieHeader`), and `claim` emits `endpoint:claimed` so the subscribers already in the room are dropped on that process and the SPA re-checks its access (sockets on other Passenger processes are checked again when they reconnect). The configured response is returned only to the owner (`response` is `null` for everyone else, who only sees the `custom_response` flag).
- **Configured responses** are served from the SPA origin (`yo.manitra.fr/<uuid>`), so an owner could otherwise serve HTML that reads the app's cookies or calls `/api` with a victim's session. Every custom response therefore carries `Content-Security-Policy: sandbox` (opaque origin: no cookies, no same-origin fetch, no `localStorage`) and `X-Content-Type-Options: nosniff`, and the validation refuses the header names that could undo it: framing (`content-length`, `transfer-encoding`, `connection`, ...), `set-cookie`, `host`, the CORS and CSP/nosniff names, and `content-type` (dedicated field). Bounds: status 100 to 599, body 64 KB, 20 headers, header values without CR/LF, delay 10 s. The CORS `*` headers are set before the user's headers and cannot be overridden.
- **Replay is SSRF-guarded** (`ReplayService`, `address-guard.ts`): `http`/`https` only, no credentials in the URL, port 80, 443 or 1024 and above, local hostnames refused without DNS (`localhost`, `*.local`, `*.internal`, ...), and every address the hostname resolves to is checked **inside the `lookup` passed to `http.request`**, so there is no window between the check and the connection; refused: loopback, link-local, RFC 1918 and 4193, CGNAT, documentation, multicast, reserved, unspecified, and IPv4 embedded in IPv6. Redirects are returned, never followed. Owner only, 30 per minute per IP, one attempt, `REPLAY_TIMEOUT_MS`, response cut at 64 KB, hop-by-hop, proxy and `Host` headers stripped. `REPLAY_ALLOW_PRIVATE=1` disables the address check for local tests and is refused in production.
- **Accounts**: passwords hashed with Node's built-in scrypt (N=2^15, r=8, p=1, 16-byte salt; no native module to build on cPanel) and compared in constant time, with a dummy derivation when the user does not exist so timing does not leak it. Sessions are rows in MySQL (works across Passenger processes, revocable on reset or deletion); the cookie holds a 32-byte random token, only its SHA-256 is stored, `HttpOnly; SameSite=Lax; Secure` in production, 30 days, no sliding renewal. Email links carry single-use tokens (hash stored, 48 h for confirmation, 60 min for reset, a new one invalidates the previous) consumed by a `POST` from the SPA, never by the `GET` of the link, so prefetchers cannot burn them. CSRF: `SameSite=Lax` plus JSON-only bodies on every mutating route (a cross-site form cannot send `application/json` without a preflight, which the same-origin CORS refuses). JSON parsing is mounted per controller (`express.json`: 16 KB on auth, account and requests; 96 KB on endpoints, whose `PATCH` carries a 64 KB response body); the app itself stays `bodyParser: false` and the capture route streams its own body. Sign-up, confirm, resend, login, forgot and reset are throttled per IP (in-process memory, so the effective limit is multiplied by the number of Passenger processes: accepted). Account enumeration is accepted at sign-up (`409` names the field); forgot/resend always answer `200`.

## 7. Front end

- React 18 + Vite + TypeScript + Tailwind + React Router. No global state manager: `lib/useAsync.ts` (fetch on mount, abort on unmount, `reload()`) plus local state.
- `api/client.ts` is the only module that calls `fetch`; it throws `ApiError` with the HTTP status so pages can special-case `400` / `404` (unknown endpoint page).
- `InboxPage` serves both `/inbox/:uuid` and `/inbox/:uuid/:rid`. On mobile the presence of `:rid` decides whether the list or the detail is visible; "Back to inbox" keeps the socket alive. Request details are cached per id for the life of the page.
- `RequestPanel` sections: details table, `HeadersTable` (copy all), query params, one content viewer per `content_kind` (`JsonViewer`, `FormViewer`, `HtmlViewer` → `HtmlFrame`, `TextViewer`), then, for the owner, **Note** (textarea, saved through `PATCH`, the per-id cache is updated in place) and **Replay** (target URL remembered per endpoint in `localStorage`, result with status, headers and body). Any signed-in user gets **Copy as cURL** (`lib/curl.ts`: method, full URL, headers minus `Host`, `Content-Length`, `Connection` and proxy headers, body in single quotes with `--data-binary`; multipart/binary bodies become a comment).
- Member UI: `HomePage` shows **My endpoints** (`GET /api/account/endpoints`) above the browser's recents (filtered of owned ids); `InboxPage` reads `GET /api/endpoints/:id` for `name`, `owned`, `has_owner`, `custom_response`, `retention_days`, `max_requests` and shows the name, the **Yours** badge, the applicable limits, and the buttons the caller is entitled to (**Edit** opens `EndpointSettings` with the Name and Response forms, **Claim this endpoint**, **Delete endpoint**). `RequestFilter` (signed in) filters the loaded list in memory on method, path, IP and short id and shows "n of m". A `401` / `403` on the inbox puts `useLiveRequests` in the `forbidden` state: the page shows "This endpoint is private" with a **Sign in** link (`/login?next=`) for anonymous visitors, and nothing of the inbox (name, requests, note) is rendered.
- `config.ts`: `API_URL` is `/api`; `PUBLIC_BASE_URL` is `window.location.origin` because the SPA and the capture routes share one origin. In development Vite proxies `/api` (with `ws: true`) and `/<uuid>...` to the API.
- Accounts: `lib/auth.tsx` (`AuthProvider` does one `GET /api/auth/me` at mount, `useAuth()`, `RequireAuth` redirects to `/login?next=`; only same-site relative `next` values are honoured). Pages `/signup`, `/login`, `/confirm/:token`, `/forgot-password`, `/reset-password/:token`, `/account`, built on `components/AuthForm.tsx` (`AuthCard`, `Field`, `describeAuthError` keyed on the API `code`). The header shows **Sign in / Sign up** or the username + **Sign out**. The cookie is `HttpOnly`, so the API is the only source of truth for the session.

## 8. Deployment topology

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/deploy-dark.svg">
  <img alt="Deployment workflow to cPanel" src="diagrams/deploy-light.svg">
</picture>

- `scripts/deploy.sh` builds `shared`, `api`, `web`, then uploads only the runtime file set (`package.json`, lockfile, `.nvmrc`, the three `dist/` directories, deploy files) with `tar | ssh`. Sources, `node_modules` and `.env` never leave the machine.
- `deploy/htaccess` is merged into the document root's `.htaccess`, keeping only the **last** cPanel-owned Passenger block (matched by its fence comments anchored at the start of a line). v1 SPA leftovers (`index.html`, `assets/`) are removed from the docroot because Apache would serve existing files before Passenger.
- On the server: `npm ci --omit=dev` at the monorepo root (the workspace link to `@yomail/shared` requires it), `migration:run:prod` on the compiled `dist/`, then `touch apps/api/tmp/restart.txt` to restart Passenger.
- **Server configuration lives only in `~/yomail/apps/api/.env`**, never in the Passenger UI: the cron and the migrations run outside Passenger and would not see UI variables.
- Hourly cron: `npm run purge` from the app directory.

## 9. Invariants worth keeping

- Check the endpoint before reading the body; never store a body above the cap; always answer capture routes with CORS `*`.
- Never add `allow-same-origin` to the preview iframe; never render untrusted HTML outside it.
- Never assume a single process or a real WebSocket: keep the DB polling, the id dedupe and the REST fallback.
- Keep `ServeStaticModule` last in `AppModule`; keep the capture routes excluded from the global prefix by their literal strings.
- Classes injected through constructors in `apps/api` must stay runtime imports (not `import type`), or Nest DI breaks.
- Every schema change is a migration registered in `migrations/index.ts`.
- Never store a raw session or email token (hash only); never consume an email token on a `GET`; never add an API route that creates or promotes an `ADMIN`; keep the dev mail catcher behind the `ADMIN` role in every environment, and never copy production emails of this app into it (SMTP only).
- Keep JSON body parsing scoped per controller (auth, account, endpoints, requests); the capture route must keep streaming its own body.
- Every read of an endpoint, its requests or its Socket.IO room goes through `loadReadable` / `assertReadable` (ownerless → anyone, owned → owner only); every write through `loadOwned` (`404` then `403 NOT_OWNER`). Capture never checks ownership.
- A custom response always carries CORS `*`, `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, set before the user's headers; `RESPONSE_FORBIDDEN_HEADERS` stays the single list of refused names; capture errors are never customised.
- Replay keeps its address check inside the `lookup` of the outgoing request and never follows redirects; `REPLAY_ALLOW_PRIVATE` must stay ignored in production.
- Retention and caps follow the ownership of the endpoint (two cutoffs in the purge), never the user's role.

## Regenerating the diagrams

The diagrams are authored for [Archify](https://github.com/tt-a1i/archify) and are repository-backed: each node carries `sources` pointing at the file and lines that justify it, pinned to a commit in `meta.repository`.

- Sources: `docs/diagrams/src/system.architecture.json`, `capture-live.sequence.json`, `deploy.workflow.json`.
- Render and check (from the repo root, with Archify installed):

  ```sh
  node <archify>/bin/archify.mjs finalize architecture docs/diagrams/src/system.architecture.json docs/diagrams/out/yomail-system.html --repo-root . --quality showcase
  node <archify>/bin/archify.mjs finalize sequence     docs/diagrams/src/capture-live.sequence.json docs/diagrams/out/yomail-capture-live.html --repo-root . --quality showcase
  node <archify>/bin/archify.mjs finalize workflow     docs/diagrams/src/deploy.workflow.json       docs/diagrams/out/yomail-deploy.html --repo-root . --quality showcase
  ```

- Export: open the generated HTML and use **Export → SVG (light)** and **SVG (dark)**; save them as `docs/diagrams/<name>-light.svg` and `<name>-dark.svg`. The README and this document pick the variant with a `<picture>` element and `prefers-color-scheme`.
- After changing the cited files, update the `sources` line ranges and the `revision` in `meta.repository`; `finalize --repo-root .` verifies that each reference exists at that commit.

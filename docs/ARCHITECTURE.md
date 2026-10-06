# yomail architecture

This document describes how yomail is built and why. It complements the product plan in [PLAN.md](PLAN.md) (French) and the operations guide in [DEPLOY_CPANEL.md](DEPLOY_CPANEL.md). The diagrams are generated from the repository sources; their JSON definitions live in [diagrams/src](diagrams/src) (see [Regenerating the diagrams](#regenerating-the-diagrams)).

## 1. Context and constraints

yomail is a webhook catcher: a user creates an endpoint identified by a server-generated UUID v4, sends HTTP requests to `https://yo.manitra.fr/<uuid>[/sub/path]`, and reads them live at `/inbox/<uuid>`.

Three constraints shape the architecture:

| Constraint                                                                                              | Consequence                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared cPanel hosting**: Node 22 under Phusion Passenger on Apache, MySQL, no root, no extra daemons. | One Node process tree per app, started by Passenger; no Redis, no message broker; background work runs through cPanel cron.              |
| **Passenger on Apache has no WebSocket upgrade** and may run several app processes.                     | Socket.IO runs over HTTP long-polling with sticky sessions, and live updates must work across processes without shared memory (see §4).  |
| **No authentication** by design: the UUID is the only secret.                                           | Every read, clear and delete is open to anyone who knows the id; bodies are treated as untrusted text and rendered defensively (see §6). |

## 2. System overview

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/system-dark.svg">
  <img alt="yomail system overview" src="diagrams/system-light.svg">
</picture>

### Runtime components

| Component                           | Location                                                                 | Responsibility                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache + Passenger                  | cPanel, `deploy/htaccess`                                                | Mounts the Nest app at the root of the subdomain, `PassengerStickySessions on`, security headers. The document root holds nothing but `.htaccess`.                                                                                            |
| `CaptureController`                 | `apps/api/src/capture`                                                   | `@All('/:uuid')` and `@All('/:uuid/*')`, excluded from the `/api` prefix. Validates the id, checks the endpoint, streams the body with a size cap, classifies and parses it, stores one `requests` row, answers `200 {ok, id}` with CORS `*`. |
| REST API                            | `apps/api/src/endpoints`, `apps/api/src/requests`, `apps/api/src/health` | `/api/endpoints`, `/api/endpoints/:id/requests`, `/api/health`. Lists never load bodies or headers; details compute `html_sanitized` on read.                                                                                                 |
| `LiveGateway` + `LiveEventsService` | `apps/api/src/live`                                                      | Socket.IO on `/api/socket.io`, one room per endpoint (`ep:<id>`), max 10 rooms per socket. The in-process event bus connects capture/delete/clear to the gateway.                                                                             |
| `ChangeDetector`                    | `apps/api/src/live`                                                      | Polls MySQL every 2 s for endpoints that have subscribers on this process, with a 1 s overlap, and delivers rows not emitted in the last 15 s.                                                                                                |
| `ServeStaticModule`                 | `apps/api/src/static`                                                    | Serves `apps/web/dist` when `WEB_DIST_DIR` is set: `assets/` immutable for a year, everything else `no-cache`, `GET *` fallback to `index.html` except under `/api`. Registered **last** in `AppModule`.                                      |
| `PurgeService`                      | `apps/api/src/purge`, `apps/api/src/cli/purge.ts`                        | Deletes expired requests in batches of 1000 and idle endpoints. Triggered hourly by the cPanel cron (`npm run purge`, source of truth) and by an in-process `@nestjs/schedule` job as backup.                                                 |
| React SPA                           | `apps/web`                                                               | `/` (create, open by id or URL, recent endpoints in `localStorage`), `/inbox/:uuid[/:rid]` (list + detail panel). `useLiveRequests` merges REST pages and socket events, deduped by id.                                                       |
| `@yomail/shared`                    | `packages/shared`                                                        | DTOs, Socket.IO event maps, `ENDPOINT_ID_REGEX`, `extractEndpointId()`. Dual ESM/CJS build because Nest compiles to CommonJS and Vite consumes ESM.                                                                                           |

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

1. **Validate** the UUID with `ENDPOINT_ID_REGEX`, then **check the endpoint exists**. Both happen before a single body byte is read; failure answers `404 {ok:false, error}` with CORS headers.
2. **Stream the body** through `raw-body.ts` up to `MAX_BODY_BYTES`. Above the limit the stream is aborted, `413` is returned and nothing is stored.
3. **Classify and parse** (`content.ts`): `content_kind` is one of `none | json | form | multipart | html | xml | text | binary`. Form bodies become `form_fields`; multipart text parts become `form_fields` while file parts are counted into `dropped_files` and discarded; binary bodies keep metadata only.
4. **Store** one `requests` row, update `endpoints.last_request_at`, and enforce `MAX_REQUESTS_PER_ENDPOINT` by deleting the oldest rows of that endpoint.
5. **Emit** `request:new` on the in-process bus. `LiveGateway` forwards it to room `ep:<id>` and tells `ChangeDetector` to remember the id.
6. **Reply** `200 {ok:true, id}`. `HEAD` gets `200` without a body; `OPTIONS` is captured like any other method, which is why the CORS middleware is only mounted outside capture paths.

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
                                   path             varchar(2048)
settings                           query_params     json NULL        [name, value][]
--------                           headers          json             [name, value][]
key             varchar(64) PK     client_ip        varchar(45) NULL
value           varchar(255)       content_type     varchar(255) NULL
                                   content_kind     enum(none,json,form,multipart,html,xml,text,binary)
                                   body             mediumtext NULL  (never for multipart/binary)
                                   form_fields      json NULL
                                   dropped_files    json NULL        [{field, filename, size}]
                                   size_bytes       int unsigned
                                   received_at      datetime(3)

indexes: idx_requests_endpoint_received (endpoint_id, received_at), idx_requests_received (received_at),
         idx_endpoints_last_request (last_request_at)
```

- **Retention is computed, never stored.** `expires_at = received_at + settings.retention_days` is derived at read time and at purge time, so changing the `retention_days` row (default `10`, seeded by a migration) applies immediately. An endpoint is idle, and purged, when `COALESCE(last_request_at, created_at)` is older than the cutoff.
- **Purge** runs raw `DELETE ... ORDER BY received_at LIMIT 1000` in a loop (TypeORM's `delete()` has no `LIMIT`), then deletes idle endpoints. A re-entrancy flag skips overlapping runs. The CLI entry (`dist/cli/purge.js`) boots its own `PurgeCliModule` with `createApplicationContext`, so no HTTP server and no scheduler run inside the cron.
- **Schema changes are migrations** (`synchronize: false`), listed explicitly in `migrations/index.ts` so ts-node and the compiled `dist/` share one list. Column names are snake_case, FK and index names are explicit, so `migration:generate` sees no spurious diff.
- **Lists never load `body`, `headers`, `form_fields`**: queries use explicit column lists (`SUMMARY_COLUMNS` / `DETAIL_COLUMNS` in `request.mapper.ts`). Lists are newest first, 50 per page (max 200), cursor `?before=<received_at>`.

## 6. Security model

There is no authentication: the UUID is the capability. What the system does defend against is hostile _content_.

- **Bodies are untrusted text.** Files and binary bodies are never persisted. HTML is sanitized **on read** (`html-sanitizer.ts`; `html_sanitized` is never stored) and rendered client-side only inside `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=...>` with an injected `Content-Security-Policy` meta that blocks scripts and, unless the user opts in, images. `allow-same-origin` is never added, so the document gets an opaque origin. `dangerouslySetInnerHTML` is not used outside that iframe. JSON is tokenized into React spans, never injected as HTML.
- **Capture replies are hand-written** (`@Res()`) so `404` and `413` carry the same CORS headers and `{ok, error}` body as success.
- **Every API response is `Cache-Control: no-store`**; CORS on `/api` is restricted to the configured origin (same origin in production).
- **Proxy awareness**: `TRUST_PROXY=1` in production so `client_ip` reflects `X-Forwarded-For`; the headers table in the UI dims proxy-added headers.
- **Input validation**: ids go through `ParseUUIDPipe` (`400`), dates through `ParseIsoDatePipe`, environment through a `zod` schema at boot.
- **Bounded resources**: body size cap, per-endpoint row cap, retention purge, max 10 rooms per socket, 16 KB Socket.IO buffer.

## 7. Front end

- React 18 + Vite + TypeScript + Tailwind + React Router. No global state manager: `lib/useAsync.ts` (fetch on mount, abort on unmount, `reload()`) plus local state.
- `api/client.ts` is the only module that calls `fetch`; it throws `ApiError` with the HTTP status so pages can special-case `400` / `404` (unknown endpoint page).
- `InboxPage` serves both `/inbox/:uuid` and `/inbox/:uuid/:rid`. On mobile the presence of `:rid` decides whether the list or the detail is visible; "Back to inbox" keeps the socket alive. Request details are cached per id for the life of the page.
- `RequestPanel` sections: details table, `HeadersTable` (copy all), query params, and one content viewer per `content_kind` (`JsonViewer`, `FormViewer`, `HtmlViewer` → `HtmlFrame`, `TextViewer`).
- `config.ts`: `API_URL` is `/api`; `PUBLIC_BASE_URL` is `window.location.origin` because the SPA and the capture routes share one origin. In development Vite proxies `/api` (with `ws: true`) and `/<uuid>...` to the API.

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

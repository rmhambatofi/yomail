# yomail

A small, self-hosted **webhook catcher** (think webhook.site) running at `https://yo.manitra.fr`.

Create an endpoint, point any HTTP client at `https://yo.manitra.fr/<uuid>[/any/sub/path]`, and watch the requests arrive live at `/inbox/<uuid>`: method, path, query string, headers, client IP and a parsed, safely rendered body (JSON, form, multipart, HTML, XML, text).

No accounts, no sign-up: the endpoint UUID is the only key. Anyone who knows it can read, clear or delete the endpoint. Requests are kept for a configurable number of days (10 by default) and then purged.

> Built to run on **shared cPanel hosting** (Node 22 under Passenger on Apache, MySQL, no root), which shapes several design choices described below.

## Features

- **Capture anything**: every method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`), any sub-path, any content type. Bodies up to 512 KB (configurable); larger bodies get a `413` and are not stored.
- **Live inbox**: new requests are pushed over Socket.IO; the UI falls back to REST polling when the socket is down and shows a `live | polling | offline` badge.
- **Safe rendering**: HTML bodies are sanitized on read and displayed only inside a sandboxed `<iframe>` with a strict CSP; JSON is pretty-printed as text; binary bodies and uploaded files are never stored.
- **Bounded storage**: at most 500 requests per endpoint (oldest dropped on insert), automatic retention purge, idle endpoints removed.
- **CORS-friendly**: capture URLs always answer with `Access-Control-Allow-Origin: *`, so browser-side code can call them directly.

## Architecture at a glance

The three diagrams below are generated from the repository sources (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full write-up and [docs/diagrams](docs/diagrams) for the diagram sources).

### System overview

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/system-dark.svg">
  <img alt="yomail system overview: webhook senders and the React SPA reach Apache + Passenger, which routes to the NestJS modules (REST API, CaptureController, LiveGateway, ChangeDetector, ServeStaticModule, PurgeService) backed by MySQL; a cPanel cron runs the purge CLI." src="docs/diagrams/system-light.svg">
</picture>

1. **Apache + Passenger** (cPanel) mount the NestJS app at the root of the subdomain. Passenger has no WebSocket support and may run several app processes, hence sticky sessions and the DB-polling design below.
2. **NestJS API** (`apps/api`): `CaptureController` stores incoming webhooks, the REST API under `/api` serves endpoints and requests, `LiveGateway` pushes Socket.IO events to one room per endpoint, `ChangeDetector` polls the database for rows captured by _other_ processes, `ServeStaticModule` serves the built SPA, `PurgeService` enforces retention.
3. **React SPA** (`apps/web`): home page (create / open / recent endpoints) and the inbox (request list + detail panel with viewers).
4. **MySQL** with three tables (`endpoints`, `requests`, `settings`) managed by TypeORM migrations.

### Capturing a webhook and delivering it live

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/capture-live-dark.svg">
  <img alt="Sequence: a sender posts to /uuid; Apache routes to a Passenger process; Capture checks the endpoint exists before reading the body, inserts the row, emits request:new on the in-process bus to LiveGateway which pushes it to the Inbox over long-polling, and replies 200. In another process, ChangeDetector polls MySQL every 2 seconds and delivers unseen rows to its own gateway; the client dedupes by id." src="docs/diagrams/capture-live-light.svg">
</picture>

- The UUID is validated and the endpoint existence is checked **before any body byte is read** (unknown endpoint → `404`).
- The capturing process pushes the event in memory; every other Passenger process learns about the row through a 2-second database poll. Both paths may deliver the same row, so the server remembers emitted ids for 15 s and the client dedupes by id.
- When the socket is unavailable the inbox polls the REST list every 5 s.

### Deployment to cPanel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/deploy-dark.svg">
  <img alt="Workflow: npm run build, runtime tarball (no src, no .env), extract to ~/yomail over ssh, merge .htaccess keeping the cPanel Passenger block, clean the v1 files from the docroot, npm ci --omit=dev, run migrations, touch tmp/restart.txt to restart Passenger." src="docs/diagrams/deploy-light.svg">
</picture>

`scripts/deploy.sh` builds locally, uploads only the runtime file set over `tar | ssh`, merges `deploy/htaccess` with the Passenger block cPanel owns, installs production dependencies, runs migrations and restarts Passenger. The step-by-step server setup is in [docs/DEPLOY_CPANEL.md](docs/DEPLOY_CPANEL.md).

## Quick start (development)

Prerequisites: Node 22 (`.nvmrc`), npm, Docker (for the local MySQL).

```sh
npm install
cp .env.example .env            # defaults match docker-compose (MySQL on host port 3307)
docker compose up -d            # MySQL 8.4, db/user/password: yomail
npm run migration:run -w apps/api
npm run dev                     # API on http://localhost:3000, web on http://localhost:5173
```

Then exercise it:

```sh
curl -s -X POST http://localhost:3000/api/endpoints
# {"id":"<uuid>","url":"http://localhost:5173/<uuid>","created_at":"..."}

curl -i -X POST "http://localhost:5173/<uuid>/orders?x=1" \
  -H 'Content-Type: application/json' -d '{"hello":"world"}'
# HTTP/1.1 200 OK ... {"ok":true,"id":"<request id>"}

curl -s "http://localhost:3000/api/endpoints/<uuid>/requests?limit=10"
```

Open `http://localhost:5173/inbox/<uuid>` to see the request appear live. The Vite dev server proxies `/api` (including the Socket.IO path) and `/<uuid>...` capture paths to the API.

Other useful commands:

| Command                                                                               | What it does                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run build`                                                                       | Builds `packages/shared`, then `apps/api`, then `apps/web`             |
| `npm run lint` / `npm run format` / `npm run typecheck`                               | ESLint 9, Prettier, per-workspace `tsc`                                |
| `npm run migration:generate -w apps/api -- src/database/migrations/<Name>`            | Diff entities vs DB (then register the class in `migrations/index.ts`) |
| `npm run purge` / `npm run purge:dry-run -w apps/api`                                 | Retention purge (used by the cPanel cron)                              |
| `CPANEL_SSH=user@host npm run deploy [-- --dry-run\|--skip-build\|--no-migrate]`      | Build + upload + migrate + restart on cPanel                           |
| `apps/api/test/requests/send-all.sh`, `rest-flow.sh`, `apps/api/test/live-client.cjs` | Manual acceptance scripts (v1 has no automated test suite)             |

## HTTP API

Capture URLs live at the root of the host; the management API lives under `/api` (prefix configurable with `API_PREFIX`).

| Method   | Path                                                     | Description                                                                                                                                              |
| -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANY`    | `/:uuid` and `/:uuid/*`                                  | Capture a request. `200 {ok, id}`, `404` unknown endpoint, `413` body too large. Always `Access-Control-Allow-Origin: *`. `HEAD` answers without a body. |
| `POST`   | `/api/endpoints`                                         | Create an endpoint (server-generated UUID v4)                                                                                                            |
| `GET`    | `/api/endpoints/:id`                                     | Endpoint detail with `request_count`, `last_request_at`, `retention_days`                                                                                |
| `DELETE` | `/api/endpoints/:id`                                     | Delete the endpoint and its requests (`204`)                                                                                                             |
| `GET`    | `/api/endpoints/:id/requests?limit=50&before=<ISO date>` | Newest first, 50 per page (max 200), cursor on `received_at`; never includes bodies or headers                                                           |
| `GET`    | `/api/endpoints/:id/requests/:rid`                       | Full request, with `html_sanitized` computed on read                                                                                                     |
| `DELETE` | `/api/endpoints/:id/requests/:rid`                       | Delete one request (`204`)                                                                                                                               |
| `DELETE` | `/api/endpoints/:id/requests`                            | Clear the inbox (`204`)                                                                                                                                  |
| `GET`    | `/api/health`                                            | `{status, db, retention_days, max_body_bytes}`                                                                                                           |

Socket.IO is served on `/api/socket.io`: emit `subscribe {endpointId}` (max 10 rooms per socket) and listen to `request:new`, `request:deleted`, `endpoint:cleared`, `endpoint:deleted`. DTOs and event maps are defined once in `packages/shared`.

## Configuration

All settings come from `apps/api/.env` (or the repo-root `.env` in development); see `.env.example`.

| Variable                                                  | Default                 | Purpose                                                          |
| --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `PORT`                                                    | `3000`                  | Listen port (ignored under Passenger)                            |
| `API_PREFIX`                                              | `api`                   | Prefix of the management API and Socket.IO path                  |
| `PUBLIC_BASE_URL`                                         | `http://localhost:5173` | Base of the capture URLs returned by the API                     |
| `WEB_DIST_DIR`                                            | _(empty)_               | Built SPA directory served by Nest (`../web/dist` in production) |
| `TRUST_PROXY`                                             | `0`                     | Set to `1` behind Apache so `req.ip` honours `X-Forwarded-For`   |
| `CORS_ORIGIN`                                             | _(unset)_               | Allowed origin(s) for `/api` (dev: `http://localhost:5173`)      |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `localhost`, `3306`, …  | MySQL connection                                                 |
| `MAX_BODY_BYTES`                                          | `524288`                | Capture body limit (`413` above)                                 |
| `MAX_REQUESTS_PER_ENDPOINT`                               | `500`                   | Oldest rows dropped beyond this                                  |
| `RETENTION_DAYS_DEFAULT`                                  | `10`                    | Used when the `settings` table has no `retention_days` row       |

Retention is **computed, never stored**: changing `retention_days` in the `settings` table applies immediately to every row.

## Repository layout

```
apps/api/          NestJS 10 + TypeORM + MySQL (capture, endpoints, requests, live, purge, static)
apps/web/          React 18 + Vite + Tailwind + React Router (+ socket.io-client)
packages/shared/   DTOs, Socket.IO event maps, endpoint id helpers (dual ESM/CJS build)
deploy/htaccess    Rules merged into the cPanel document root
scripts/deploy.sh  Build + tar-over-ssh deploy to cPanel
docs/              PLAN.md (product plan, French), ARCHITECTURE.md, DEPLOY_CPANEL.md, diagrams/
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, request lifecycle, real-time design, data model, security model, invariants.
- [docs/DEPLOY_CPANEL.md](docs/DEPLOY_CPANEL.md): server prerequisites, first deploy, acceptance checklist.
- [docs/PLAN.md](docs/PLAN.md) (French): scope, API contract and acceptance criteria that drove the implementation.
- [CLAUDE.md](CLAUDE.md): working notes and gotchas for contributors (and AI assistants).

## Scope and non-goals

v1 deliberately leaves out authentication, configurable responses, search, replay, export, notes, geo-IP, rate limiting, automated tests and CI. Manual acceptance scripts in `apps/api/test` replace a test suite for now.

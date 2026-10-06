# Deploying yomail (webhook catcher) to cPanel (shared hosting, no root)

Target layout on the server (`~` is the cPanel account home):

```
~/yomail/                        # runtime files uploaded by scripts/deploy.sh
  package.json, package-lock.json, .nvmrc
  node_modules/                  # created on the server by `npm ci --omit=dev` at this root
  packages/shared/dist/
  apps/api/dist/                 # Passenger app root = ~/yomail/apps/api, startup file dist/main.js
  apps/api/.env                  # the ONLY config source on the server (chmod 600)
  apps/web/dist/                 # built SPA, served by Nest (WEB_DIST_DIR=../web/dist)
~/yo.manitra.fr/                 # document root of the subdomain: holds .htaccess and nothing else
~/nodevenv/yomail/apps/api/22/   # created by "Setup Node.js App"
~/logs/yomail-purge.log
```

One Passenger application mounted at the **root** of `yo.manitra.fr` handles everything: the SPA
(`/`, `/inbox/...`, `/assets/...`), the API (`/api/...`), the Socket.IO endpoint (`/api/socket.io/`)
and the capture URLs (`/<uuid>[/sub/path]`).

Everything below is a one-time setup except step 5, which is the repeatable deploy.

## 1. Prerequisites (already in place for yo.manitra.fr)

- Subdomain `yo.manitra.fr` with its own document root and a valid TLS certificate.
- SSH access with **key authentication** (the deploy script uses `tar | ssh` in batch mode and opens
  several connections). One-time setup from your machine:

  ```powershell
  ssh-keygen -t ed25519 -C "yomail deploy"     # accept the default path, choose a passphrase or leave empty
  Get-Content ~/.ssh/id_ed25519.pub            # copy this single line
  ```

  Then cPanel → _Sécurité_ → _Accès SSH_ → _Gérer les clés SSH_ → _Importer la clé_: paste the public
  key under _Clé publique_, name it, _Importer_. Back on the list, _Gérer_ next to the key →
  _Autoriser_. Test with `ssh user@host 'echo ok'`; it must print `ok` without asking for a password.
  If you prefer passwords, run the deploy with `SSH_BATCH=0` and expect roughly eight prompts.

- MySQL database and user created in cPanel (_MySQL Databases_). The v1 database can be reused:
  the migration drops the `emails` table and creates `endpoints` / `requests`.

## 2. Node.js application (Passenger) at the subdomain root

The v1 application was mounted at `yo.manitra.fr/api`. **It must be re-created at the root**:
cPanel → _Setup Node.js App_ → open the existing `yomail/apps/api` app → _Destroy_ (or edit its
_Application URL_ if the UI allows an empty path), then _Create application_:

| Field                    | Value                       |
| ------------------------ | --------------------------- |
| Node.js version          | 22                          |
| Application mode         | Production                  |
| Application root         | `yomail/apps/api`           |
| Application URL          | `yo.manitra.fr` / _(empty)_ |
| Application startup file | `dist/main.js`              |

Do **not** add environment variables in this UI and do **not** use its _Run NPM Install_ button:

- The CLI jobs (purge cron, migrations) do not see Passenger's UI variables, so all configuration
  lives in `apps/api/.env` instead. The app reads it from its working directory.
- `apps/api` depends on the workspace package `@yomail/shared`; installing inside `apps/api` alone
  fails. The deploy script runs `npm ci --omit=dev` at the monorepo root, where npm resolves the
  workspace link.

After creating the app, cPanel writes a Passenger block into `~/yo.manitra.fr/.htaccess` with
`PassengerBaseURI "/"`. Leave it there; the deploy script preserves it and appends `deploy/htaccess`
(`PassengerStickySessions on` + security headers). The v1 SPA files that may still sit in the
document root (`index.html`, `assets/`) are removed by the deploy script: Apache would serve them
before handing the request to Node.

## 3. Server configuration file

```sh
ssh user@host
mkdir -p ~/yomail/apps/api ~/logs
```

`~/yomail/apps/api/.env` (start from `.env.example` in the repo), `chmod 600`:

```
NODE_ENV=production
API_PREFIX=api
PUBLIC_BASE_URL=https://yo.manitra.fr
WEB_DIST_DIR=../web/dist
TRUST_PROXY=1
DB_HOST=localhost
DB_PORT=3306
DB_USER=<cpanel_user>_yomail
DB_PASSWORD=...
DB_NAME=<cpanel_user>_yomail
MAX_BODY_BYTES=524288
MAX_REQUESTS_PER_ENDPOINT=500
RETENTION_DAYS_DEFAULT=10
CORS_ORIGIN=https://yo.manitra.fr
```

The v1 keys `MAIL_DOMAIN`, `INGEST_SECRET`, `MAX_EMAIL_BYTES` are ignored and can be removed.
`~/yomail/apps/ingest/` (the Exim pipe script) is no longer uploaded and can be deleted.

## 4. Mail: undo the v1 pipe

cPanel → _Email_ → _Default Address_ → `yo.manitra.fr`: switch back from _Pipe to a Program_ to
_Discard with error to sender_ (or whatever the account used before). Nothing in v2 receives mail.

## 5. Deploy

From your machine (Git Bash on Windows works):

```sh
CPANEL_SSH=user@host npm run deploy
```

The script builds (shared, api, web), uploads the runtime file set including `apps/web/dist` to
`~/yomail`, merges `.htaccess` in the document root, removes v1 SPA leftovers there, runs
`npm ci --omit=dev`, runs the migrations (`npm run migration:run:prod`, which uses
`dist/database/data-source.js` and reads `apps/api/.env`), and touches `apps/api/tmp/restart.txt` so
Passenger reloads.

Options: `--dry-run` (build and list files only), `--skip-build`, `--no-migrate`. Overrides:
`CPANEL_PORT`, `REMOTE_APP_DIR` (default `yomail`), `REMOTE_DOCROOT` (default `yo.manitra.fr`);
both relative to the remote home, `REMOTE_NODE`.

### Check the API prefix

Whether the app sees the `/api` part of the path depends on the Passenger/Apache setup, so verify
once after the first deploy:

```sh
curl -s https://yo.manitra.fr/api/health
```

| Result                                                               | Meaning                                                                    | Fix                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `{"status":"ok",...}`                                                | the app sees the full path; `API_PREFIX=api` is right                      | nothing                                                                                                         |
| 404 from Nest, but `curl https://yo.manitra.fr/api/api/health` works | the mount strips `/api` (should not happen with a root mount)              | set `API_PREFIX=` (empty) in `apps/api/.env`, `touch apps/api/tmp/restart.txt`; Socket.IO moves to `/socket.io` |
| Apache 404 / HTML error page                                         | the Passenger block is missing from `.htaccess` or the app failed to start | _Setup Node.js App_ → check the app is running; see `~/yomail/apps/api/stderr.log`                              |

The front-end always calls `/api/...` and `/api/socket.io/`, so the public URL must stay
`https://yo.manitra.fr/api` (the SPA and the API share one origin; `CORS_ORIGIN` only matters for
tools calling the API from elsewhere).

## 6. Acceptance

1. `curl -s https://yo.manitra.fr/api/health` returns `"db":"ok"`.
2. `curl -sI https://yo.manitra.fr/` returns `200` with `content-type: text/html` and
   `cache-control: no-cache`; `curl -sI https://yo.manitra.fr/inbox/test` also returns the SPA (deep
   link). `curl -s https://yo.manitra.fr/api/nope` returns a JSON 404, not `index.html`.
3. `curl -sI https://yo.manitra.fr/assets/<name from index.html>.js` returns
   `cache-control: public, max-age=31536000, immutable`.
4. `curl -s 'https://yo.manitra.fr/api/socket.io/?EIO=4&transport=polling'` returns a body starting
   with `0{"sid"`.
5. Open `https://yo.manitra.fr/`, click **Create endpoint**, copy the URL and send a POST from Postman
   (JSON body). It appears in the inbox without refreshing; the badge shows **Live**.
6. In the request details, **Client IP** must be your public address, not `127.0.0.1` or the
   server's. If it is wrong, look at the headers table: with an `x-forwarded-for` header present,
   `TRUST_PROXY=1` is right; without it, Passenger passes the real address itself, so set
   `TRUST_PROXY=0`.
7. Browser devtools → Network: the Socket.IO requests use `transport=polling` (expected under
   Apache; the websocket upgrade is refused and that is fine). Open the same inbox in a second tab:
   both must stay **Live** and receive the same request. If one tab shows **Polling** with repeated
   `400 Session ID unknown` responses, Passenger is running several processes without session
   affinity: check that the `PassengerStickySessions on` line survived in `.htaccess`. The inbox
   still updates every 5 s in that state (REST polling fallback).
8. Wait for the next full hour and check `~/logs/yomail-purge.log` has a line.

## 7. Purge cron and retention

cPanel → _Cron Jobs_, every hour (unchanged from v1):

```
0 * * * * cd ~/yomail/apps/api && ~/nodevenv/yomail/apps/api/22/bin/node dist/cli/purge.js --quiet >> ~/logs/yomail-purge.log 2>&1
```

Drop `--quiet` to log one line per run. The in-process hourly job inside the API is only a backup,
since Passenger may put the app to sleep. The purge deletes expired requests, then endpoints idle
for longer than the retention.

Change the retention without redeploying:

```sql
UPDATE settings SET value='30' WHERE `key`='retention_days';
```

It applies to every request at once (expiry is computed, never stored). The API caches the value for
60 s.

## Troubleshooting

| Symptom                                           | Where to look                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://yo.manitra.fr/` shows the old mailbox UI | v1 `index.html` still in the document root (Apache serves existing files first): re-run the deploy or `rm -rf ~/yo.manitra.fr/index.html ~/yo.manitra.fr/assets`                       |
| `/inbox/<uuid>` gives Apache 404                  | the Passenger block in `.htaccess` is missing or still mounts `/api` (`PassengerBaseURI "/api"`): re-create the app at the root (§2)                                                   |
| Capture URL answers with the SPA instead of JSON  | the id is not a valid UUID v4 (anything else falls through to the SPA fallback)                                                                                                        |
| App starts then dies                              | `~/yomail/apps/api/stderr.log`; a missing `.env` key fails validation at boot with the key name; `WEB_DIST_DIR` pointing to a missing folder fails on the first static request         |
| Badge stuck on **Polling**                        | `curl 'https://yo.manitra.fr/api/socket.io/?EIO=4&transport=polling'`; a 404 means the path is wrong (prefix), an HTML page means Apache intercepted it; see §6 point 7 for stickiness |
| Client IP always the same wrong value             | `TRUST_PROXY` (§6 point 6)                                                                                                                                                             |
| 413 on captures smaller than 512 KB               | `MAX_BODY_BYTES` in `.env`; also any Apache `LimitRequestBody` set by the host                                                                                                         |
| Old front-end after deploy                        | `index.html` is served with `no-cache`; hard-refresh once if a CDN sits in front                                                                                                       |

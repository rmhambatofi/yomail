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
# accounts (phase 7); the TTL/rate keys are optional, see .env.example for defaults.
# NODE_ENV=production is what switches emails to SMTP (elsewhere they stay in /devmailcatcher,
# which remains reachable by admins in production as a mail sink for other applications).
UNCONFIRMED_USER_TTL_DAYS=7
SMTP_HOST=mail.manitra.fr
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=no-reply@manitra.fr
SMTP_PASSWORD=...
MAIL_FROM="yomail <no-reply@manitra.fr>"
# member features (phase 8); all optional, defaults shown. Keep REPLAY_ALLOW_PRIVATE unset here.
MAX_REQUESTS_PER_ENDPOINT_MEMBERS=2000
RETENTION_DAYS_MEMBERS_DEFAULT=30
REPLAY_TIMEOUT_MS=10000
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
8. Wait for the next full hour and check `~/logs/yomail-purge.log` has a line; since phase 7 it also
   reports expired sessions, stale tokens and unconfirmed accounts.
9. Accounts: click **Sign in / Sign up** → **Create an account** with a real mailbox (Gmail). The
   confirmation email must arrive outside spam within a minute; its button opens
   `https://yo.manitra.fr/confirm/<token>`, which shows "Your account is active" with your username in
   the header. Open a second tab on `/account`: still signed in (the session lives in the database, so
   it does not depend on which Passenger process answers). `curl -sI` of a sign-in response must show
   the cookie with `HttpOnly; Secure; SameSite=Lax`.
10. Sign in with the admin created in §8; `/account` shows the `ADMIN` badge and an
    **Administration** section whose **Open the dev mail catcher** button opens
    `https://yo.manitra.fr/devmailcatcher` (`200`, empty list; `401` in a private window). Push a
    message with the admin cookie (`POST /devmailcatcher/messages.json`, body
    `{"to":"x@example.test","subject":"Test","text":"hello"}`) -> `201`, and it shows up in the list
    whatever Passenger process answers (the table `caught_mails` is shared).
11. Member features (signed in): **Create endpoint** from the home page, then **Edit** in the inbox →
    set a name and a custom response (status `201`, body `{"received":true}`), save. The header
    shows the name and the **Custom response** badge, the home page lists the endpoint under
    **My endpoints**, and `curl -i https://yo.manitra.fr/<uuid>` returns `201`, the body,
    `content-security-policy: sandbox`, `x-content-type-options: nosniff` and
    `access-control-allow-origin: *`. **Reset to default** restores `200 {"ok":true,...}`.
12. Replay: create a second endpoint, open a request of the first one, **Replay** it to
    `https://yo.manitra.fr/<second uuid>`: the panel shows the target's `200` and the request
    appears in the second inbox with its original method, body and headers (no `x-forwarded-*`).
    `http://127.0.0.1/` or `http://localhost/` as target must be refused with
    "address not allowed" (the check runs on the server, `REPLAY_ALLOW_PRIVATE` must not be set).
13. Privacy: open the inbox URL of the endpoint created in point 11 in a private window (no
    session): the page must say "This endpoint is private" with a **Sign in** button and show no
    request, no name; `curl -s https://yo.manitra.fr/api/endpoints/<uuid>/requests` returns
    `401 {"code":"UNAUTHENTICATED"}`. Sending a request to the URL still answers `201` (capture
    stays open).
14. Limits: the inbox of an owned endpoint says "kept 30 days, up to 2,000 per endpoint (member
    limits)"; an endpoint created while signed out says 10 days / 500. `/api/health` returns both
    `retention_days` and `retention_days_members`.

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
60 s. Endpoints owned by a member use `retention_days_members` (30 by default) instead; their cap is
`MAX_REQUESTS_PER_ENDPOINT_MEMBERS` in `.env`. The purge applies both retentions on every run.

## 8. Accounts: mailbox and admin user

Account emails (confirmation, password reset) go out through the SMTP server of a cPanel mailbox.

1. cPanel → _Email Accounts_ → _Create_: `no-reply@manitra.fr`, a strong password, minimal quota.
   _Connect Devices_ on that mailbox shows the outgoing server and port (typically the server
   hostname or `mail.manitra.fr`, port `465` SSL/TLS, username = the full address). Put them in
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE=1`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` (§3).
2. cPanel → _Email Deliverability_ → `manitra.fr`: SPF and DKIM must be valid, or Gmail will file
   the emails as spam. The hourly sending quota of the shared host is far above what account
   emails need.
3. Restart the app (`touch ~/yomail/apps/api/tmp/restart.txt`), then sign up with a real address.
   The app refuses to start in production without `SMTP_HOST` (the key is named in
   `stderr.log`). There is no console fallback in production: outside production the messages
   are caught at `/devmailcatcher` (readable by admins only, from the account page) instead of
   being sent, which is how the local tests run. In production `/devmailcatcher` still exists
   (admins only) but holds only what other applications push to it with
   `POST /devmailcatcher/messages.json`; yomail's own emails never land there.
4. Create the first admin from the shell (the API has no route for that). The password is read from
   `YOMAIL_USER_PASSWORD` or prompted (hidden) when running interactively:

   ```sh
   ssh user@host
   cd ~/yomail/apps/api && YOMAIL_USER_PASSWORD='...' ~/nodevenv/yomail/apps/api/22/bin/node dist/cli/user.js create-admin --username admin --email you@example.com
   ```

   The account is created `ENABLED` with the `ADMIN` role; no email is sent. Exit code 1 and a
   message if the username or email is taken.

The purge cron (§7) also removes expired sessions, used or expired email tokens and accounts never
confirmed within `UNCONFIRMED_USER_TTL_DAYS` (7 days).

## Troubleshooting

| Symptom                                           | Where to look                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://yo.manitra.fr/` shows the old mailbox UI | v1 `index.html` still in the document root (Apache serves existing files first): re-run the deploy or `rm -rf ~/yo.manitra.fr/index.html ~/yo.manitra.fr/assets`                                                                |
| `/inbox/<uuid>` gives Apache 404                  | the Passenger block in `.htaccess` is missing or still mounts `/api` (`PassengerBaseURI "/api"`): re-create the app at the root (§2)                                                                                            |
| Capture URL answers with the SPA instead of JSON  | the id is not a valid UUID v4 (anything else falls through to the SPA fallback)                                                                                                                                                 |
| App starts then dies                              | `~/yomail/apps/api/stderr.log`; a missing `.env` key fails validation at boot with the key name; `WEB_DIST_DIR` pointing to a missing folder fails on the first static request                                                  |
| Badge stuck on **Polling**                        | `curl 'https://yo.manitra.fr/api/socket.io/?EIO=4&transport=polling'`; a 404 means the path is wrong (prefix), an HTML page means Apache intercepted it; see §6 point 7 for stickiness                                          |
| Client IP always the same wrong value             | `TRUST_PROXY` (§6 point 6)                                                                                                                                                                                                      |
| 413 on captures smaller than 512 KB               | `MAX_BODY_BYTES` in `.env`; also any Apache `LimitRequestBody` set by the host                                                                                                                                                  |
| Old front-end after deploy                        | `index.html` is served with `no-cache`; hard-refresh once if a CDN sits in front                                                                                                                                                |
| Confirmation email never arrives                  | `~/yomail/apps/api/stderr.log`: `MailService` logs `sent ...` or the SMTP error; check `SMTP_*` (§8), then the spam folder and _Email Deliverability_ (SPF/DKIM). The user can hit **Resend**                                   |
| Replay answers `400` "address not allowed"        | The target resolves to a private, loopback or link-local address: expected (SSRF guard). Only public `http(s)` hosts can be replayed; a hostname that resolves to nothing gives `502 REPLAY_FAILED`                             |
| Inbox says "This endpoint is private"             | Expected: a member owns the endpoint and the browser has no session of that member. Sign in as the owner; an endpoint created while signed out is readable by anyone who knows its id                                           |
| Custom response not applied                       | Only the owner's configuration counts: `GET /api/endpoints/<uuid>` with the session cookie must show `custom_response: true`; `404` and `413` are never customised; check the `delay_ms` (the sender waits, the inbox does not) |
| Signed out when switching tabs                    | Should not happen (sessions are in MySQL). If it does, the cookie is missing `Secure`/`HttpOnly` or `NODE_ENV` is not `production`; check `curl -sI` of a sign-in response                                                      |

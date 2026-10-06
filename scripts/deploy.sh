#!/usr/bin/env bash
# Build locally and deploy yomail to a cPanel account over SSH.
#
# Usage:
#   CPANEL_SSH=user@host [CPANEL_PORT=22] scripts/deploy.sh [--dry-run] [--skip-build] [--no-migrate]
#
# Optional overrides (defaults match docs/DEPLOY_CPANEL.md):
#   REMOTE_APP_DIR   = apps/yomail                       (relative to the remote $HOME)
#   REMOTE_DOCROOT   = yo.manitra.fr                     (document root of the subdomain: holds only .htaccess)
#   REMOTE_NODE      = auto-detected ~/nodevenv/$REMOTE_APP_DIR/apps/api/<ver>/bin/node on the server
#   SSH_BATCH        = 1 (key auth only, default) or 0 (allow password prompts)
#
# What it does:
#   1. npm run build (shared, api, web)
#   2. tar + ssh the runtime file set to $REMOTE_APP_DIR (no src, no node_modules, no .env)
#   3. merge deploy/htaccess into $REMOTE_DOCROOT/.htaccess, keeping the Passenger block cPanel put there
#      (the SPA itself is uploaded with the app in step 2 and served by Nest from apps/web/dist)
#   4. remote: remove v1 SPA leftovers from the docroot (Apache would serve them before Passenger),
#      npm ci --omit=dev at the monorepo root, run migrations, restart Passenger
# Requires: bash, tar, ssh locally (Git Bash on Windows is fine). No rsync needed.


set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0; SKIP_BUILD=0; MIGRATE=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-migrate) MIGRATE=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

: "${CPANEL_SSH:?set CPANEL_SSH=user@host}"
CPANEL_PORT="${CPANEL_PORT:-22}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-yomail}"
REMOTE_DOCROOT="${REMOTE_DOCROOT:-yo.manitra.fr}"
# SSH_BATCH=1 (default) refuses password prompts, so key auth must be set up (see docs/DEPLOY_CPANEL.md §1).
# SSH_BATCH=0 allows password prompts; expect to type it about eight times per deploy.
SSH=(ssh -p "$CPANEL_PORT" -o "BatchMode=$([ "${SSH_BATCH:-1}" = 1 ] && echo yes || echo no)" "$CPANEL_SSH")

log() { printf '\n==> %s\n' "$*"; }

# ---- 1. build -------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  log "Building (shared, api, web)"
  npm run build
fi
for f in packages/shared/dist/index.cjs apps/api/dist/main.js apps/api/dist/cli/purge.js apps/web/dist/index.html; do
  [ -f "$f" ] || { echo "missing build output: $f" >&2; exit 1; }
done

# ---- 2. runtime file set --------------------------------------------------
APP_FILES=(
  package.json package-lock.json .nvmrc
  packages/shared/package.json packages/shared/dist
  apps/api/package.json apps/api/dist
  apps/web/package.json apps/web/dist
  .env.example
)
log "Runtime files"
printf '  %s\n' "${APP_FILES[@]}"

if [ "$DRY_RUN" = 1 ]; then
  log "Dry run: would upload to $CPANEL_SSH:~/$REMOTE_APP_DIR and .htaccess to ~/$REMOTE_DOCROOT"
  tar -czf - "${APP_FILES[@]}" | wc -c | sed 's/^/  app tarball bytes: /'
  exit 0
fi

log "Uploading app to ~/$REMOTE_APP_DIR"
"${SSH[@]}" "mkdir -p ~/$REMOTE_APP_DIR && cd ~/$REMOTE_APP_DIR && rm -rf packages/shared/dist apps/api/dist apps/web/dist"
tar -czf - "${APP_FILES[@]}" | "${SSH[@]}" "tar -xzf - -C ~/$REMOTE_APP_DIR"

# ---- 3. .htaccess merge ---------------------------------------------------
log "Updating ~/$REMOTE_DOCROOT/.htaccess"
"${SSH[@]}" "mkdir -p ~/$REMOTE_DOCROOT && cat > ~/$REMOTE_DOCROOT/.htaccess.yomail" < deploy/htaccess
"${SSH[@]}" bash -s "$REMOTE_DOCROOT" <<'REMOTE'
set -e
cd ~/"$1"
# Marker lines are matched anchored at the start of the line: a comment quoting them must not count.
BEGIN_RE='^# DO NOT REMOVE[.] CLOUDLINUX PASSENGER CONFIGURATION BEGIN'
END_RE='^# DO NOT REMOVE[.] CLOUDLINUX PASSENGER CONFIGURATION END'
if [ -f .htaccess ] && grep -qE "$BEGIN_RE" .htaccess; then
  # Keep cPanel's Passenger block (it mounts the app), replace everything else with ours.
  # Only the LAST block is kept: cPanel rewrites its block when the app is re-created.
  awk -v b="$BEGIN_RE" -v e="$END_RE" '$0 ~ b {p=1; blk=""} p {blk = blk $0 RS} $0 ~ e {p=0; last=blk} END {printf "%s", last}' .htaccess > .htaccess.passenger
  { cat .htaccess.passenger; echo; cat .htaccess.yomail; } > .htaccess.new
  rm -f .htaccess.passenger
else
  cp .htaccess.yomail .htaccess.new
fi
mv .htaccess.new .htaccess
rm -f .htaccess.yomail
echo "  .htaccess updated ($(grep -c . .htaccess) lines)"
# v1 served the SPA from the docroot. With Passenger mounted at the root, Apache still serves
# files that exist in the docroot before handing over to Node, so they must go.
if [ -f index.html ] || [ -d assets ]; then rm -rf index.html assets; echo "  removed v1 SPA files from the docroot"; fi
# cPanel created an empty "api" directory for the v1 mount at /api; drop it if still empty.
[ -d api ] && rmdir api 2>/dev/null && echo "  removed empty v1 api/ directory"
REMOTE

# ---- 4. install, migrate, restart ----------------------------------------
log "Installing production dependencies and restarting"
"${SSH[@]}" bash -s "$REMOTE_APP_DIR" "$MIGRATE" "${REMOTE_NODE:-}" <<'REMOTE'
set -e
APP="$HOME/$1"; MIGRATE="$2"; NODE_BIN="$3"
if [ -z "$NODE_BIN" ]; then
  # cPanel: ~/nodevenv/<application root>/<node major>/bin/node
  for c in "$HOME/nodevenv/$1/apps/api"/*/bin/node "$HOME"/nodevenv/*/*/*/*/bin/node "$HOME"/nodevenv/*/*/*/*/*/bin/node "$HOME"/nodevenv/*/*/bin/node; do [ -x "$c" ] && NODE_BIN="$c" && break; done
fi
[ -x "$NODE_BIN" ] || { echo "node binary not found under ~/nodevenv. Create the app in cPanel > Setup Node.js App (application root: $1/apps/api) or set REMOTE_NODE" >&2; ls -d "$HOME"/nodevenv/* 2>/dev/null | sed "s#^#  found: #" >&2; exit 1; }
NPM="$(dirname "$NODE_BIN")/npm"
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "  node: $("$NODE_BIN" --version) at $NODE_BIN"
cd "$APP"
"$NPM" ci --omit=dev --no-audit --no-fund 2>&1 | tail -n 2
[ -f apps/api/.env ] || echo "  WARNING: apps/api/.env is missing; copy .env.example and fill it in"
if [ "$MIGRATE" = 1 ] && [ -f apps/api/.env ]; then
  (cd apps/api && "$NPM" run migration:run:prod 2>&1 | grep -E 'executed|No migrations|rror' || true)
fi
mkdir -p apps/api/tmp && touch apps/api/tmp/restart.txt
echo "  Passenger restart requested (tmp/restart.txt)"
REMOTE

log "Done. Check: curl -s https://yo.manitra.fr/api/health ; curl -sI https://yo.manitra.fr/ | head -1 ; see docs/DEPLOY_CPANEL.md §6"

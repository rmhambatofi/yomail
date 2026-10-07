#!/usr/bin/env bash
# Manual acceptance test for the accounts API (docs/PLAN.md, Phase 7.3).
#
# Usage: apps/api/test/auth/auth-flow.sh [BASE_URL]      (default http://localhost:3000)
# The API must run outside production (NODE_ENV != production): emails are then caught by the
# built-in dev mail catcher and the links are read back from BASE_URL/devmailcatcher/messages.json
# (admin-only: a throwaway admin is created with dist/cli/user.js, so build apps/api first). Exits 1 when any check fails. Creates throwaway accounts named
# flow_<random>; the rate limit (AUTH_RATE_LIMIT) must be >= 10 for the 429 check to be exact.
set -u
BASE="${1:-http://localhost:3000}"
CATCHER="$BASE/devmailcatcher"
API="$BASE/api"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()   { printf 'PASS  %s\n' "$1"; }
ko()   { printf 'FAIL  %s%s\n' "$1" "${2:+ ($2)}"; fail=1; }
json() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(eval(process.argv[1]))" "$1"; }
# post NAME JAR BODY [extra curl args]  -> prints status, body in $TMP/body
post() { local jar="$1" body="$2"; shift 2; curl -s -o "$TMP/body" -w '%{http_code}' -b "$jar" -c "$jar" -H 'Content-Type: application/json' --data "$body" "$@"; }
get()  { local jar="$1"; shift; curl -s -o "$TMP/body" -w '%{http_code}' -b "$jar" -c "$jar" "$@"; }
expect() { local name="$1" want="$2" got="$3"; [ "$got" = "$want" ] && ok "$name -> $got" || { ko "$name" "got $got, expected $want: $(head -c 300 "$TMP/body")"; }; }
code_is() { [ "$(json 'j.code')" = "$1" ] < "$TMP/body"; }
expect_code_field() { local name="$1" want="$2"; local got; got=$(json 'j.code' < "$TMP/body"); [ "$got" = "$want" ] && ok "$name code=$got" || ko "$name" "code $got, expected $want"; }

# Dev mail catcher helper: the link containing /<segment>/ in the newest message sent to an address.
# The segment is passed without slashes: Git Bash (MSYS) would rewrite "/confirm/" into a Windows path.
mail_link() { # mail_link <to> <confirm|reset-password>
  curl -s -b "$JADMIN" --get --data-urlencode "to=$1" "$CATCHER/messages.json" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const seg='/'+process.argv[1]+'/';const l=(j[0]?.links||[]).find(u=>u.includes(seg));console.log(l||'')" "$2"
}
token_of() { echo "$1" | sed -E 's#.*/##'; }

RAND=$(node -e "console.log(Math.random().toString(36).slice(2,8))")
USER="flow_$RAND"
EMAIL="$USER@example.test"
PASS="correct horse $RAND"
JAR="$TMP/a.jar"; JAR2="$TMP/b.jar"; ANON="$TMP/anon.jar"

echo "== admin for the dev mail catcher =="
# The dev mail catcher is admin-only: create a throwaway admin with the CLI (same .env as the API,
# needs apps/api built) and sign it in; its session reads the confirmation / reset links.
ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
ARAND=$(node -e "console.log(Math.random().toString(36).slice(2,8))")
ADMIN="adm_$ARAND"; ADMIN_PASS="correct horse $ADMIN"; JADMIN="$TMP/admin.jar"
(cd "$ROOT_DIR" && node apps/api/dist/cli/user.js create-admin --username "$ADMIN" --email "$ADMIN@example.test" --password "$ADMIN_PASS" >/dev/null) || { ko "create admin with the CLI (run npm run build -w apps/api first)"; echo ABORT; exit 1; }
[ "$(post "$JADMIN" "{\"identifier\":\"$ADMIN\",\"password\":\"$ADMIN_PASS\"}" "$API/auth/login")" = 200 ] && ok "admin $ADMIN created by the CLI and signed in" || { ko "admin login" "$(cat "$TMP/body")"; echo ABORT; exit 1; }

echo "== sign-up =="
expect "signup" 201 "$(post "$JAR" "{\"username\":\"$USER\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/signup")"
expect "signup same email" 409 "$(post "$JAR" "{\"username\":\"${USER}x\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/signup")"; expect_code_field "signup same email" EMAIL_TAKEN
expect "signup same username other case" 409 "$(post "$JAR" "{\"username\":\"$(echo "$USER" | tr a-z A-Z)\",\"email\":\"other-$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/signup")"; expect_code_field "signup same username" USERNAME_TAKEN
expect "signup bad username" 400 "$(post "$JAR" "{\"username\":\"a b\",\"email\":\"x-$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/signup")"; expect_code_field "signup bad username" VALIDATION
expect "signup short password" 400 "$(post "$JAR" "{\"username\":\"ok_$RAND\",\"email\":\"x-$EMAIL\",\"password\":\"short\"}" "$API/auth/signup")"
[ "$(json 'j.fields.password' < "$TMP/body")" != "undefined" ] && ok "validation names the field" || ko "validation fields" "$(cat "$TMP/body")"
expect "signup non-JSON body" 400 "$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'Content-Type: text/plain' --data 'x' "$API/auth/signup")"
expect "signup body > 16kb" 413 "$(node -e "process.stdout.write(JSON.stringify({username:'a'.repeat(20000)}))" | curl -s -o "$TMP/body" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- "$API/auth/signup")"

echo "== before confirmation =="
expect "login before confirmation" 403 "$(post "$JAR" "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/login")"; expect_code_field "login before confirmation" ACCOUNT_DISABLED
expect "me without session" 401 "$(get "$ANON" "$API/auth/me")"
expect "resend confirmation" 200 "$(post "$JAR" "{\"email\":\"$EMAIL\"}" "$API/auth/resend-confirmation")"
expect "resend unknown email" 200 "$(post "$JAR" "{\"email\":\"nobody-$RAND@example.test\"}" "$API/auth/resend-confirmation")"

echo "== confirmation =="
sleep 1
LINK=$(mail_link "$EMAIL" confirm)
[ -n "$LINK" ] && ok "confirmation link found in the dev mail catcher" || { ko "confirmation link" "no mail for $EMAIL at $CATCHER"; echo "ABORT"; exit 1; }
TOKEN=$(token_of "$LINK")
expect "confirm" 200 "$(post "$JAR" "{\"token\":\"$TOKEN\"}" "$API/auth/confirm")"
[ "$(json 'j.status' < "$TMP/body")" = ENABLED ] && ok "confirm returns ENABLED profile" || ko "confirm profile" "$(cat "$TMP/body")"
grep -q "yomail_session" "$JAR" && ok "confirm sets the session cookie" || ko "confirm cookie"
expect "confirm replayed token" 400 "$(post "$ANON" "{\"token\":\"$TOKEN\"}" "$API/auth/confirm")"; expect_code_field "replayed token" TOKEN_INVALID
expect "confirm malformed token" 400 "$(post "$ANON" "{\"token\":\"nope\"}" "$API/auth/confirm")"
expect "me after confirm" 200 "$(get "$JAR" "$API/auth/me")"
[ "$(json 'j.username + "/" + j.role' < "$TMP/body")" = "$USER/STANDARD" ] && ok "me is $USER STANDARD" || ko "me profile" "$(cat "$TMP/body")"
[ "$(json 'JSON.stringify(j).includes("password")' < "$TMP/body")" = false ] && ok "profile carries no password hash" || ko "profile leaks"

echo "== logout / login =="
expect "logout" 204 "$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST "$API/auth/logout")"
expect "me after logout" 401 "$(get "$JAR" "$API/auth/me")"
expect "login by email" 200 "$(post "$JAR" "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/login")"
expect "login by username (other case)" 200 "$(post "$JAR2" "{\"identifier\":\"$(echo "$USER" | tr a-z A-Z)\",\"password\":\"$PASS\"}" "$API/auth/login")"
expect "login wrong password" 401 "$(post "$ANON" "{\"identifier\":\"$EMAIL\",\"password\":\"wrong $PASS\"}" "$API/auth/login")"; expect_code_field "wrong password" INVALID_CREDENTIALS
expect "login unknown user" 401 "$(post "$ANON" "{\"identifier\":\"ghost-$RAND\",\"password\":\"$PASS\"}" "$API/auth/login")"; expect_code_field "unknown user" INVALID_CREDENTIALS
expect "me with session A" 200 "$(get "$JAR" "$API/auth/me")"
expect "me with session B" 200 "$(get "$JAR2" "$API/auth/me")"

echo "== endpoint ownership =="
OWNED=$(curl -s -b "$JAR" -X POST "$API/endpoints" | json 'j.id')
ANONEP=$(curl -s -X POST "$API/endpoints" | json 'j.id')
[ -n "$OWNED" ] && [ -n "$ANONEP" ] && ok "created endpoints $OWNED (signed in) / $ANONEP (anonymous)" || ko "create endpoints"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^yomail-mysql$'; then
  own=$(docker exec yomail-mysql mysql -N -uyomail -pyomail yomail -e "SELECT IFNULL(owner_id,'NULL') FROM endpoints WHERE id='$OWNED'" 2>/dev/null)
  anon=$(docker exec yomail-mysql mysql -N -uyomail -pyomail yomail -e "SELECT IFNULL(owner_id,'NULL') FROM endpoints WHERE id='$ANONEP'" 2>/dev/null)
  uid=$(json 'j.id' < "$TMP/body")
  [ "$own" = "$uid" ] && ok "owned endpoint has owner_id = user id" || ko "owner_id" "got $own, expected $uid"
  [ "$anon" = "NULL" ] && ok "anonymous endpoint has owner_id NULL" || ko "anonymous owner_id" "$anon"
else
  echo "SKIP  owner_id checks (docker/yomail-mysql not reachable)"
fi
expect "capture on owned endpoint still public" 200 "$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/$OWNED" -d 'hi')"

echo "== password change =="
expect "change password wrong current" 400 "$(post "$JAR" "{\"current_password\":\"nope nope nope\",\"new_password\":\"$PASS 2\"}" "$API/account/password" -X PATCH)"; expect_code_field "wrong current" WRONG_PASSWORD
expect "change password" 204 "$(post "$JAR" "{\"current_password\":\"$PASS\",\"new_password\":\"$PASS 2\"}" "$API/account/password" -X PATCH)"
PASS="$PASS 2"
expect "session A kept" 200 "$(get "$JAR" "$API/auth/me")"
expect "session B revoked" 401 "$(get "$JAR2" "$API/auth/me")"
expect "change password anonymous" 401 "$(post "$ANON" "{\"current_password\":\"x\",\"new_password\":\"$PASS\"}" "$API/account/password" -X PATCH)"

echo "== forgot / reset =="
expect "forgot password" 200 "$(post "$ANON" "{\"email\":\"$EMAIL\"}" "$API/auth/forgot-password")"
expect "forgot unknown email" 200 "$(post "$ANON" "{\"email\":\"nobody-$RAND@example.test\"}" "$API/auth/forgot-password")"
sleep 1
RLINK=$(mail_link "$EMAIL" reset-password)
[ -n "$RLINK" ] && ok "reset link found in the dev mail catcher" || ko "reset link"
RTOKEN=$(token_of "$RLINK")
expect "reset password" 204 "$(post "$ANON" "{\"token\":\"$RTOKEN\",\"password\":\"$PASS 3\"}" "$API/auth/reset-password")"
expect "reset token replayed" 400 "$(post "$ANON" "{\"token\":\"$RTOKEN\",\"password\":\"$PASS 4\"}" "$API/auth/reset-password")"
expect "all sessions revoked after reset" 401 "$(get "$JAR" "$API/auth/me")"
expect "old password refused" 401 "$(post "$JAR" "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/login")"
PASS="$PASS 3"
expect "new password accepted" 200 "$(post "$JAR" "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/login")"

echo "== delete account =="
expect "delete wrong password" 400 "$(post "$JAR" "{\"password\":\"nope nope nope\"}" "$API/account" -X DELETE)"
expect "delete account" 204 "$(post "$JAR" "{\"password\":\"$PASS\"}" "$API/account" -X DELETE)"
expect "me after delete" 401 "$(get "$JAR" "$API/auth/me")"
expect "login after delete" 401 "$(post "$ANON" "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/login")"; expect_code_field "login after delete" INVALID_CREDENTIALS
expect "username free again" 201 "$(post "$ANON" "{\"username\":\"$USER\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/auth/signup")"
expect "owned endpoint survives deletion" 200 "$(get "$ANON" "$API/endpoints/$OWNED")"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^yomail-mysql$'; then
  row=$(docker exec yomail-mysql mysql -N -uyomail -pyomail yomail -e "SELECT CONCAT(status,'|',username,'|',email,'|',LENGTH(password_hash)) FROM users WHERE status='DELETED' AND email LIKE 'deleted+%@invalid' ORDER BY deleted_at DESC LIMIT 1" 2>/dev/null)
  echo "$row" | grep -q "^DELETED|deleted_[0-9a-f]\{8\}|deleted+.*@invalid|0$" && ok "deleted row anonymized ($row)" || ko "anonymized row" "$row"
  own=$(docker exec yomail-mysql mysql -N -uyomail -pyomail yomail -e "SELECT IFNULL(owner_id,'NULL') FROM endpoints WHERE id='$OWNED'" 2>/dev/null)
  [ "$own" = "NULL" ] && ok "owned endpoint released (owner_id NULL)" || ko "owner released" "$own"
fi
curl -s -o /dev/null -X DELETE "$API/endpoints/$OWNED"; curl -s -o /dev/null -X DELETE "$API/endpoints/$ANONEP"

echo "== dev mail catcher is admin-only =="
expect "catcher anonymous" 401 "$(get "$TMP/nobody.jar" "$CATCHER/messages.json")"
expect "catcher HTML anonymous" 401 "$(get "$TMP/nobody.jar" "$CATCHER")"
expect "catcher admin" 200 "$(get "$JADMIN" "$CATCHER/messages.json")"
expect "catcher HTML admin" 200 "$(get "$JADMIN" "$CATCHER")"
echo "== dev mail catcher ingest (other applications) =="
expect "catcher push anonymous" 401 "$(post "$TMP/nobody.jar" '{"to":"x@example.test","subject":"s","text":"t"}' "$CATCHER/messages.json")"
expect "catcher push invalid" 400 "$(post "$JADMIN" '{"to":"","text":"t"}' "$CATCHER/messages.json")"; expect_code_field "catcher push invalid" VALIDATION
expect "catcher push without content" 400 "$(post "$JADMIN" '{"to":"x@example.test"}' "$CATCHER/messages.json")"
expect "catcher push admin" 201 "$(post "$JADMIN" "{\"to\":\"push-$RAND@example.test\",\"from\":\"app <app@example.test>\",\"subject\":\"Pushed\",\"text\":\"See https://example.test/x/$RAND\",\"html\":\"<p>hi</p>\"}" "$CATCHER/messages.json")"
PUSHED_ID=$(json 'j.id' < "$TMP/body")
expect "catcher pushed message listed" 200 "$(get "$JADMIN" --get --data-urlencode "to=push-$RAND@example.test" "$CATCHER/messages.json")"
[ "$(json 'j[0].links[0]' < "$TMP/body")" = "https://example.test/x/$RAND" ] && ok "pushed link extracted" || ko "pushed link" "$(head -c 200 "$TMP/body")"
expect "catcher pushed detail" 200 "$(get "$JADMIN" "$CATCHER/$PUSHED_ID")"
expect "catcher pushed html" 200 "$(get "$JADMIN" "$CATCHER/$PUSHED_ID/html")"
post "$JADMIN" "{\"password\":\"$ADMIN_PASS\"}" "$API/account" -X DELETE >/dev/null && ok "admin account deleted"

echo "== rate limit =="
hits=0; last=""
for i in $(seq 1 12); do
  last=$(post "$ANON" "{\"identifier\":\"ghost-$RAND\",\"password\":\"x$i\"}" "$API/auth/login")
  [ "$last" = 429 ] && break
  hits=$((hits+1))
done
[ "$last" = 429 ] && ok "429 after $hits attempts" || ko "rate limit" "no 429 after 12 attempts (last $last)"

[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }

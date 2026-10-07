#!/usr/bin/env bash
# Manual acceptance test for the member features (docs/PLAN.md, Phase 8).
#
# Usage: apps/api/test/members/members-flow.sh [BASE_URL]      (default http://localhost:3000)
# The API must run outside production (NODE_ENV != production): two throwaway accounts are
# created and confirmed through the dev mail catcher (BASE_URL/devmailcatcher/messages.json, admin-only:
# a throwaway admin is created with dist/cli/user.js, so build apps/api first).
# Exits 1 when any check fails. Restart the API between two runs (per-process throttler).
# REPLAY_PRIVATE_OK=1 (API started with REPLAY_ALLOW_PRIVATE=1) runs the positive replay check
# against a second local endpoint; without it the SSRF refusals are checked instead.
# CAP_MEMBERS=<n> (API started with MAX_REQUESTS_PER_ENDPOINT_MEMBERS=<n>, n small) checks the members' cap.
# The purge check needs docker (yomail-mysql) and runs `npm run purge:dry-run` from the repo root.
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
# post JAR BODY URL [curl args]  -> prints the status, body in $TMP/body
post() { local jar="$1" body="$2"; shift 2; curl -s -o "$TMP/body" -w '%{http_code}' -b "$jar" -c "$jar" -H 'Content-Type: application/json' --data "$body" "$@"; }
# req JAR URL [curl args]        -> prints the status, body in $TMP/body
req()  { local jar="$1"; shift; curl -s -o "$TMP/body" -w '%{http_code}' -b "$jar" -c "$jar" "$@"; }
expect() { local name="$1" want="$2" got="$3"; [ "$got" = "$want" ] && ok "$name -> $got" || ko "$name" "got $got, expected $want: $(head -c 300 "$TMP/body")"; }
expect_code_field() { local name="$1" want="$2"; local got; got=$(json 'j.code' < "$TMP/body"); [ "$got" = "$want" ] && ok "$name code=$got" || ko "$name" "code $got, expected $want"; }
body_is() { local name="$1" expr="$2"; local got; got=$(json "$expr" < "$TMP/body"); [ "$got" = true ] && ok "$name" || ko "$name" "$(head -c 300 "$TMP/body")"; }

mail_link() { # mail_link <to> <confirm|reset-password>  (segment without slashes: MSYS path rewriting)
  curl -s -b "$JADMIN" --get --data-urlencode "to=$1" "$CATCHER/messages.json" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const seg='/'+process.argv[1]+'/';const l=(j[0]?.links||[]).find(u=>u.includes(seg));console.log(l||'')" "$2"
}

# make_member <jar> <username>: sign up, confirm through the mail catcher, leave a session in <jar>
make_member() {
  local jar="$1" user="$2" email="$2@example.test" pass="correct horse $2" link token
  [ "$(post "$jar" "{\"username\":\"$user\",\"email\":\"$email\",\"password\":\"$pass\"}" "$API/auth/signup")" = 201 ] || { ko "signup $user" "$(cat "$TMP/body")"; return 1; }
  sleep 1
  link=$(mail_link "$email" confirm)
  [ -n "$link" ] || { ko "confirmation link for $user" "nothing at $CATCHER"; return 1; }
  token=$(echo "$link" | sed -E 's#.*/##')
  [ "$(post "$jar" "{\"token\":\"$token\"}" "$API/auth/confirm")" = 200 ] || { ko "confirm $user" "$(cat "$TMP/body")"; return 1; }
  ok "member $user signed up and confirmed"
}

RAND=$(node -e "console.log(Math.random().toString(36).slice(2,8))")
ALICE="alice_$RAND"; BOB="bob_$RAND"
JA="$TMP/alice.jar"; JB="$TMP/bob.jar"; ANON="$TMP/anon.jar"
UNKNOWN=9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f

echo "== accounts =="
# The dev mail catcher is admin-only: create a throwaway admin with the CLI (same .env as the API,
# needs apps/api built) and sign it in; its session reads the confirmation / reset links.
ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
ARAND=$(node -e "console.log(Math.random().toString(36).slice(2,8))")
ADMIN="madm_$ARAND"; ADMIN_PASS="correct horse $ADMIN"; JADMIN="$TMP/admin.jar"
(cd "$ROOT_DIR" && node apps/api/dist/cli/user.js create-admin --username "$ADMIN" --email "$ADMIN@example.test" --password "$ADMIN_PASS" >/dev/null) || { ko "create admin with the CLI (run npm run build -w apps/api first)"; echo ABORT; exit 1; }
[ "$(post "$JADMIN" "{\"identifier\":\"$ADMIN\",\"password\":\"$ADMIN_PASS\"}" "$API/auth/login")" = 200 ] && ok "admin $ADMIN created by the CLI and signed in" || { ko "admin login" "$(cat "$TMP/body")"; echo ABORT; exit 1; }
make_member "$JA" "$ALICE" || { echo ABORT; exit 1; }
make_member "$JB" "$BOB" || { echo ABORT; exit 1; }
expect "dev mail catcher anonymous" 401 "$(req "$ANON" "$CATCHER/messages.json")"; expect_code_field "catcher anonymous" UNAUTHENTICATED
expect "dev mail catcher standard member" 403 "$(req "$JA" "$CATCHER/messages.json")"
expect "dev mail catcher admin" 200 "$(req "$JADMIN" "$CATCHER/messages.json")"
expect "dev mail catcher page admin" 200 "$(req "$JADMIN" "$CATCHER")"

echo "== 8.1 my endpoints =="
A1=$(curl -s -b "$JA" -X POST "$API/endpoints" | json 'j.id')
A2=$(curl -s -b "$JA" -X POST "$API/endpoints" | json 'j.id')
ANONEP=$(curl -s -X POST "$API/endpoints" | json 'j.id')
[ -n "$A1" ] && [ -n "$A2" ] && [ -n "$ANONEP" ] && ok "endpoints: $A1, $A2 (alice), $ANONEP (anonymous)" || { ko "create endpoints"; echo ABORT; exit 1; }
curl -s -o /dev/null -X POST "$BASE/$A1/one" -d 'x'
curl -s -o /dev/null -X POST "$BASE/$A1/two" -d 'y'
expect "my endpoints anonymous" 401 "$(req "$ANON" "$API/account/endpoints")"
expect "my endpoints (alice)" 200 "$(req "$JA" "$API/account/endpoints")"
body_is "alice sees exactly her two endpoints" "j.endpoints.length === 2 && j.endpoints.every(e => ['$A1','$A2'].includes(e.id)) && !j.endpoints.some(e => e.id === '$ANONEP')"
body_is "most active first, request_count and url" "j.endpoints[0].id === '$A1' && j.endpoints[0].request_count === 2 && j.endpoints[1].request_count === 0 && j.endpoints[0].url.endsWith('/$A1') && j.endpoints[0].name === null && j.endpoints[0].last_request_at !== null"
expect "my endpoints (bob)" 200 "$(req "$JB" "$API/account/endpoints")"
body_is "bob has none" "j.endpoints.length === 0"

echo "== 8.1 detail + ownership flags =="
expect "detail as owner" 200 "$(req "$JA" "$API/endpoints/$A1")"
body_is "owner sees owned=true, has_owner, response, max_requests" "j.owned === true && j.has_owner === true && 'response' in j && j.response === null && j.name === null && j.max_requests > 0 && j.retention_days > 0"
expect "detail as other member (private)" 403 "$(req "$JB" "$API/endpoints/$A1")"; expect_code_field "detail as other member" NOT_OWNER
expect "detail anonymous (private)" 401 "$(req "$ANON" "$API/endpoints/$A1")"; expect_code_field "detail anonymous" UNAUTHENTICATED
expect "inbox as other member (private)" 403 "$(req "$JB" "$API/endpoints/$A1/requests")"
expect "inbox anonymous (private)" 401 "$(req "$ANON" "$API/endpoints/$A1/requests")"
expect "inbox as owner" 200 "$(req "$JA" "$API/endpoints/$A1/requests")"
body_is "owner sees the two requests" "j.requests.length === 2"
RID1=$(json 'j.requests[0].id' < "$TMP/body")
expect "request detail anonymous (private)" 401 "$(req "$ANON" "$API/endpoints/$A1/requests/$RID1")"
expect "request detail as other member (private)" 403 "$(req "$JB" "$API/endpoints/$A1/requests/$RID1")"
expect "delete request anonymous (private)" 401 "$(req "$ANON" -X DELETE "$API/endpoints/$A1/requests/$RID1")"
expect "delete request as other member (private)" 403 "$(req "$JB" -X DELETE "$API/endpoints/$A1/requests/$RID1")"
expect "clear inbox anonymous (private)" 401 "$(req "$ANON" -X DELETE "$API/endpoints/$A1/requests")"
expect "clear inbox as other member (private)" 403 "$(req "$JB" -X DELETE "$API/endpoints/$A1/requests")"
expect "capture on a private endpoint stays open" 200 "$(req "$ANON" -X POST "$BASE/$A1/three" -d 'z')"
expect "owner still sees everything" 200 "$(req "$JA" "$API/endpoints/$A1/requests")"
body_is "three requests for the owner" "j.requests.length === 3"
expect "delete request by owner" 204 "$(req "$JA" -X DELETE "$API/endpoints/$A1/requests/$RID1")"
expect "detail of anonymous endpoint" 200 "$(req "$JA" "$API/endpoints/$ANONEP")"
body_is "anonymous endpoint: has_owner=false" "j.owned === false && j.has_owner === false"

echo "== 8.1 rename =="
expect "rename anonymous" 401 "$(post "$ANON" '{"name":"nope"}' "$API/endpoints/$A1" -X PATCH)"; expect_code_field "rename anonymous" UNAUTHENTICATED
expect "rename by other member" 403 "$(post "$JB" '{"name":"nope"}' "$API/endpoints/$A1" -X PATCH)"; expect_code_field "rename by other member" NOT_OWNER
expect "rename by owner" 200 "$(post "$JA" '{"name":"  Stripe test  "}' "$API/endpoints/$A1" -X PATCH)"
body_is "name trimmed and returned" "j.name === 'Stripe test' && j.owned === true"
expect "rename too long" 400 "$(post "$JA" "{\"name\":\"$(printf 'a%.0s' $(seq 1 81))\"}" "$API/endpoints/$A1" -X PATCH)"; expect_code_field "rename too long" VALIDATION
body_is "validation names the field" "j.fields.name !== undefined"
expect "rename empty body" 400 "$(post "$JA" '{}' "$API/endpoints/$A1" -X PATCH)"
expect "rename unknown endpoint" 404 "$(post "$JA" '{"name":"x"}' "$API/endpoints/$UNKNOWN" -X PATCH)"
expect "rename malformed id" 400 "$(post "$JA" '{"name":"x"}' "$API/endpoints/not-a-uuid" -X PATCH)"
expect "name not visible to anonymous (private)" 401 "$(req "$ANON" "$API/endpoints/$A1")"
expect "name in my endpoints" 200 "$(req "$JA" "$API/account/endpoints")"
body_is "my endpoints carries the name" "j.endpoints.find(e => e.id === '$A1').name === 'Stripe test'"
expect "clear name" 200 "$(post "$JA" '{"name":null}' "$API/endpoints/$A1" -X PATCH)"
body_is "name cleared" "j.name === null"
expect "rename anonymous endpoint by member" 403 "$(post "$JA" '{"name":"x"}' "$API/endpoints/$ANONEP" -X PATCH)"; expect_code_field "rename anonymous endpoint" NOT_OWNER

echo "== 8.1 claim =="
expect "claim anonymous" 401 "$(req "$ANON" -X POST "$API/endpoints/$ANONEP/claim")"
expect "claim owned endpoint" 403 "$(req "$JB" -X POST "$API/endpoints/$A1/claim")"; expect_code_field "claim owned endpoint" NOT_OWNER
expect "claim own endpoint" 403 "$(req "$JA" -X POST "$API/endpoints/$A1/claim")"
expect "claim unknown" 404 "$(req "$JB" -X POST "$API/endpoints/$UNKNOWN/claim")"
expect "claim by bob" 200 "$(req "$JB" -X POST "$API/endpoints/$ANONEP/claim")"
body_is "claimed: owned by bob" "j.owned === true && j.has_owner === true"
expect "claim twice" 403 "$(req "$JB" -X POST "$API/endpoints/$ANONEP/claim")"
expect "bob's list" 200 "$(req "$JB" "$API/account/endpoints")"
body_is "claimed endpoint listed for bob" "j.endpoints.length === 1 && j.endpoints[0].id === '$ANONEP'"
expect "capture on claimed endpoint still public" 200 "$(req "$ANON" -X POST "$BASE/$ANONEP" -d 'hi')"
expect "inbox of claimed endpoint now private (anonymous)" 401 "$(req "$ANON" "$API/endpoints/$ANONEP/requests")"
expect "inbox of claimed endpoint now private (alice)" 403 "$(req "$JA" "$API/endpoints/$ANONEP/requests")"
expect "clear claimed inbox anonymous" 401 "$(req "$ANON" -X DELETE "$API/endpoints/$ANONEP/requests")"
expect "inbox of claimed endpoint for bob" 200 "$(req "$JB" "$API/endpoints/$ANONEP/requests")"
body_is "bob sees the captured request" "j.requests.length === 1"
expect "clear claimed inbox by bob" 204 "$(req "$JB" -X DELETE "$API/endpoints/$ANONEP/requests")"

echo "== 8.1 delete rules =="
expect "delete owned endpoint anonymous" 401 "$(req "$ANON" -X DELETE "$API/endpoints/$A2")"; expect_code_field "delete anonymous" UNAUTHENTICATED
expect "delete owned endpoint other member" 403 "$(req "$JB" -X DELETE "$API/endpoints/$A2")"; expect_code_field "delete other member" NOT_OWNER
expect "still there (owner)" 200 "$(req "$JA" "$API/endpoints/$A2")"
expect "delete owned endpoint by owner" 204 "$(req "$JA" -X DELETE "$API/endpoints/$A2")"
expect "gone" 404 "$(req "$JA" "$API/endpoints/$A2")"
FREE=$(curl -s -X POST "$API/endpoints" | json 'j.id')
expect "delete anonymous endpoint by anyone (unchanged)" 204 "$(req "$ANON" -X DELETE "$API/endpoints/$FREE")"
FREE=$(curl -s -X POST "$API/endpoints" | json 'j.id')
expect "delete anonymous endpoint by a member" 204 "$(req "$JB" -X DELETE "$API/endpoints/$FREE")"

echo "== 8.2 configurable response =="
RESP='{"response":{"status":202,"content_type":"text/plain; charset=utf-8","body":"accepted!","headers":[["X-Custom","yes"],["Location","/next"]],"delay_ms":0}}'
expect "set response anonymous" 401 "$(post "$ANON" "$RESP" "$API/endpoints/$A1" -X PATCH)"
expect "set response other member" 403 "$(post "$JB" "$RESP" "$API/endpoints/$A1" -X PATCH)"; expect_code_field "set response other member" NOT_OWNER
expect "set response status 99" 400 "$(post "$JA" '{"response":{"status":99,"content_type":"text/plain","body":"","headers":[],"delay_ms":0}}' "$API/endpoints/$A1" -X PATCH)"
body_is "status error names response.status" "j.code === 'VALIDATION' && j.fields['response.status'] !== undefined"
expect "set response delay too long" 400 "$(post "$JA" '{"response":{"status":200,"content_type":"text/plain","body":"","headers":[],"delay_ms":10001}}' "$API/endpoints/$A1" -X PATCH)"
body_is "delay error names response.delay_ms" "j.fields['response.delay_ms'] !== undefined"
expect "set response forbidden header" 400 "$(post "$JA" '{"response":{"status":200,"content_type":"text/plain","body":"","headers":[["Set-Cookie","a=b"]],"delay_ms":0}}' "$API/endpoints/$A1" -X PATCH)"
body_is "forbidden header error names the header" "Object.keys(j.fields).some(k => k.startsWith('response.headers'))"
expect "set response header with CRLF" 400 "$(post "$JA" '{"response":{"status":200,"content_type":"text/plain","body":"","headers":[["X-A","a\r\nb"]],"delay_ms":0}}' "$API/endpoints/$A1" -X PATCH)"
expect "set response too many headers" 400 "$(post "$JA" "{\"response\":{\"status\":200,\"content_type\":\"text/plain\",\"body\":\"\",\"headers\":$(node -e "console.log(JSON.stringify(Array.from({length:21},(_, i)=>['X-'+i,'v'])))"),\"delay_ms\":0}}" "$API/endpoints/$A1" -X PATCH)"
expect "set response body > 64 KB" 400 "$(node -e "process.stdout.write(JSON.stringify({response:{status:200,content_type:'text/plain',body:'a'.repeat(65537),headers:[],delay_ms:0}}))" | curl -s -o "$TMP/body" -w '%{http_code}' -b "$JA" -H 'Content-Type: application/json' --data-binary @- -X PATCH "$API/endpoints/$A1")"
body_is "body error names response.body" "j.fields['response.body'] !== undefined"
expect "set response by owner" 200 "$(post "$JA" "$RESP" "$API/endpoints/$A1" -X PATCH)"
body_is "owner sees the config" "j.custom_response === true && j.response.status === 202 && j.response.headers.length === 2"
expect "config hidden from others (private endpoint)" 401 "$(req "$ANON" "$API/endpoints/$A1")"
expect "config hidden from another member" 403 "$(req "$JB" "$API/endpoints/$A1")"
curl -s -D "$TMP/h" -o "$TMP/body" -X POST "$BASE/$A1/hook?x=1" -H 'Content-Type: application/json' -d '{"a":1}'
grep -q "^HTTP/1.1 202" "$TMP/h" && ok "capture answers the configured status" || ko "configured status" "$(head -1 "$TMP/h")"
grep -qi "^content-type: text/plain; charset=utf-8" "$TMP/h" && ok "configured Content-Type" || ko "configured Content-Type" "$(grep -i content-type "$TMP/h")"
grep -qi "^x-custom: yes" "$TMP/h" && grep -qi "^location: /next" "$TMP/h" && ok "configured headers present" || ko "configured headers" "$(cat "$TMP/h")"
grep -qi "^access-control-allow-origin: \*" "$TMP/h" && ok "CORS * kept" || ko "CORS kept"
grep -qi "^content-security-policy: sandbox" "$TMP/h" && grep -qi "^x-content-type-options: nosniff" "$TMP/h" && ok "CSP sandbox + nosniff added" || ko "CSP/nosniff" "$(cat "$TMP/h")"
[ "$(cat "$TMP/body")" = "accepted!" ] && ok "configured body" || ko "configured body" "$(cat "$TMP/body")"
expect "request stored despite the custom response" 200 "$(req "$JA" "$API/endpoints/$A1/requests")"
body_is "stored request is the one just sent" "j.requests[0].path === '/hook' && j.requests[0].method === 'POST'"
curl -s -o /dev/null -D "$TMP/h" -I "$BASE/$A1"
grep -q "^HTTP/1.1 202" "$TMP/h" && grep -qi "^x-custom: yes" "$TMP/h" && ! grep -qi "^content-length: [1-9]" "$TMP/h" && ok "HEAD: configured status and headers, no body" || ko "HEAD" "$(head -1 "$TMP/h")"
expect "set delayed response" 200 "$(post "$JA" '{"response":{"status":200,"content_type":"application/json","body":"{\"later\":true}","headers":[],"delay_ms":1500}}' "$API/endpoints/$A1" -X PATCH)"
start=$(date +%s%N)
curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/$A1/slow" -d 'x' > "$TMP/code" &
sleep 0.6
listed=$(curl -s -b "$JA" "$API/endpoints/$A1/requests" | json 'j.requests[0].path')
wait
elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
[ "$(cat "$TMP/code")" = 200 ] && [ "$elapsed" -ge 1400 ] && ok "delayed response took ${elapsed} ms" || ko "delay" "code $(cat "$TMP/code"), ${elapsed} ms"
[ "$listed" = "/slow" ] && ok "request listed while the caller was still waiting" || ko "listed during delay" "$listed"
expect "reset response" 200 "$(post "$JA" '{"response":null}' "$API/endpoints/$A1" -X PATCH)"
body_is "back to default" "j.custom_response === false && j.response === null"
curl -s -D "$TMP/h" -o "$TMP/body" -X POST "$BASE/$A1" -d 'x'
grep -q "^HTTP/1.1 200" "$TMP/h" && [ "$(json 'j.ok === true && typeof j.id === "string"' < "$TMP/body")" = true ] && ok "default response restored" || ko "default response" "$(cat "$TMP/body")"
! grep -qi "^content-security-policy" "$TMP/h" && ok "no CSP on the default response" || ko "CSP on default"
expect "unknown endpoint still 404" 404 "$(req "$ANON" -X POST "$BASE/$UNKNOWN" -d x)"

echo "== 8.3 notes =="
RID=$(curl -s -X POST "$BASE/$A1/noted?k=v" -H 'Content-Type: application/json' -H 'X-Test: original' -d '{"n":1}' | json 'j.id')
expect "note anonymous" 401 "$(post "$ANON" '{"note":"x"}' "$API/endpoints/$A1/requests/$RID" -X PATCH)"
expect "note other member" 403 "$(post "$JB" '{"note":"x"}' "$API/endpoints/$A1/requests/$RID" -X PATCH)"; expect_code_field "note other member" NOT_OWNER
expect "note by owner" 200 "$(post "$JA" '{"note":"  Stripe retry #2  "}' "$API/endpoints/$A1/requests/$RID" -X PATCH)"
body_is "note trimmed in the detail" "j.note === 'Stripe retry #2' && j.id === '$RID'"
expect "note too long" 400 "$(post "$JA" "{\"note\":\"$(printf 'n%.0s' $(seq 1 2001))\"}" "$API/endpoints/$A1/requests/$RID" -X PATCH)"
body_is "note error names the field" "j.code === 'VALIDATION' && j.fields.note !== undefined"
expect "note on another endpoint's request" 404 "$(post "$JB" '{"note":"x"}' "$API/endpoints/$ANONEP/requests/$RID" -X PATCH)"
expect "note hidden with the request (private)" 401 "$(req "$ANON" "$API/endpoints/$A1/requests/$RID")"
expect "note readable by the owner" 200 "$(req "$JA" "$API/endpoints/$A1/requests/$RID")"
body_is "owner reads the note back" "j.note === 'Stripe retry #2'"
expect "list stays lean" 200 "$(req "$JA" "$API/endpoints/$A1/requests")"
body_is "summary has no note field" "!('note' in j.requests[0])"
expect "clear note" 200 "$(post "$JA" '{"note":""}' "$API/endpoints/$A1/requests/$RID" -X PATCH)"
body_is "empty string clears" "j.note === null"
expect "clear note with null" 200 "$(post "$JA" '{"note":null}' "$API/endpoints/$A1/requests/$RID" -X PATCH)"

echo "== 8.3 replay =="
expect "replay anonymous" 401 "$(post "$ANON" '{"target_url":"https://example.com/"}' "$API/endpoints/$A1/requests/$RID/replay")"
expect "replay other member" 403 "$(post "$JB" '{"target_url":"https://example.com/"}' "$API/endpoints/$A1/requests/$RID/replay")"
expect "replay bad url" 400 "$(post "$JA" '{"target_url":"not a url"}' "$API/endpoints/$A1/requests/$RID/replay")"; body_is "bad url names target_url" "j.fields.target_url !== undefined"
expect "replay ftp" 400 "$(post "$JA" '{"target_url":"ftp://example.com/x"}' "$API/endpoints/$A1/requests/$RID/replay")"
expect "replay credentials in url" 400 "$(post "$JA" '{"target_url":"https://user:pw@example.com/"}' "$API/endpoints/$A1/requests/$RID/replay")"
expect "replay unknown request" 404 "$(post "$JA" '{"target_url":"https://example.com/"}' "$API/endpoints/$A1/requests/$UNKNOWN/replay")"
if [ "${REPLAY_PRIVATE_OK:-0}" = 1 ]; then
  B=$(curl -s -b "$JB" -X POST "$API/endpoints" | json 'j.id')
  expect "replay to a local endpoint (REPLAY_ALLOW_PRIVATE=1)" 200 "$(post "$JA" "{\"target_url\":\"$BASE/$B/replayed?from=yomail\"}" "$API/endpoints/$A1/requests/$RID/replay")"
  body_is "replay result reports the target's 200 and body" "j.status === 200 && JSON.parse(j.body).ok === true && j.duration_ms >= 0 && j.truncated === false && Array.isArray(j.headers)"
  sleep 0.3
  expect "replayed request stored on B (bob's private inbox)" 200 "$(req "$JB" "$API/endpoints/$B/requests")"
  BRID=$(json 'j.requests[0].id' < "$TMP/body")
  expect "replayed request detail" 200 "$(req "$JB" "$API/endpoints/$B/requests/$BRID")"
  body_is "same method, body and X-Test header; path/query of the target; no proxy headers" "j.method === 'POST' && j.body === '{\"n\":1}' && j.path === '/replayed' && JSON.stringify(j.query_params) === '[[\"from\",\"yomail\"]]' && j.headers.some(([n,v]) => n.toLowerCase() === 'x-test' && v === 'original') && !j.headers.some(([n]) => /^x-forwarded-/i.test(n)) && j.headers.some(([n,v]) => n.toLowerCase() === 'content-type' && v === 'application/json')"
  curl -s -o /dev/null -b "$JB" -X DELETE "$API/endpoints/$B"
else
  for bad in "http://127.0.0.1:$((${BASE##*:}))/x" "http://localhost/x" "http://10.0.0.1/x" "http://[::1]/x" "http://169.254.169.254/latest/meta-data" "http://0x7f000001/" "http://192.168.1.1:8080/"; do
    code=$(post "$JA" "{\"target_url\":\"$bad\"}" "$API/endpoints/$A1/requests/$RID/replay")
    { [ "$code" = 400 ] || [ "$code" = 502 ]; } && ok "replay refused: $bad -> $code" || ko "replay $bad" "got $code: $(head -c 200 "$TMP/body")"
  done
  expect "replay to a host that does not resolve" 502 "$(post "$JA" '{"target_url":"https://no-such-host.invalid/"}' "$API/endpoints/$A1/requests/$RID/replay")"; expect_code_field "unresolvable host" REPLAY_FAILED
  # A public-looking name that resolves to 127.0.0.1: refused by the lookup guard at connection time (needs DNS).
  expect "replay to a name resolving to loopback" 502 "$(post "$JA" '{"target_url":"http://127.0.0.1.nip.io/"}' "$API/endpoints/$A1/requests/$RID/replay")"
  body_is "refused by the DNS-time guard (not a connection error)" "j.code === 'REPLAY_FAILED' && /private or reserved/.test(j.message)"
  echo "SKIP  positive replay (start the API with REPLAY_ALLOW_PRIVATE=1 and run with REPLAY_PRIVATE_OK=1)"
fi

echo "== live subscribe (private endpoints) =="
ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
# sub <endpointId> [cookie]  -> prints the ack of 'subscribe' as JSON
sub() { (cd "$ROOT_DIR" && node -e '
const { io } = require("socket.io-client");
const [base, id, cookie] = process.argv.slice(1);
const s = io(base, { path: "/api/socket.io", transports: ["polling"], extraHeaders: cookie ? { cookie } : {}, reconnection: false });
const done = (v) => { console.log(JSON.stringify(v)); s.close(); process.exit(0); };
s.on("connect", () => s.emit("subscribe", { endpointId: id }, done));
s.on("connect_error", (e) => done({ ok: false, error: "connect_error: " + e.message }));
setTimeout(() => done({ ok: false, error: "timeout" }), 5000);
' "$BASE" "$@"); }
cookie_of() { awk -v n=yomail_session '$6 == n { print n "=" $7 }' "$1"; }
r=$(sub "$A1"); [ "$r" = '{"ok":false,"error":"UNAUTHENTICATED"}' ] && ok "subscribe anonymous refused: $r" || ko "subscribe anonymous" "$r"
r=$(sub "$A1" "$(cookie_of "$JB")"); [ "$r" = '{"ok":false,"error":"NOT_OWNER"}' ] && ok "subscribe other member refused: $r" || ko "subscribe other member" "$r"
r=$(sub "$A1" "$(cookie_of "$JA")"); [ "$r" = '{"ok":true}' ] && ok "subscribe owner accepted" || ko "subscribe owner" "$r"
FREE3=$(curl -s -X POST "$API/endpoints" | json 'j.id')
r=$(sub "$FREE3"); [ "$r" = '{"ok":true}' ] && ok "subscribe anonymous endpoint open to anyone" || ko "subscribe anonymous endpoint" "$r"
r=$(sub "$UNKNOWN"); [ "$r" = '{"ok":false,"error":"unknown endpoint"}' ] && ok "subscribe unknown endpoint refused" || ko "subscribe unknown" "$r"
curl -s -o /dev/null -X DELETE "$API/endpoints/$FREE3"

echo "== 8.4 member limits =="
expect "health" 200 "$(req "$ANON" "$API/health")"
RET=$(json 'j.retention_days' < "$TMP/body"); RETM=$(json 'j.retention_days_members' < "$TMP/body")
body_is "health exposes both retentions and caps" "j.retention_days_members > j.retention_days && j.max_requests_per_endpoint_members > 0 && j.max_requests_per_endpoint > 0"
FREE2=$(curl -s -X POST "$API/endpoints" | json 'j.id')
curl -s -o /dev/null -X POST "$BASE/$FREE2" -d 'anon'
expect "owned endpoint list" 200 "$(req "$JA" "$API/endpoints/$A1/requests")"
body_is "owned endpoint: members' retention and expires_at" "j.retention_days === $RETM && j.requests.every(r => new Date(r.expires_at) - new Date(r.received_at) === $RETM*86400000)"
expect "anonymous endpoint list" 200 "$(req "$ANON" "$API/endpoints/$FREE2/requests")"
body_is "anonymous endpoint: base retention" "j.retention_days === $RET && new Date(j.requests[0].expires_at) - new Date(j.requests[0].received_at) === $RET*86400000"
expect "owned endpoint detail" 200 "$(req "$JA" "$API/endpoints/$A1")"
body_is "detail carries members' limits" "j.retention_days === $RETM && j.max_requests > 0"
expect "anonymous endpoint detail" 200 "$(req "$ANON" "$API/endpoints/$FREE2")"
body_is "detail carries base limits" "j.retention_days === $RET"
if [ -n "${CAP_MEMBERS:-}" ]; then
  curl -s -o /dev/null -b "$JA" -X DELETE "$API/endpoints/$A1/requests"
  for i in $(seq 1 $((CAP_MEMBERS + 2))); do curl -s -o /dev/null -X POST "$BASE/$A1/cap$i" -d "$i"; done
  n=$(curl -s -b "$JA" "$API/endpoints/$A1/requests" | json 'j.requests.length')
  [ "$n" = "$CAP_MEMBERS" ] && ok "members' cap: $((CAP_MEMBERS + 2)) sent, $n kept" || ko "members' cap" "kept $n, expected $CAP_MEMBERS"
  for i in $(seq 1 $((CAP_MEMBERS + 2))); do curl -s -o /dev/null -X POST "$BASE/$FREE2/cap$i" -d "$i"; done
  n=$(curl -s "$API/endpoints/$FREE2/requests" | json 'j.requests.length')
  [ "$n" = "$((CAP_MEMBERS + 3))" ] && ok "anonymous endpoint keeps its own (larger) cap: $n rows" || ko "anonymous cap" "kept $n"
else
  echo "SKIP  members' cap (start the API with MAX_REQUESTS_PER_ENDPOINT_MEMBERS=3 and run with CAP_MEMBERS=3)"
fi
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^yomail-mysql$'; then
  ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
  dry() { (cd "$ROOT_DIR" && npm run -s purge:dry-run -w apps/api 2>&1) | sed -n 's/.*would delete \([0-9]*\) request.*/\1/p' | tail -1; }
  n0=$(dry)
  old=$((RET + 1))
  docker exec yomail-mysql mysql -uyomail -pyomail yomail -e "INSERT INTO requests (id, endpoint_id, method, path, headers, content_kind, size_bytes, received_at) VALUES (UUID(), '$A1', 'GET', '/old', '[]', 'none', 0, NOW(3) - INTERVAL $old DAY), (UUID(), '$FREE2', 'GET', '/old', '[]', 'none', 0, NOW(3) - INTERVAL $old DAY)" 2>/dev/null
  n1=$(dry)
  [ -n "$n0" ] && [ "$n1" = "$((n0 + 1))" ] && ok "purge dry run counts the anonymous row ($old d) but not the owned one (members keep $RETM d): $n0 -> $n1" || ko "purge dry run" "before $n0, after $n1"
else
  echo "SKIP  purge check (docker/yomail-mysql not reachable)"
fi
curl -s -o /dev/null -X DELETE "$API/endpoints/$FREE2"

echo "== cleanup =="
curl -s -o /dev/null -b "$JA" -X DELETE "$API/endpoints/$A1"
curl -s -o /dev/null -b "$JB" -X DELETE "$API/endpoints/$ANONEP"
post "$JA" "{\"password\":\"correct horse $ALICE\"}" "$API/account" -X DELETE >/dev/null
post "$JB" "{\"password\":\"correct horse $BOB\"}" "$API/account" -X DELETE >/dev/null
post "$JADMIN" "{\"password\":\"$ADMIN_PASS\"}" "$API/account" -X DELETE >/dev/null
ok "accounts deleted (members and admin)"

[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }

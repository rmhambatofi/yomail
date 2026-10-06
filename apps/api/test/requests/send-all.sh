#!/usr/bin/env bash
# Manual acceptance test for the capture routes (docs/PLAN.md, Phase 2).
#
# Usage:
#   apps/api/test/requests/send-all.sh [BASE_URL] [ENDPOINT_ID]
#     BASE_URL     default http://localhost:3000 (the API itself, or the Vite dev server which proxies)
#     ENDPOINT_ID  default: a fresh endpoint created with POST $BASE_URL/api/endpoints
#   CAP=500 apps/api/test/requests/send-all.sh ...   also sends CAP+5 requests to check the per-endpoint cap
#
# Prints one PASS/FAIL line per case and exits 1 when any case fails. Field-level checks
# (content_kind, form_fields, dropped_files, ...) are done in MySQL afterwards; see the plan.
set -u
cd "$(dirname "$0")"

BASE="${1:-http://localhost:3000}"
EP="${2:-}"
MAX_BODY="${MAX_BODY_BYTES:-524288}"
fail=0

if [ -z "$EP" ]; then
  EP=$(curl -s -X POST "$BASE/api/endpoints" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  [ -n "$EP" ] || { echo "could not create an endpoint via POST $BASE/api/endpoints" >&2; exit 1; }
  echo "endpoint: $EP"
fi
URL="$BASE/$EP"

# check <name> <expected status> <curl args...>
check() {
  local name="$1" expected="$2"; shift 2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$code" = "$expected" ]; then
    printf 'PASS  %-32s %s\n' "$name" "$code"
  else
    printf 'FAIL  %-32s got %s, expected %s\n' "$name" "$code" "$expected"; fail=1
  fi
}

check "POST json"            200 -X POST "$URL" -H 'Content-Type: application/json' --data-binary @sample.json
check "POST invalid json"    200 -X POST "$URL" -H 'Content-Type: application/json' --data-binary @invalid-json.txt
check "POST form urlencoded" 200 -X POST "$URL" -H 'Content-Type: application/x-www-form-urlencoded' --data-binary @sample.form
check "POST multipart+file"  200 -X POST "$URL" -F name=Bob -F 'tags=a' -F 'tags=b' -F file=@sample.bin -F doc=@sample.txt
check "POST html"            200 -X POST "$URL" -H 'Content-Type: text/html; charset=utf-8' --data-binary @sample.html
check "POST xml"             200 -X POST "$URL" -H 'Content-Type: application/xml' --data-binary @sample.xml
check "POST text"            200 -X POST "$URL" -H 'Content-Type: text/plain' --data-binary @sample.txt
check "POST json as text"    200 -X POST "$URL" -H 'Content-Type: text/plain' --data-binary @json-as-text.txt
check "POST binary"          200 -X POST "$URL" -H 'Content-Type: application/octet-stream' --data-binary @sample.bin
check "POST no content-type" 200 -X POST "$URL" -H 'Content-Type:' --data-binary @sample.txt
check "POST empty body"      200 -X POST "$URL" -H 'Content-Length: 0'
check "GET with query"       200 "$URL?a=1&a=2&b=hello%20world"
check "PUT sub-path + query" 200 -X PUT "$URL/orders/42?x=1" -H 'Content-Type: application/json' --data-binary @sample.json
check "PATCH"                200 -X PATCH "$URL/orders/42" -H 'Content-Type: application/merge-patch+json' -d '{"qty":3}'
check "DELETE"               200 -X DELETE "$URL/orders/42"
check "OPTIONS preflight"    200 -X OPTIONS "$URL" -H 'Origin: https://example.org' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type, x-custom'
check "HEAD"                 200 -I "$URL"
check "trailing slash"       200 "$URL/"

# Oversized body: MAX_BODY + 1 bytes, with and without Content-Length (chunked).
head -c $((MAX_BODY + 1)) /dev/zero > oversized.tmp
check "oversized (content-length)" 413 -X POST "$URL" -H 'Content-Type: text/plain' --data-binary @oversized.tmp
check "oversized (chunked)"        413 -X POST "$URL" -H 'Content-Type: text/plain' -H 'Transfer-Encoding: chunked' --data-binary @oversized.tmp
rm -f oversized.tmp

check "unknown endpoint"     404 -X POST "$BASE/9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f" -d 'x'
check "not a v4 uuid"        404 -X POST "$BASE/00000000-0000-0000-0000-000000000000" -d 'x'
check "malformed id"         404 -X POST "$BASE/not-an-endpoint" -d 'x'
check "upper-case id"        200 -X POST "$BASE/$(echo "$EP" | tr 'a-f' 'A-F')" -d 'x'

# Headers of a captured response: open CORS on success and on 404.
hdr=$(curl -s -D - -o /dev/null -X OPTIONS "$URL" -H 'Origin: https://example.org' -H 'Access-Control-Request-Method: PUT' -H 'Access-Control-Request-Headers: x-custom')
echo "$hdr" | grep -qi '^access-control-allow-origin: \*' && echo "PASS  cors origin *" || { echo "FAIL  cors origin *"; fail=1; }
echo "$hdr" | grep -qi '^access-control-allow-headers: x-custom' && echo "PASS  cors allow-headers echo" || { echo "FAIL  cors allow-headers echo"; fail=1; }
hdr=$(curl -s -D - -o /dev/null "$BASE/9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")
echo "$hdr" | grep -qi '^access-control-allow-origin: \*' && echo "PASS  cors on 404" || { echo "FAIL  cors on 404"; fail=1; }
body=$(curl -s -X POST "$URL" -d 'x')
echo "$body" | grep -q '"ok":true' && echo "PASS  response body {ok,id}" || { echo "FAIL  response body: $body"; fail=1; }
body=$(curl -s "$BASE/9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")
[ "$body" = '{"ok":false,"error":"unknown endpoint"}' ] && echo "PASS  404 body" || { echo "FAIL  404 body: $body"; fail=1; }

if [ -n "${CAP:-}" ]; then
  echo "sending $((CAP + 5)) requests to check the cap (MAX_REQUESTS_PER_ENDPOINT=$CAP)..."
  for i in $(seq 1 $((CAP + 5))); do curl -s -o /dev/null -X POST "$URL/cap/$i" -d "$i"; done
  echo "done; verify in MySQL: SELECT COUNT(*) FROM requests WHERE endpoint_id='$EP'  (expected $CAP)"
fi

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail

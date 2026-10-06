#!/usr/bin/env bash
# Manual acceptance test for the REST API (docs/PLAN.md, Phase 3).
#
# Usage: apps/api/test/requests/rest-flow.sh [BASE_URL]      (default http://localhost:3000)
# Creates two endpoints, captures a few requests, then walks list / pagination / detail /
# delete / clear / delete endpoint and the 400 / 404 cases. Exits 1 when any check fails.
set -u
cd "$(dirname "$0")"
BASE="${1:-http://localhost:3000}"
API="$BASE/api"
fail=0

ok()   { printf 'PASS  %s\n' "$1"; }
ko()   { printf 'FAIL  %s%s\n' "$1" "${2:+ ($2)}"; fail=1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(eval(process.argv[1]))" "$1"; }
expect_code() { local name="$1" want="$2"; shift 2; local got; got=$(code "$@"); [ "$got" = "$want" ] && ok "$name -> $got" || ko "$name" "got $got, expected $want"; }

# --- setup: two endpoints, a few captures -----------------------------------
A=$(curl -s -X POST "$API/endpoints" | json 'j.id'); B=$(curl -s -X POST "$API/endpoints" | json 'j.id')
[ -n "$A" ] && [ -n "$B" ] && ok "create endpoints $A / $B" || { ko "create endpoints"; exit 1; }
# url is built from PUBLIC_BASE_URL (apps/api/.env), which may differ from the test BASE.
created=$(curl -s -X POST "$API/endpoints")
[ "$(echo "$created" | json 'j.url.endsWith("/" + j.id) && /^https?:\/\//.test(j.url)')" = true ] && ok "create returns url = PUBLIC_BASE_URL/<id>" || ko "create url" "$created"
curl -s -o /dev/null -X DELETE "$API/endpoints/$(echo "$created" | json 'j.id')"

curl -s -o /dev/null -X POST "$BASE/$A/orders/1" -H 'Content-Type: application/json' --data-binary @sample.json
curl -s -o /dev/null -X POST "$BASE/$A" -H 'Content-Type: text/html' --data-binary @sample.html
curl -s -o /dev/null -X POST "$BASE/$A?a=1&a=2" -H 'Content-Type: application/x-www-form-urlencoded' --data-binary @sample.form
curl -s -o /dev/null -X PUT "$BASE/$A/third" -d 'x'
curl -s -o /dev/null -X POST "$BASE/$A/fourth" -d 'y'
RB=$(curl -s -X POST "$BASE/$B" -d 'other' | json 'j.id')

# --- endpoint detail --------------------------------------------------------
det=$(curl -s "$API/endpoints/$A")
[ "$(echo "$det" | json 'j.request_count')" = 5 ] && ok "endpoint detail request_count=5" || ko "endpoint detail" "$det"
[ "$(echo "$det" | json 'j.last_request_at !== null && j.retention_days > 0')" = true ] && ok "endpoint detail last_request_at + retention_days" || ko "endpoint detail fields" "$det"
expect_code "endpoint detail upper-case id" 200 "$API/endpoints/$(echo "$A" | tr a-f A-F)"
expect_code "endpoint detail unknown" 404 "$API/endpoints/9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
expect_code "endpoint detail malformed" 400 "$API/endpoints/not-a-uuid"

# --- list + pagination -----------------------------------------------------
list=$(curl -s "$API/endpoints/$A/requests")
[ "$(echo "$list" | json 'j.requests.length')" = 5 ] && ok "list returns 5" || ko "list count" "$list"
[ "$(echo "$list" | json 'j.has_more')" = false ] && ok "list has_more=false" || ko "list has_more" "$list"
[ "$(echo "$list" | json 'j.requests[0].path')" = "/fourth" ] && ok "list newest first" || ko "list order" "$list"
[ "$(echo "$list" | json 'Object.keys(j.requests[0]).sort().join()')" = "client_ip,content_kind,endpoint_id,expires_at,id,method,path,received_at,size_bytes" ] && ok "summary has no body/headers" || ko "summary keys" "$(echo "$list" | json 'Object.keys(j.requests[0])')"
[ "$(echo "$list" | json 'new Date(j.requests[0].expires_at) - new Date(j.requests[0].received_at) === j.retention_days*86400000')" = true ] && ok "expires_at = received_at + retention" || ko "expires_at" "$list"

page1=$(curl -s "$API/endpoints/$A/requests?limit=2")
[ "$(echo "$page1" | json 'j.requests.length')" = 2 ] && [ "$(echo "$page1" | json 'j.has_more')" = true ] && ok "page 1: 2 rows, has_more" || ko "page 1" "$page1"
cursor=$(echo "$page1" | json 'j.requests[1].received_at')
page2=$(curl -s "$API/endpoints/$A/requests?limit=2&before=$cursor")
[ "$(echo "$page2" | json 'j.requests[0].path')" = "/" ] && [ "$(echo "$page2" | json 'j.requests.length')" = 2 ] && ok "page 2 via before=" || ko "page 2" "$page2"
cursor2=$(echo "$page2" | json 'j.requests[1].received_at')
page3=$(curl -s "$API/endpoints/$A/requests?limit=2&before=$cursor2")
[ "$(echo "$page3" | json 'j.requests.length')" = 1 ] && [ "$(echo "$page3" | json 'j.has_more')" = false ] && ok "page 3: last row, has_more=false" || ko "page 3" "$page3"
expect_code "list limit=0" 400 "$API/endpoints/$A/requests?limit=0"
expect_code "list limit=201" 400 "$API/endpoints/$A/requests?limit=201"
expect_code "list limit=abc" 400 "$API/endpoints/$A/requests?limit=abc"
expect_code "list before=garbage" 400 "$API/endpoints/$A/requests?before=garbage"
expect_code "list unknown endpoint" 404 "$API/endpoints/9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f/requests"
expect_code "list malformed endpoint" 400 "$API/endpoints/xyz/requests"

# --- detail ----------------------------------------------------------------
html_id=$(echo "$list" | json 'j.requests.find(r => r.content_kind === "html").id')
det=$(curl -s "$API/endpoints/$A/requests/$html_id")
[ "$(echo "$det" | json 'j.body.includes("<script>") && !j.html_sanitized.includes("<script>") && j.html_sanitized.includes("data-src=")')" = true ] && ok "html detail: raw body kept, html_sanitized without script, img -> data-src" || ko "html detail" "$det"
[ "$(echo "$det" | json 'Array.isArray(j.headers) && j.headers.length > 0 && j.content_type === "text/html"')" = true ] && ok "detail headers + content_type" || ko "detail headers" "$det"
# curl -d without Content-Type also yields a form; the one sent to "/" with ?a=1&a=2 is the fixture.
form_id=$(echo "$list" | json 'j.requests.find(r => r.content_kind === "form" && r.path === "/").id')
det=$(curl -s "$API/endpoints/$A/requests/$form_id")
[ "$(echo "$det" | json 'JSON.stringify(j.query_params) === JSON.stringify([["a","1"],["a","2"]]) && j.form_fields.length === 4 && j.html_sanitized === null')" = true ] && ok "form detail: query_params, form_fields, no html_sanitized" || ko "form detail" "$det"
expect_code "detail of B's request via A" 404 "$API/endpoints/$A/requests/$RB"
expect_code "detail malformed id" 400 "$API/endpoints/$A/requests/nope"
expect_code "detail unknown id" 404 "$API/endpoints/$A/requests/9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"

# --- delete one / clear / delete endpoint ----------------------------------
expect_code "delete B's request via A" 404 -X DELETE "$API/endpoints/$A/requests/$RB"
expect_code "delete one" 204 -X DELETE "$API/endpoints/$A/requests/$html_id"
expect_code "delete one again" 404 -X DELETE "$API/endpoints/$A/requests/$html_id"
[ "$(curl -s "$API/endpoints/$A/requests" | json 'j.requests.length')" = 4 ] && ok "4 left after delete" || ko "count after delete"
expect_code "clear inbox" 204 -X DELETE "$API/endpoints/$A/requests"
[ "$(curl -s "$API/endpoints/$A/requests" | json 'j.requests.length')" = 0 ] && ok "0 left after clear" || ko "count after clear"
expect_code "endpoint still exists after clear" 200 "$API/endpoints/$A"
expect_code "B untouched" 200 "$API/endpoints/$B/requests/$RB"
expect_code "delete endpoint B" 204 -X DELETE "$API/endpoints/$B"
expect_code "B gone (detail)" 404 "$API/endpoints/$B"
expect_code "B gone (list)" 404 "$API/endpoints/$B/requests"
expect_code "B gone (capture)" 404 -X POST "$BASE/$B" -d x
expect_code "delete endpoint twice" 404 -X DELETE "$API/endpoints/$B"
expect_code "delete endpoint A" 204 -X DELETE "$API/endpoints/$A"
curl -s -D - -o /dev/null "$API/endpoints/$A" | grep -qi 'cache-control: no-store' && ok "no-store header" || ko "no-store header"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $fail

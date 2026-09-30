#!/usr/bin/env bash
#
# Every AI feature has an organisation list, and the list decides (AiGate,
# 30 Sept 2026; Mr. Singh after a customer used Mail AI before its privacy
# text existed).
#
# What is proved:
#   1. the static check passes on this tree (every sender asks AiGate; every
#      label has a list) - tests/ai/every_ai_entry_calls_gate.py
#   2. the migration: a fresh database (every file applied twice) has
#      ai.connect.organisations = all, so meeting minutes stay as they are;
#      no Docs row, which means nobody; and re-running the file does NOT put
#      "all" back over an operator's change
#   3. against a running API and a FAKE provider whose hit counter is the
#      witness: Techvein and ABC School both have AI and Mail AI switched ON,
#      so only the list decides -
#        list = Techvein  → Techvein's rewrite reaches the provider; the
#                           school's is refused with "not available" and
#                           does NOT reach it
#        list = all       → the school's reaches it
#        list = empty     → Techvein's is refused and does not reach it
#        no list row      → the same
#
# Build first: dotnet build apps/api -c Release. Needs node (the fake).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_AIGATE_TEST_PORT:-5098}"
API="http://localhost:$PORT"
FAKE="http://127.0.0.1:5199"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"

SCRATCH="$ROOT/.tmp/ai-gate-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf "%s" "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf "  %s✓%s %s\n" "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  %s✗%s %s\n" "$RED" "$RST" "$1"; }
step() { printf "\n%s>> %s%s\n" "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
jq_() { printf "%s" "$1" | j "$2"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
brief() { printf "%s" "$1" | head -c 220 | tr "\n" " "; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif printf "%s" "$2" | grep -qF -- "$3"; then pass "$1"
    else fail "$1 — not found in: $(brief "$2")"; fi
}

API_PID=""; FAKE_PID=""
stop_all() {
    for p in "$PORT" 5199; do
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else
            fuser -k "$p/tcp" >/dev/null 2>&1 || true
        fi
    done
    [ -n "$API_PID" ] && { kill "$API_PID" >/dev/null 2>&1; wait "$API_PID" 2>/dev/null; }
    [ -n "$FAKE_PID" ] && { kill "$FAKE_PID" >/dev/null 2>&1; wait "$FAKE_PID" 2>/dev/null; }
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap stop_all EXIT

step "1. Every sender asks AiGate; every label has a list (static)"
if PYTHONIOENCODING=utf-8 "$PY" "$ROOT/tests/ai/every_ai_entry_calls_gate.py" "$ROOT/apps/api" > "$SCRATCH/static.txt" 2>&1
then pass "$(sed -n 1p "$SCRATCH/static.txt" | sed 's/^ *//')"
else fail "the static check failed:"; sed 's/^/      /' "$SCRATCH/static.txt"; fi

source "$ROOT/tests/lib/throwaway-db.sh"
tdb_create aigate || { echo "  the throwaway database could not be made - the check did NOT run"; exit 2; }
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }
setting() { local v; v=$(PG "SELECT COALESCE((SELECT '['||value||']' FROM core.platform_settings WHERE key='$1'),'(no row)')"); printf "%s" "$v"; }

step "2. The migration ($TDB_NAME, every file applied twice)"
same "ai.connect.organisations is all: minutes stay as they are" "$(setting ai.connect.organisations)" "[all]"
same "ai.docs.organisations has no row: nobody" "$(setting ai.docs.organisations)" "(no row)"
PG "UPDATE core.platform_settings SET value='' WHERE key='ai.connect.organisations'" >/dev/null
PG "$(cat "$ROOT/local/postgres/init/20260930-ai-feature-lists.sql")" >/dev/null
same "re-running the file does not put all back over an operator's change" "$(setting ai.connect.organisations)" "[]"
PG "UPDATE core.platform_settings SET value='all' WHERE key='ai.connect.organisations'" >/dev/null

step "3. The list decides, and a refusal never reaches the provider"
node "$ROOT/tests/ai/fake-ai-mail.mjs" > "$SCRATCH/fake.log" 2>&1 &
FAKE_PID=$!
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local'" >/dev/null
PG "UPDATE core.users SET phone='+919999900003', role='org_owner' WHERE email='principal@abcschool.local'" >/dev/null
PG "UPDATE core.tenants SET allow_ai=true, allow_mail_ai=true, mail_ai_rewrite=true WHERE id IN ('$TECHVEIN','$SCHOOL')" >/dev/null

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="$TDB_CONN"
export Smtp__Host=localhost Smtp__Port=5870
export Personal__PhoneHashKey="test-only-phone-hash-key-at-least-32-characters"
export Ai__BaseUrl="$FAKE/v1" Ai__ApiKey=test-only-not-a-key Ai__Model=test-model Ai__DataLocation="the United States"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
curl -s "$FAKE/hits" | grep -q hits && pass "fake provider up" || { fail "fake provider did not start"; exit 1; }

signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}
TV=$(signin "+919999900001"); SC=$(signin "+919999900003")
[ -n "$TV" ] && [ -n "$SC" ] && pass "Techvein's owner and the school's owner signed in" || { fail "sign-in failed"; exit 1; }

hits() { curl -s "$FAKE/hits" | j "d['hits']"; }
rewrite() { curl -s -w "\n%{http_code}" -X POST "$API/api/mail/ai/rewrite" -H "Authorization: Bearer $1" \
                 -H "Content-Type: application/json" -d '{"text":"Please send the fee receipt for September.","style":"formal"}'; }
list() {
    if [ "$1" = "(no row)" ]; then PG "DELETE FROM core.platform_settings WHERE key='ai.mail.organisations'" >/dev/null
    else PG "INSERT INTO core.platform_settings (key, value, is_secret, updated_at) VALUES ('ai.mail.organisations', '$1', false, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null; fi
}

list "$TECHVEIN"
H0=$(hits); r=$(rewrite "$TV")
same "list = Techvein: Techvein's rewrite answers" "$(status "$r")" "200"
same "  and reached the provider (one hit)" "$(( $(hits) - H0 ))" "1"
H0=$(hits); r=$(rewrite "$SC")
has  "list = Techvein: the school is told Mail AI is not available" "$(jq_ "$(body "$r")" "d.get('error') or ''")" "not available for your organisation yet"
same "  and nothing reached the provider" "$(( $(hits) - H0 ))" "0"

list "all"
H0=$(hits); r=$(rewrite "$SC")
same "list = all: the school's rewrite reaches the provider" "$(( $(hits) - H0 ))" "1"

list ""
H0=$(hits); r=$(rewrite "$TV")
has  "list = empty: Techvein is refused too" "$(jq_ "$(body "$r")" "d.get('error') or ''")" "not available for your organisation yet"
same "  and nothing reached the provider" "$(( $(hits) - H0 ))" "0"

list "(no row)"
H0=$(hits); r=$(rewrite "$TV")
has  "no list at all: refused" "$(jq_ "$(body "$r")" "d.get('error') or ''")" "not available for your organisation yet"
same "  and nothing reached the provider" "$(( $(hits) - H0 ))" "0"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks (%s)\n\n" "$PASSED" "$TDB_NAME"; exit 0
else printf "  FAIL  %d of %d checks (%s)\n\n" "$FAILED" $((PASSED+FAILED)) "$TDB_NAME"; exit 1; fi

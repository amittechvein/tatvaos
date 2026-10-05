#!/usr/bin/env bash
#
# TatvaOS Mail - the outbound gate also checks the send API's bounce-tracked mail.
#
# THE GAP (found 1 Oct 2026, writing decision 0013). Postfix's outbound gate
# (local/postfix/sql/sender-external-gate.cf, the check_sender_access that both
# submission ports run) decides "may this sender reach outside?" by looking the
# ENVELOPE sender up among mailboxes. The organisation send API, with bounce
# tracking on, submits with a signed bounce address as envelope sender
# (BounceAddress.Build) - not a mailbox - so the lookup found nothing and the
# mail passed unchecked: the verified-domain rule did not apply to it at all.
# Off on production that day only because no bounce signing key was set yet.
#
#   A. the gate's REAL query text, taken from the .cf file, run as the mail
#      edge's role for: an allowed mailbox, a refused mailbox, a bounce address
#      of each, a bounce-shaped address with no send behind it, an unknown one
#   B. end to end: the real API with bounce tracking ON submits to gate-sink.py,
#      which makes Postfix's decision at MAIL FROM/RCPT time with the same SQL
#      against the same database - so it also proves the send's envelope record
#      (mail.api_send_envelopes) exists at the moment the gate needs it
#   C. mail.api_sends is still append-only for the app, and so is the new
#      table: the first fix wrote the send row early and UPDATEd it after the
#      submit, which the app is deliberately not allowed to do - every send
#      failed with "permission denied for table api_sends"
#
# Its own throwaway database (house rule 13). Needs python and a Release build:
#   dotnet build apps/api -c Release
# Usage: bash tests/mail-api/test-bounce-gate.sh
# ---------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${TATVAOS_PYTHON:-python}"
PROJ="$HERE/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_BOUNCE_GATE_API_PORT:-5098}"; API="http://localhost:$PORT"
SINK_PORT="${TATVAOS_BOUNCE_GATE_SINK_PORT:-5873}"
TECHVEIN="11111111-1111-1111-1111-111111111111"; SCHOOL="22222222-2222-2222-2222-222222222222"
BOUNCE_DOMAIN="bounce.tatvaos.test"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}

SCRATCH="$HERE/.tmp/bounce-gate-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"; WIRE="$SCRATCH/wire.log"
API_PID=""; SINK_PID=""
cleanup() {
    if command -v powershell.exe >/dev/null 2>&1; then
        for p in "$PORT" "$SINK_PORT"; do
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        done
    else fuser -k "$PORT/tcp" "$SINK_PORT/tcp" >/dev/null 2>&1 || true; fi
    [ -n "$API_PID" ] && kill "$API_PID" >/dev/null 2>&1
    [ -n "$SINK_PID" ] && kill "$SINK_PID" >/dev/null 2>&1
    tdb_drop    # after the API has stopped
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
tdb_create bounce_gate || exit 2
trap cleanup EXIT                      # replaces the helper's trap; cleanup drops

PG()  { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | grep -v "^SET$" | tail -n1; }
# The query of a Postfix pgsql .cf file, as Postfix reads it (continuation lines).
cf_query() { awk '/^[[:space:]]*#/{next} /^query/{t=1; sub(/^query[[:space:]]*=[[:space:]]*/,""); print; next} t&&/^[[:space:]]+[^[:space:]]/{print; next} t{exit}' "$1" | tr '\n' ' '; }
GATE_SQL="$(cf_query "$HERE/local/postfix/sql/sender-external-gate.cf")"
# gate SENDER -> what Postfix's lookup returns for that envelope sender ('' = nothing)
gate() { PG "SET ROLE tatvaos_mailedge; $(printf '%s' "$GATE_SQL" | sed "s/%s/$(printf '%s' "$1" | sed "s/'/''/g")/g")"; }

printf "\n  The outbound gate and the send API's bounce envelope\n  tree under test: %s\n  database: %s\n" "$(git -C "$HERE" rev-parse HEAD 2>/dev/null)" "$TDB_NAME"

step "0. Fixtures: Techvein may send outside, ABC School may not"
PG "UPDATE core.domains SET ownership_verified_at = now(), mx_verified_at = now(), is_active = true WHERE tenant_id = '$TECHVEIN' AND NOT is_platform" >/dev/null
PG "UPDATE core.domains SET ownership_verified_at = NULL WHERE tenant_id = '$SCHOOL' AND NOT is_platform" >/dev/null
ALLOWED=$(PG "SELECT m.address FROM mail.mailboxes m WHERE m.tenant_id = '$TECHVEIN' AND m.is_active ORDER BY m.address LIMIT 1")
BLOCKED=$(PG "SELECT m.address FROM mail.mailboxes m WHERE m.tenant_id = '$SCHOOL' AND m.is_active ORDER BY m.address LIMIT 1")
LOCAL_DOMAIN=$(PG "SELECT d.fqdn FROM core.domains d WHERE d.tenant_id = '$TECHVEIN' AND NOT d.is_platform AND d.is_active ORDER BY d.fqdn LIMIT 1")
same "Techvein's mailbox is allowed to send outside (fixture)" "$(PG "SELECT count(*) FROM mail.senders_allowed_external WHERE address = '$ALLOWED'")" "1"
same "ABC School's mailbox is not (fixture)" "$(PG "SELECT count(*) FROM mail.senders_allowed_external WHERE address = '$BLOCKED'")" "0"
[ -n "$LOCAL_DOMAIN" ] && pass "a domain we host, for an inside recipient: $LOCAL_DOMAIN" || fail "no Techvein domain to use as an inside recipient"

step "A. The gate's own query, run as the mail edge"
# Bounce addresses for two sends, one from each mailbox, each recorded as the
# send API records it before submitting: an envelope row keyed by the send id.
# (On a tree without that table the INSERT fails, and the gate it is meant to
# feed does not look for it either - which is the gap.)
S_ALLOWED=$(PG "SELECT gen_random_uuid()"); S_BLOCKED=$(PG "SELECT gen_random_uuid()")
for pair in "$S_ALLOWED:$ALLOWED:$TECHVEIN" "$S_BLOCKED:$BLOCKED:$SCHOOL"; do
    IFS=: read -r sid from tid <<<"$pair"
    PG "INSERT INTO mail.api_send_envelopes (id, tenant_id, from_address) VALUES ('$sid', '$tid', '$from')" >/dev/null
done
hex() { printf '%s' "$1" | tr -d '-'; }
BOUNCE_ALLOWED="$(hex "$S_ALLOWED").k1.20362.0123456789abcdef@$BOUNCE_DOMAIN"
BOUNCE_BLOCKED="$(hex "$S_BLOCKED").k1.20362.0123456789abcdef@$BOUNCE_DOMAIN"
BOUNCE_NOSEND="$(hex "$(PG "SELECT gen_random_uuid()")").k1.20362.0123456789abcdef@$BOUNCE_DOMAIN"
same "an allowed mailbox passes"                      "$(gate "$ALLOWED")-"        "-"
same "a refused mailbox is internal_only (unchanged)" "$(gate "$BLOCKED")"         "internal_only"
same "...and so is its address in capitals (case is not a way round)" "$(gate "$(printf '%s' "$BLOCKED" | tr 'a-z' 'A-Z')")" "internal_only"
same "a bounce address for an ALLOWED mailbox's send passes" "$(gate "$BOUNCE_ALLOWED")-" "-"
same "a bounce address for a REFUSED mailbox's send is internal_only (THE GAP)" "$(gate "$BOUNCE_BLOCKED")" "internal_only"
same "a bounce-shaped address with no send behind it is refused (fails closed)" "$(gate "$BOUNCE_NOSEND")" "internal_only"
same "an address that is neither still passes to the next check (unchanged)" "$(gate "someone@elsewhere.example")-" "-"

step "B. End to end: the real send API, bounce tracking ON, through the gate"
# A key for each organisation, created as the console does (hash only). The
# stored form is MailApiKeyEndpoints.Sha256: "{SHA256}" + LOWERCASE hex. In
#   "{SHA256}" + Convert.ToHexString(...).ToLowerInvariant()
# the method call binds tighter than +, so only the hex is lowercased. This
# fixture got it wrong twice (uppercase hex, then a lowercased prefix) and every
# key answered 401 - which "all three sends reached the gate" below now catches.
mk_key() { # mk_key TENANT SENDER -> the key's plain text
    local secret="tvos_test_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
    PG "INSERT INTO mail.api_keys (tenant_id, label, key_hash, key_prefix, allowed_sender_addresses) VALUES ('$1', 'bounce gate test', '{SHA256}' || encode(sha256(convert_to('$secret', 'UTF8')), 'hex'), '${secret:0:12}', ARRAY['$2'])" >/dev/null
    printf '%s' "$secret"
}
KEY_TV=$(mk_key "$TECHVEIN" "$ALLOWED"); KEY_SC=$(mk_key "$SCHOOL" "$BLOCKED")
"$PY" "$HERE/tests/mail-api/gate-sink.py" "$SINK_PORT" "${TATVAOS_PSQL% -Atc} -At -c" "$WIRE" "$HERE" > "$SCRATCH/sink.out" 2>&1 &
SINK_PID=$!
for _ in $(seq 1 20); do grep -q READY "$WIRE" 2>/dev/null && break; sleep 0.5; done
grep -q READY "$WIRE" 2>/dev/null && pass "the stand-in gate is listening" || { fail "the stand-in gate did not start: $(tail -3 "$SCRATCH/sink.out")"; exit 1; }

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="$TDB_CONN" Smtp__Host=127.0.0.1 Smtp__Port="$SINK_PORT"
export Bounce__Domain="$BOUNCE_DOMAIN" Bounce__KeyId=k1 Bounce__Keys__k1="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up, bounce tracking configured" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

send() { # send KEY FROM TO -> HTTP code and body on one line
    curl -s -w " HTTP%{http_code}" -X POST "$API/api/v1/mail/send" -H "Authorization: Bearer $1" -H "Content-Type: application/json" \
         -d "{\"from\":\"$2\",\"to\":\"$3\",\"subject\":\"bounce gate test\",\"text\":\"hello\"}" | tr -d '\r\n'
}
R1=$(send "$KEY_TV" "$ALLOWED" "outside@example.com")
R2=$(send "$KEY_SC" "$BLOCKED" "outside@example.com")
R3=$(send "$KEY_SC" "$BLOCKED" "colleague@$LOCAL_DOMAIN")
printf '        Techvein -> outside: %s\n        School   -> outside: %s\n        School   -> inside:  %s\n' "${R1:0:160}" "${R2:0:160}" "${R3:0:160}"

# Two halves, because "no envelope that was NOT a bounce address" is also true
# when no mail arrived at all - the first run of this test passed it that way.
same "all three sends reached the gate"                       "$(grep -c '^MAIL ' "$WIRE")" "3"
same "...and every envelope sender was a bounce address (tracking on)" \
     "$(grep '^MAIL ' "$WIRE" | grep -v -c "@$BOUNCE_DOMAIN gate=")" "0"
same "Techvein (verified) can still send outside"        "$(PG "SELECT outcome FROM mail.api_sends WHERE from_address = '$ALLOWED' AND to_address = 'outside@example.com' AND subject = 'bounce gate test'")" "accepted"
same "ABC School (unverified) is REFUSED outside (THE GAP, end to end)" "$(PG "SELECT outcome FROM mail.api_sends WHERE from_address = '$BLOCKED' AND to_address = 'outside@example.com' AND subject = 'bounce gate test'")" "refused"
same "...with the gate's reason in the row"              "$(PG "SELECT count(*) FROM mail.api_sends WHERE from_address = '$BLOCKED' AND to_address = 'outside@example.com' AND subject = 'bounce gate test' AND error LIKE '%verified domain%'")" "1"
same "ABC School can still email inside the platform"    "$(PG "SELECT outcome FROM mail.api_sends WHERE from_address = '$BLOCKED' AND to_address = 'colleague@$LOCAL_DOMAIN'")" "accepted"
same "the gate found each send's envelope record at submit time (no fail-closed refusal for Techvein)" \
     "$(grep -c "RCPT outside@example.com -> 550" "$WIRE")" "1"

step "C. Append-only, for the app, on both tables"
priv() { PG "SELECT has_table_privilege('tatvaos_app', '$1', '$2')"; }
same "the app still cannot UPDATE mail.api_sends"             "$(priv mail.api_sends UPDATE)" "f"
same "the app can INSERT into mail.api_send_envelopes"        "$(priv mail.api_send_envelopes INSERT)" "t"
same "...and cannot UPDATE it"                                "$(priv mail.api_send_envelopes UPDATE)" "f"
same "...or DELETE from it"                                   "$(priv mail.api_send_envelopes DELETE)" "f"
same "the mail edge has no grant on it (it reads through the gate function)" \
     "$(PG "SELECT has_table_privilege('tatvaos_mailedge', 'mail.api_send_envelopes', 'SELECT')")" "f"
same "it is tenant-scoped: row level security on, and forced" \
     "$(PG "SELECT relrowsecurity::text || '/' || relforcerowsecurity::text FROM pg_class WHERE oid = 'mail.api_send_envelopes'::regclass")" "true/true"
same "each of the three sends has its envelope record, same id and sender" \
     "$(PG "SELECT count(*) FROM mail.api_sends s JOIN mail.api_send_envelopes e ON e.id = s.id AND e.from_address = s.from_address WHERE s.subject = 'bounce gate test'")" "3"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi

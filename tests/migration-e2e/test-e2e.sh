#!/usr/bin/env bash
#
# THE GOOGLE MIGRATION, END TO END, AS AN ADMINISTRATOR RUNS IT.
#
# The real API (Release build) with the real runner, TatvaOS's Google key in a
# FILE, the Dovecot master login ON, and a fake Google (fake_google.py) for
# everything Google would answer. Over HTTP, signed in as Techvein's owner:
#
#   setup      configured, our client ID, the read-only scopes
#   grant      refused when Google refuses (unauthorized_client) and when the
#              admin is outside the domain - nothing recorded; then granted,
#              after the directory was listed as the admin; twice refused
#   estimate   refused before a grant; then per-person sizes and a verdict
#   enrol      everyone in the directory, matched to TatvaOS people
#   start      ONE person first
#   progress   that person's four jobs complete; mail in Dovecot (as the
#              person, through the master login), a contact in their book
#   catch-up   a message that arrives in Gmail afterwards, brought on request
#   revoke     unfinished jobs cancelled; nothing can start afterwards
#   and        an employee is refused every step
#
# Needs: the local stack (Postgres for a throwaway database, Dovecot on 1143),
# a Release build of apps/api, python3, openssl. Leaves the master login OFF
# and removes its Dovecot folders, pass or fail. Exit 0 pass, 1 fail, 2 could not run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
DLL="$HERE/apps/api/bin/Release/net10.0/TatvaOS.Api.dll"
[ -f "$DLL" ] || { echo "  no build at $DLL - run: dotnet build apps/api -c Release"; exit 2; }
API_PORT="${E2E_API_PORT:-5094}"; FAKE_PORT="${E2E_FAKE_PORT:-5095}"
API="http://localhost:$API_PORT"; FAKE="http://127.0.0.1:$FAKE_PORT"
RUN=$(date +%s); ROOT="E2E-$RUN"
SCRATCH="$(mktemp -d)"; chmod 700 "$SCRATCH"; mkdir -p "$SCRATCH/vmail" "$SCRATCH/blobs"
AMIT=d1111111-1111-1111-1111-111111111111; HR=d1111111-1111-1111-1111-111111111112

# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
tdb_create e2e || exit 2
PG() { $TATVAOS_PSQL "$1" 2>&1 | tr -d "\r" | tail -n1; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"; else fail "$1 - got [$2], wanted [$3]"; fi
}
J() { python3 -c "import sys,json; d=json.loads(sys.stdin.read() or 'null'); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
call() { # call METHOD PATH TOKEN [BODY] -> "status body"
    curl -s -o "$SCRATCH/body" -w "%{http_code}" -X "$1" "$API/api/org/migration$2" \
         -H "Authorization: Bearer $3" -H 'Content-Type: application/json' ${4:+-d "$4"}
    printf ' '; cat "$SCRATCH/body"
}
st() { printf '%s' "$1" | cut -d' ' -f1; }
bd() { printf '%s' "$1" | cut -d' ' -f2-; }
imap_ids() { # imap_ids FOLDER -> sorted Message-ID stems in $ROOT/FOLDER (amit, dev password)
    python3 - "$ROOT/$1" <<'PY'
import imaplib, sys, re
c = imaplib.IMAP4("localhost", 1143); c.login("amit@techvein.local", "devpass123")
typ, _ = c.select('"%s"' % sys.argv[1], readonly=True)
if typ != "OK": print("(no folder)"); sys.exit()
_, data = c.search(None, "ALL"); ids = []
for n in data[0].split():
    _, h = c.fetch(n, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
    m = re.search(rb"<([^@>]+)@", h[0][1]); ids.append(m.group(1).decode() if m else "?")
print(",".join(sorted(ids)) or "(empty)"); c.logout()
PY
}

API_PID=""; FAKE_PID=""
cleanup() {
    [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null; [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
    wait 2>/dev/null
    "$HERE/infra/scripts/migration-master.sh" off >/dev/null 2>&1
    python3 - "$ROOT" <<'PY' 2>/dev/null
import imaplib, sys
c = imaplib.IMAP4("localhost", 1143); c.login("amit@techvein.local", "devpass123")
_, boxes = c.list('""', '"%s*"' % sys.argv[1])
for name in sorted((b.decode().rsplit(' "/" ', 1)[-1].strip('"') for b in boxes if b), key=len, reverse=True):
    c.delete('"%s"' % name)
c.logout()
PY
    tdb_drop
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  Google migration, end to end\n  tree under test: %s%s\n  database: %s\n" "$(git -C "$HERE" rev-parse HEAD)" \
    "$(git -C "$HERE" diff --quiet HEAD || echo ' (+ UNCOMMITTED CHANGES - not a proof of any commit)')" "$TDB_NAME"

# ---- TatvaOS's (test) Google key, the master login, the fake Google ---------
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$SCRATCH/k.pem" 2>/dev/null
FAKE="$FAKE" python3 -c "
import json, os; pem = open('$SCRATCH/k.pem').read()
json.dump({'type':'service_account','client_email':'tatvaos-migration@test.iam.gserviceaccount.com','client_id':'1234567890',
           'private_key':pem,'token_uri':os.environ['FAKE'] + '/token'}, open('$SCRATCH/key.json','w'))"
rm -f "$SCRATCH/k.pem"; chmod 600 "$SCRATCH/key.json"
"$HERE/infra/scripts/migration-master.sh" on >/dev/null
docker exec "${DOVECOT_CONTAINER:-tv-dovecot}" cat /etc/dovecot/migration/master.password > "$SCRATCH/master.password"; chmod 600 "$SCRATCH/master.password"
python3 "$HERE/tests/migration-e2e/fake_google.py" "$FAKE_PORT" & FAKE_PID=$!

(cd "$(dirname "$DLL")" && JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development \
  ASPNETCORE_URLS="$API" ConnectionStrings__Postgres="$TDB_CONN" Oidc__KeyDirectory="$SCRATCH/keys" \
  Migration__Runner=on Migration__TickSeconds=1 Migration__LeaseSeconds=15 \
  Migration__Google__KeyFile="$SCRATCH/key.json" Migration__Google__ApiBase="$FAKE/" \
  Migration__Imap__Host=localhost Migration__Imap__Port=1143 Migration__Imap__MasterPasswordFile="$SCRATCH/master.password" \
  Migration__Mail__FolderRoot="$ROOT" Mail__VmailRoot="$SCRATCH/vmail" Space__BlobRoot="$SCRATCH/blobs" \
  exec dotnet "$DLL") > "$SCRATCH/api.log" 2>&1 & API_PID=$!
for _ in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 || { fail "API did not start: $(tail -5 "$SCRATCH/api.log")"; exit 1; }

signin() { # USER_ID PHONE ROLE -> access token
    PG "UPDATE core.users SET phone='$2', role='$3', status='active', login_otp_sent_at=NULL WHERE id='$1'" >/dev/null
    local c; c=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$2\"}" | J "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"$2\",\"code\":\"$c\"}" | J "d.get('accessToken') or ''"
}
OWNER=$(signin $AMIT +919999900431 org_owner); EMP=$(signin $HR +919999900432 employee)
[ -n "$OWNER" ] && [ -n "$EMP" ] && pass "signed in: Techvein's owner and an employee" || { fail "could not sign in"; exit 1; }

step "setup"
r=$(call GET /setup "$OWNER")
same "configured, with our client ID" "$(bd "$r" | J "str(d['configured']) + ' ' + str(d['clientId'])")" "True 1234567890"
same "...and the five read-only scopes to authorise" "$(bd "$r" | J "len(d['scopes'])")" "5"
same "an employee is refused" "$(st "$(call GET /setup "$EMP")")" "403"

step "grant"
r=$(call POST /estimate "$OWNER" '{}')
same "estimate before a grant: refused" "$(st "$r")" "409"
r=$(call POST /grant "$OWNER" '{"googleDomain":"techvein.local","googleAdmin":"nogrant@techvein.local"}')
same "Google refuses (unauthorized_client): 400" "$(st "$r")" "400"
case "$(bd "$r")" in *"Admin console"*) pass "...saying where to grant it";; *) fail "no Admin console instructions: $(bd "$r")";; esac
same "...and nothing recorded" "$(PG "SELECT count(*) FROM migration.grants")" "0"
same "an admin outside the domain: 400" "$(st "$(call POST /grant "$OWNER" '{"googleDomain":"techvein.local","googleAdmin":"x@elsewhere.test"}')")" "400"
r=$(call POST /grant "$OWNER" '{"googleDomain":"techvein.local","googleAdmin":"amit@techvein.local"}')
same "granted, after listing the directory as the admin (three people)" "$(st "$r") $(bd "$r" | J "d['peopleListed']")" "200 3"
same "one active grant, for this key's client ID" "$(PG "SELECT count(*) || ' ' || min(client_id) FROM migration.grants WHERE revoked_at IS NULL")" "1 1234567890"
same "...in the audit log" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action = 'migration.google_granted'")" "1"
same "granting twice: 409" "$(st "$(call POST /grant "$OWNER" '{"googleDomain":"techvein.local","googleAdmin":"amit@techvein.local"}')")" "409"

step "estimate"
r=$(call POST /estimate "$OWNER" '{}')
same "three people measured; 2 MiB of mail each (usage - usageInDrive)" "$(st "$r") $(bd "$r" | J "str(len(d['people'])) + ' ' + str(d['mailBytes'])")" "200 3 6291456"
case "$(bd "$r" | J "d['verdict']['state']")" in fits|refused|incomplete) pass "a verdict: $(bd "$r" | J "d['verdict']['state']")";; *) fail "no verdict: $(bd "$r")";; esac

step "enrol, and start ONE person"
r=$(call POST /enrol "$OWNER" '{}')
same "enrolled: 3 people x 4 types, 2 matched, ghost not" "$(bd "$r" | J "f\"{d['jobsCreated']} {d['matched']} {','.join(d['unmatched'])}\"")" "12 2 ghost@techvein.local"
same "every job planned - nothing started by enrolling" "$(PG "SELECT string_agg(DISTINCT state, ',') FROM migration.jobs")" "planned"
r=$(call POST /start "$OWNER" '{"people":["amit@techvein.local"]}')
same "started amit's four jobs" "$(bd "$r" | J "d['jobsStarted']")" "4"

step "the runner does amit's migration"
for _ in $(seq 1 120); do
    [ "$(PG "SELECT count(*) FROM migration.jobs WHERE source_user='amit@techvein.local' AND state='completed'")" = "4" ] && break; sleep 1
done
same "amit's four jobs completed" "$(PG "SELECT string_agg(data_type || '=' || state, ',' ORDER BY data_type) FROM migration.jobs WHERE source_user='amit@techvein.local'")" \
    "calendar=completed,contacts=completed,drive=completed,mail=completed"
same "hr's jobs untouched (one person first)" "$(PG "SELECT string_agg(DISTINCT state, ',') FROM migration.jobs WHERE source_user='hr@techvein.local'")" "planned"
same "mail: both messages written" "$(PG "SELECT items_done FROM migration.jobs WHERE source_user='amit@techvein.local' AND data_type='mail'")" "2"
same "...INBOX in Dovecot, through the master login" "$(imap_ids INBOX)" "e2e-one"
same "...Sent in Dovecot" "$(imap_ids Sent)" "e2e-two"
same "contacts: the supplier is in amit's own book" "$(PG "SELECT count(*) FROM family.contacts WHERE owner_user_id='$AMIT' AND display_name='E2E Supplier'")" "1"
r=$(call GET /people "$OWNER")
same "progress: amit's mail completed, 2 done" "$(bd "$r" | J "[f\"{t['state']} {t['itemsDone']}\" for p in d['people'] if p['googleAddress']=='amit@techvein.local' for t in p['types'] if t['dataType']=='mail'][0]")" "completed 2"
grep -q "Google access used for organisation" "$SCRATCH/api.log" && pass "every use of the key is logged (organisation and account)" || fail "no key-use log line"
grep -q "BEGIN PRIVATE KEY\|ya29.fake" "$SCRATCH/api.log" && fail "the key or a token reached the API log" || pass "neither the key nor a token in the API log"

step "catch-up: mail that arrived in Gmail afterwards"
curl -s -X POST "$FAKE/_arrive?id=e3&mid=e2e-three" >/dev/null
r=$(call POST /catch-up "$OWNER" '{}')
same "amit's mail re-queued" "$(bd "$r" | J "','.join(d['queued'])")" "amit@techvein.local"
for _ in $(seq 1 60); do
    [ "$(PG "SELECT state || items_done FROM migration.jobs WHERE source_user='amit@techvein.local' AND data_type='mail'")" = "completed3" ] && break; sleep 1
done
same "...completed again with one more" "$(PG "SELECT state || ' ' || items_done FROM migration.jobs WHERE source_user='amit@techvein.local' AND data_type='mail'")" "completed 3"
same "...the new message is in INBOX, the old ones once" "$(imap_ids INBOX)" "e2e-one,e2e-three"

step "revoke"
r=$(call POST /revoke "$OWNER" '{}')
same "hr's and ghost's eight unfinished jobs cancelled" "$(bd "$r" | J "d['jobsCancelled']")" "8"
case "$(bd "$r")" in *"Manage domain-wide delegation"*) pass "...and the admin is told how to remove it in Google";; *) fail "no removal instructions";; esac
same "amit's finished jobs stay finished" "$(PG "SELECT string_agg(DISTINCT state, ',') FROM migration.jobs WHERE source_user='amit@techvein.local'")" "completed"
same "starting anything now: 409" "$(st "$(call POST /start "$OWNER" '{}')")" "409"
same "the runner sees no organisation to work for" "$(PG "SELECT count(*) FROM migration.job_tenants()")" "0"
same "an employee is refused the progress page" "$(st "$(call GET /people "$EMP")")" "403"
grep -q "Migration sweep failed" "$SCRATCH/api.log" && fail "the runner logged a sweep failure" || pass "the runner logged no sweep failure"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks   (database %s)\n\n" "$PASSED" "$TDB_NAME"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi

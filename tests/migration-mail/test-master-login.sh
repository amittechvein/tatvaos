#!/usr/bin/env bash
#
# The migration MASTER login on the real local Dovecot (decision 0019 §2):
# off by default, on and off by infra/scripts/migration-master.sh, refusing
# what it must, and NOT breaking anybody's normal login - including after a
# cold restart, the failure the app-password passdb once caused.
#
# Needs the local stack. Leaves the master login OFF, pass or fail.
# The password is copied from the container into a 0600 temp file; it is
# never printed. Exit 0 pass, 1 fail, 2 could not run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
C="${DOVECOT_CONTAINER:-tv-dovecot}"; HOST=localhost; PORT=1143
PERSON=amit@techvein.local; PASS="${MAIL_PASS:-devpass123}"
TMP="$(mktemp -d)"; chmod 700 "$TMP"; PWF="$TMP/master.password"
cleanup() { DOVECOT_CONTAINER="$C" "$HERE/infra/scripts/migration-master.sh" off >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
# login USER PASSWORD-FILE -> OK | NO (password read from a file, never argv)
login() {
    python3 - "$1" "$2" <<'PY'
import imaplib, sys
user, pwfile = sys.argv[1], sys.argv[2]
pw = open(pwfile).read().strip()
try:
    c = imaplib.IMAP4("localhost", 1143); c.login(user, pw); c.logout(); print("OK")
except imaplib.IMAP4.error: print("NO")
except Exception as e: print("ERR " + type(e).__name__)
PY
}
expect() { local got; got="$(login "$2" "$3")"; [ "$got" = "$4" ] && pass "$1  [got $got]" || fail "$1 - got [$got], wanted [$4]"; }
printf '%s' "$PASS" > "$TMP/person.password"; printf 'not-the-password' > "$TMP/wrong"

printf "\n  Migration master login\n  tree under test: %s\n" "$(git -C "$HERE" rev-parse HEAD)"
docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "  $C is not running"; exit 2; }
"$HERE/infra/scripts/migration-master.sh" off >/dev/null

printf "\n>> off (as installed)\n"
expect "the person's own login works" "$PERSON" "$TMP/person.password" OK
expect "a master login is refused" "$PERSON*migration" "$TMP/wrong" NO

printf "\n>> on\n"
"$HERE/infra/scripts/migration-master.sh" on >/dev/null
docker exec "$C" cat /etc/dovecot/migration/master.password > "$PWF"; chmod 600 "$PWF"
[ -s "$PWF" ] && pass "the password file is there for the API" || fail "no master.password after on"
expect "a master login with the master password works" "$PERSON*migration" "$PWF" OK
expect "...with a wrong password, refused" "$PERSON*migration" "$TMP/wrong" NO
expect "...to a mailbox that does not exist, refused (pass = yes)" "nobody@techvein.local*migration" "$PWF" NO
expect "the person's own login still works" "$PERSON" "$TMP/person.password" OK
mode=$(docker exec "$C" stat -c '%a %u' /etc/dovecot/migration/master.password)
[ "$mode" = "400 5000" ] && pass "the password file is 0400, owned by the API's uid  [got $mode]" || fail "password file mode/owner: [$mode], wanted [400 5000]"

printf "\n>> the Gmail-to-Dovecot test, signed in as the master user\n"
if MAIL_MASTER_FILE="$PWF" dotnet run --project "$HERE/tests/migration-mail" > "$TMP/mail.log" 2>&1; then
    pass "tests/migration-mail passes through the master login ($(grep -o 'PASS  [0-9]* checks' "$TMP/mail.log"))"
else fail "tests/migration-mail failed through the master login: $(grep -m3 FAIL "$TMP/mail.log" | tr '\n' ' ')"; fi
grep -q "signing in as the migration MASTER user" "$TMP/mail.log" && pass "...and it really signed in as the master user" || fail "the mail test did not use the master login"

printf "\n>> off again, and a cold restart\n"
"$HERE/infra/scripts/migration-master.sh" off >/dev/null
expect "the master login is refused again" "$PERSON*migration" "$PWF" NO
docker restart "$C" >/dev/null; sleep 6
expect "after a cold restart, the person's own login works" "$PERSON" "$TMP/person.password" OK
docker logs --since 30s "$C" 2>&1 | grep -q "migration master login: off" && pass "...and Dovecot says the master login is off" || fail "Dovecot did not report the master login state at start"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi

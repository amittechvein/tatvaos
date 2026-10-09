#!/usr/bin/env bash
#
# infra/scripts/maildir-removals.sh --domain: one deleted organisation's mail
# folder, removed by the mail server's tool, by hand (Mr. Singh, 29 Sept 2026).
#
# The Docker calls are swapped for a local tree laid out like /var/mail/vhosts
# (MR_VMAIL_ROOT) and tests/personal-maildir-removal/fake-doveadm.sh; the
# database side is the real one, against the local tatvaos_mail database,
# which needs PR 353's migration (core.organisation_deletions,
# core.domain_mail_held).
#
# Proved:
#   1. REFUSED, nothing touched: no domain, an empty one, a blank one, "..",
#      "../<another customer>", "<x>/..", "/", "-rf", upper case
#   2. REFUSED: a domain registered again (its folder is somebody's new mail)
#   3. REFUSED: a domain no deletion holds
#   4. REFUSED: a domain whose folder holds something that is not an address
#   5. REFUSED: a "folder" that is a file
#   6. --dry-run: every check, the exact path, the exact commands; nothing changed
#   7. the tool "succeeds" but files remain: folder kept, domain still held
#   8. removed: messages via doveadm, then the folder; another customer's
#      domain untouched; the domain released; the record done only when ALL
#      its domains are; each held address on the removed domain is recorded
#      as 0 files (so an operator may release it), another customer's never;
#      only on the run's own evidence (step 10 c/d: files stuck -> not counted)
#   9. never from cron; one rm -rf in the file, with "--"
#  11. on a server (infra/docker/.env present) every test hook is ignored
#  10. RED FIRST: copies of the job with one guard cut — the name guard (the
#      empty and ".." cases are no longer refused at the name) and the
#      database guard (the registered-again domain's folder IS removed)
#
#   bash tests/org-maildir-removal/test-domain-removal.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

RUN=$(date +%s)
SCR=".tmp/dr-$$"
export MR_VMAIL_ROOT="$SCR/store/vhosts"          # deep, so its parent is scratch too
export TATVAOS_VMAIL="$MR_VMAIL_ROOT"
export MR_PSQL="${TATVAOS_MR_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_mail -Atq -v ON_ERROR_STOP=1}"
PSQLC="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_mail -Atc}"
export MR_EXPUNGE="bash tests/personal-maildir-removal/fake-doveadm.sh expunge"
export MR_COUNT="bash tests/personal-maildir-removal/fake-doveadm.sh count"
export MR_DOVECOT=tatvaos-dovecot-1
export MR_FAKE_LOG="$SCR/fake.log"
JOB=infra/scripts/maildir-removals.sh

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has()   { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$(printf '%s' "$2" | head -c 300)]"; fi; }
hasnt() { if [ -z "$2" ]; then fail "$1 — nothing to look in"; elif printf '%s' "$2" | grep -qF -- "$3"; then fail "$1 — '$3' FOUND"; else pass "$1"; fi; }
PG() { $PSQLC "$1" 2>/dev/null | tr -d '\r'; }
there() { if [ -e "$2" ]; then pass "$1"; else fail "$1 — gone: $2"; fi; }
gone()  { if [ -e "$2" ]; then fail "$1 — STILL there: $2"; else pass "$1"; fi; }
allfiles() { find "$SCR/store" -type f | wc -l | tr -d ' '; }
expunges() { [ -f "$MR_FAKE_LOG" ] && grep -c '^expunge' "$MR_FAKE_LOG" || echo 0; }
mail() { # domain local n
    mkdir -p "$MR_VMAIL_ROOT/$1/$2/cur" "$MR_VMAIL_ROOT/$1/$2/new"
    for i in $(seq 1 "$3"); do printf 'Subject: %s %s\n\nx\n' "$2" "$i" > "$MR_VMAIL_ROOT/$1/$2/cur/$RUN.$i.eml"; done
    printf 'index' > "$MR_VMAIL_ROOT/$1/$2/dovecot.index"   # not a message: removed with the folder
}

D="dr-$RUN.test"; D2="dr2-$RUN.test"; D3="dr3-$RUN.test"; D4="dr4-$RUN.test"; OTHER="other-$RUN.test"
REG="reg-$RUN.test"; NP="np-$RUN.test"; BAD="bad-$RUN.test"; FILE="file-$RUN.test"
NAME="Domain removal test $RUN"
TECHVEIN="11111111-1111-1111-1111-111111111111"
cleanup() {
    PG "DELETE FROM core.organisation_deletions WHERE name LIKE '$NAME%'" >/dev/null
    PG "DELETE FROM core.retired_addresses WHERE address LIKE '%-$RUN.test'" >/dev/null
    PG "SET session_replication_role = replica; DELETE FROM core.domains WHERE fqdn = '$REG'" >/dev/null
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCR"; else printf "  kept for reading: %s\n" "$SCR"; fi
}
trap cleanup EXIT

step "0. The database has organisation deletions; the tree is laid out"
same "core.domain_mail_held exists (PR 353's migration)" "$(PG "SELECT count(*) FROM pg_proc WHERE proname='domain_mail_held'")" "1"
mkdir -p "$MR_VMAIL_ROOT"
mail "$D" hr 3; mail "$D" principal 2; mail "$D2" a1 1
mail "$OTHER" keep 2
mail "$D3" lost 2; mail "$D4" lost 2      # for step 10 (c) and (d)
mail "$REG" x 1; mail "$NP" y 1
mail "$BAD" ok 1; mkdir -p "$MR_VMAIL_ROOT/$BAD/.hidden"
printf 'not a folder' > "$MR_VMAIL_ROOT/$FILE"
# Record 1: two domains (the record is done only when both are). Record 2:
# the rest. OTHER is in no record: another customer's mail.
PG "INSERT INTO core.organisation_deletions (tenant_id, name, deleted_by, deleted_by_email, domains, mail_dirs_pending)
    VALUES (gen_random_uuid(), '$NAME 1', gen_random_uuid(), 'test@tatvaos.test', ARRAY['$D','$D2'], ARRAY['$D','$D2'])" >/dev/null
PG "INSERT INTO core.organisation_deletions (tenant_id, name, deleted_by, deleted_by_email, domains, mail_dirs_pending)
    VALUES (gen_random_uuid(), '$NAME 2', gen_random_uuid(), 'test@tatvaos.test', ARRAY['$REG','$BAD','$FILE'], ARRAY['$REG','$BAD','$FILE'])" >/dev/null
# Registered again: the trigger refuses this while the domain is held, which
# is the point; the fixture turns triggers off to make the state the guard
# exists for.
PG "INSERT INTO core.organisation_deletions (tenant_id, name, deleted_by, deleted_by_email, domains, mail_dirs_pending)
    VALUES (gen_random_uuid(), '$NAME 3', gen_random_uuid(), 'test@tatvaos.test', ARRAY['$D3','$D4'], ARRAY['$D3','$D4'])" >/dev/null
PG "SET session_replication_role = replica; INSERT INTO core.domains (tenant_id, fqdn, type) VALUES ('$TECHVEIN', '$REG', 'alias')" >/dev/null
same "the registered-again domain is in core.domains" "$(PG "SELECT count(*) FROM core.domains WHERE fqdn='$REG'")" "1"
same "D is held" "$(PG "SELECT core.domain_mail_held('$D')")" "t"
# Held addresses, uncounted, as deleting the organisation leaves them. OTHER's
# belongs to another customer and must never be counted by D's removal.
for a in "hr@$D" "principal@$D" "a1@$D2" "keep@$OTHER" "lost@$D3" "lost@$D4"; do
    # 'mailbox_deleted' is what deleting an organisation writes; source is a
    # fixed list (a made-up value is refused, and PG() hides the refusal).
    PG "INSERT INTO core.retired_addresses (address, source) VALUES ('$a', 'mailbox_deleted')" >/dev/null
done
uncounted() { PG "SELECT count(*) FROM core.retired_addresses WHERE address LIKE '%@$1' AND files_checked_at IS NULL"; }
counted0()  { PG "SELECT count(*) FROM core.retired_addresses WHERE address LIKE '%@$1' AND files_left = 0 AND files_checked_at IS NOT NULL"; }
same "four held addresses, none counted" "$(uncounted "$D")/$(uncounted "$D2")/$(uncounted "$OTHER")" "2/1/1"
N0=$(allfiles)
[ "${N0:-0}" -ge 15 ] && pass "$N0 files in the tree" || fail "the tree was not built ($N0 files)"

step "1. Not a plain domain name: REFUSED before anything else"
out=$(bash "$JOB" --domain 2>&1); rc=$?
same "no domain at all: exit 2" "$rc" "2"; has "…refused at the name" "$out" "not one plain domain name"
for bad in "" " " ".." "../$OTHER" "$OTHER/.." "/" "-rf" "DR-$RUN.TEST" ".$D" "$D/hr"; do
    out=$(bash "$JOB" --domain "$bad" 2>&1); rc=$?
    same "[$bad]: exit 2" "$rc" "2"; has "  …refused at the name" "$out" "not one plain domain name"
done
same "not one file touched by any of that" "$(allfiles)" "$N0"
same "doveadm was never called" "$(expunges)" "0"

step "2-5. The other refusals"
out=$(bash "$JOB" --domain "$REG" 2>&1); rc=$?
same "registered again: exit 2" "$rc" "2"; has "…REGISTERED AGAIN" "$out" "REGISTERED AGAIN"
there "…its folder is untouched" "$MR_VMAIL_ROOT/$REG/x/cur/$RUN.1.eml"
out=$(bash "$JOB" --domain "$NP" 2>&1); rc=$?
same "held by no deletion: exit 2" "$rc" "2"; has "…not held" "$out" "not held by an organisation deletion"
out=$(bash "$JOB" --domain "$OTHER" 2>&1); rc=$?
same "another customer's domain (no record): exit 2" "$rc" "2"; has "…not held" "$out" "not held by an organisation deletion"
out=$(bash "$JOB" --domain "$BAD" 2>&1); rc=$?
same "a folder inside that is not an address: exit 2" "$rc" "2"; has "…named" "$out" "is not a plain address folder"
there "…and its mail is untouched" "$MR_VMAIL_ROOT/$BAD/ok/cur/$RUN.1.eml"
out=$(bash "$JOB" --domain "$FILE" 2>&1); rc=$?
same "a 'folder' that is a file: exit 2" "$rc" "2"; has "…not a plain folder" "$out" "is not a plain folder"
same "still not one file touched" "$(allfiles)" "$N0"
same "doveadm still never called" "$(expunges)" "0"

step "6. --dry-run: the exact path and commands; nothing changed"
out=$(bash "$JOB" --domain "$D" --dry-run 2>&1); rc=$?
same "exit 0" "$rc" "0"
ROOT_REAL=$(realpath -e -- "$MR_VMAIL_ROOT")
has  "prints the exact path" "$out" "the path, exactly: $ROOT_REAL/$D"
has  "prints the doveadm command for hr@" "$out" "doveadm expunge -u hr@$D mailbox"
has  "…and for principal@" "$out" "doveadm expunge -u principal@$D mailbox"
has  "prints the removal it would make" "$out" "rm -rf -- $ROOT_REAL/$D"
has  "counts what is there" "$out" "2 address folder(s), 5 message file(s)"
same "nothing changed on disk" "$(allfiles)" "$N0"
same "doveadm not called" "$(expunges)" "0"
same "still held" "$(PG "SELECT core.domain_mail_held('$D')")" "t"

step "7. The tool says it worked, but files remain"
out=$(MR_FAKE_STUCK=1 bash "$JOB" --domain "$D" 2>&1); rc=$?
same "exit 3 (not done)" "$rc" "3"; has "…says how many remain" "$out" "5 message file(s) remain"
there "the folder is kept" "$MR_VMAIL_ROOT/$D/hr/cur/$RUN.1.eml"
same "the domain stays held" "$(PG "SELECT core.domain_mail_held('$D')")" "t"
same "…and its addresses are NOT counted as empty" "$(uncounted "$D")" "2"

step "8. Removed"
: > "$MR_FAKE_LOG"
out=$(bash "$JOB" --domain "$D" 2>&1); rc=$?
same "exit 0" "$rc" "0"; has "…says so" "$out" "done domain [$D]"
same "doveadm ran once per address, two" "$(expunges)" "2"
gone  "the domain's folder is gone, index files and all" "$MR_VMAIL_ROOT/$D"
there "another customer's mail is untouched" "$MR_VMAIL_ROOT/$OTHER/keep/cur/$RUN.2.eml"
there "the second domain of the same organisation is untouched" "$MR_VMAIL_ROOT/$D2/a1/cur/$RUN.1.eml"
there "the store itself is there" "$MR_VMAIL_ROOT"
same "D is released" "$(PG "SELECT core.domain_mail_held('$D')")" "f"
same "D2 is still held" "$(PG "SELECT core.domain_mail_held('$D2')")" "t"
same "the record is not done while D2 remains" "$(PG "SELECT (mail_dirs_purged_at IS NULL)::text FROM core.organisation_deletions WHERE name='$NAME 1'")" "true"
same "D's two held addresses are counted: 0 files, so an operator may release them" "$(counted0 "$D")" "2"
same "…D2's is not counted yet (its folder is still there)" "$(uncounted "$D2")" "1"
same "…another customer's is untouched" "$(uncounted "$OTHER")" "1"
out=$(bash "$JOB" --domain "$D" 2>&1); rc=$?
same "D again: exit 2" "$rc" "2"; has "…no longer held" "$out" "not held by an organisation deletion"
out=$(bash "$JOB" --domain "$D2" 2>&1); rc=$?
same "D2: exit 0" "$rc" "0"
same "now the record is done" "$(PG "SELECT mail_dirs_purged_by FROM core.organisation_deletions WHERE name='$NAME 1'")" "maildir-removals.sh"
same "…and D2's held address is counted too" "$(counted0 "$D2")" "1"
same "…another customer's, still untouched" "$(uncounted "$OTHER")" "1"
there "another customer's mail, still" "$MR_VMAIL_ROOT/$OTHER/keep/cur/$RUN.1.eml"

step "9. Never from cron; one removal in the file"
cronline=$(grep -F 'LINE="*/15' "$JOB")
hasnt "the cron line passes no --domain" "$cronline" "--domain"
CODE=$(grep -v '^[[:space:]]*#' "$JOB")
same "rm -rf in the job's code: the removal, and the dry run's printout of it" "$(printf '%s
' "$CODE" | grep -c 'rm -rf' | tr -d ' ')" "2"
same "…every one followed by --" "$(printf '%s
' "$CODE" | grep 'rm -rf' | grep -vc 'rm -rf --' | tr -d ' ')" "0"

step "10. RED FIRST: the same cases against the job with a guard cut out"
# (a) the name guard. The empty domain and ".." must now get PAST the name.
sed 's/if ! one_domain "\$D"; then/if false; then/' "$JOB" > "$SCR/job-no-name.sh"
grep -q 'if false; then' "$SCR/job-no-name.sh" && pass "(a) copy made with the name guard cut" || fail "(a) the cut did not apply"
for bad in "" ".."; do
    out=$(bash "$SCR/job-no-name.sh" --domain "$bad" 2>&1)
    hasnt "(a) [$bad] is no longer refused at the name — so section 1's check would go red" "$out" "not one plain domain name"
done
# (b) the database guard. The registered-again domain's folder is REMOVED.
sed 's/if \[ "\$dwhy" != "ok" \]; then say "REFUSED domain/if false; then say "REFUSED domain/' "$JOB" > "$SCR/job-no-db.sh"
grep -q 'if false; then say "REFUSED domain' "$SCR/job-no-db.sh" && pass "(b) copy made with the database guard cut" || fail "(b) the cut did not apply"
bash "$SCR/job-no-db.sh" --domain "$REG" >/dev/null 2>&1
gone "(b) without it, the registered-again domain's mail IS removed — so section 2's check would go red" "$MR_VMAIL_ROOT/$REG"
there "(b) …another customer's mail, even so" "$MR_VMAIL_ROOT/$OTHER/keep/cur/$RUN.1.eml"
# (c) Mr. Singh on #437: counting held addresses as empty must rest on this
# run's own evidence, not on the mode having run. Cut the "files remain" exit,
# leave files stuck: the folder is then removed with mail still counted in it,
# and the addresses must STILL not be counted.
sed '/message file(s) remain after doveadm; the folder stays/s/; exit 3$//' "$JOB" > "$SCR/job-no-stop.sh"
grep -q 'the domain stays held"$' "$SCR/job-no-stop.sh" && pass "(c) copy made with the files-remain exit cut" || fail "(c) the cut did not apply"
MR_FAKE_STUCK=1 bash "$SCR/job-no-stop.sh" --domain "$D3" >/dev/null 2>&1
same "(c) files were stuck: D3's held address is NOT counted, even with the exit cut" "$(uncounted "$D3")" "1"
# (d) ...and that check can go red: the same copy with the evidence guard
# forced on counts it.
sed 's/^    VERIFIED_EMPTY=0$/    VERIFIED_EMPTY=1/' "$SCR/job-no-stop.sh" > "$SCR/job-no-guard.sh"
grep -q '^    VERIFIED_EMPTY=1$' "$SCR/job-no-guard.sh" && pass "(d) copy made with the evidence guard forced on" || fail "(d) the cut did not apply"
MR_FAKE_STUCK=1 bash "$SCR/job-no-guard.sh" --domain "$D4" >/dev/null 2>&1
same "(d) without the guard, D4's address IS counted with mail stuck — so (c) would go red" "$(counted0 "$D4")" "1"


step "11. On a server the test hooks are ignored (Mr. Singh, 30 Sept)"
# A server's checkout has infra/docker/.env; a test's never does. Build a
# checkout that looks like a server's — the job, and that file — and run it
# with every hook set, pointing at a copy of this run's tree.
# Its own domain, still held: the earlier ones have been released by now.
D3="dr3-$RUN.test"
PG "INSERT INTO core.organisation_deletions (tenant_id, name, deleted_by, deleted_by_email, domains, mail_dirs_pending)
    VALUES (gen_random_uuid(), '$NAME 3', gen_random_uuid(), 'test@tatvaos.test', ARRAY['$D3'], ARRAY['$D3'])" >/dev/null
same "the step's domain is held" "$(PG "SELECT core.domain_mail_held('$D3')")" "t"
check_prodlike() { # job-file label
    local P="$SCR/prodlike-$2" out
    mkdir -p "$P/infra/scripts" "$P/infra/docker" "$P/store"
    cp "$1" "$P/infra/scripts/maildir-removals.sh"
    : > "$P/infra/docker/.env"
    cp -r "$MR_VMAIL_ROOT" "$P/store/vhosts"
    mkdir -p "$P/store/vhosts/$D3/a1/cur"; printf 'x' > "$P/store/vhosts/$D3/a1/cur/prod.eml"
    out=$(MR_VMAIL_ROOT="$(realpath -- "$P/store/vhosts")" bash "$P/infra/scripts/maildir-removals.sh" --domain "$D3" --dry-run 2>&1)
    printf '%s' "$out"
}
out=$(check_prodlike "$JOB" now)
has   "MR_VMAIL_ROOT is ignored, and the log says so" "$out" "IGNORED MR_VMAIL_ROOT"
has   "MR_PSQL is ignored" "$out" "IGNORED MR_PSQL"
has   "MR_EXPUNGE is ignored" "$out" "IGNORED MR_EXPUNGE"
has   "MR_COUNT is ignored" "$out" "IGNORED MR_COUNT"
has   "MR_DOVECOT is ignored" "$out" "IGNORED MR_DOVECOT"
hasnt "…so the dry run never reaches the tree the hook pointed at" "$out" "the path, exactly:"
has   "…it looks for the real containers instead, and stops without them" "$out" "need both containers running"
there "…and that tree is untouched" "$SCR/prodlike-now/store/vhosts/$D3/a1/cur/prod.eml"
# RED FIRST: the job as it was (f04ab85) honours the hook on a server.
git show f04ab85:infra/scripts/maildir-removals.sh > "$SCR/job-before.sh"
out=$(check_prodlike "$SCR/job-before.sh" before)
has   "RED: the job before this fix, on a server, DOES go to the hooked tree" "$out" "the path, exactly:"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi

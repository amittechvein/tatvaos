#!/usr/bin/env bash
#
# TatvaOS Mail - local stack diagnostic
#
# When mail is rejected but the containers are running, the cause is almost
# always that Postfix or Dovecot cannot complete a PostgreSQL lookup. This
# walks the chain from the bottom up and stops guessing at the first break.
#
#   ./scripts/diagnose.sh

set -uo pipefail

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); X=$(c $'\033[0m')

hdr()  { printf '\n%s== %s%s\n' "$C" "$1" "$X"; }
ok()   { printf '  %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
bad()  { printf '  %s[BAD ]%s %s\n' "$R" "$X" "$1"; }
note() { printf '         %s%s%s\n' "$D" "$1" "$X"; }
warn() { printf '  %s[warn]%s %s\n' "$Y" "$X" "$1"; }

# ---------------------------------------------------------------------------
hdr "1. Containers"
for s in tv-postgres tv-postfix tv-dovecot tv-mailpit tv-redis; do
    st=$(docker inspect -f '{{.State.Status}}' "$s" 2>/dev/null || echo missing)
    [ "$st" = running ] && ok "$s" || bad "$s ($st)"
done

# ---------------------------------------------------------------------------
hdr "2. Network: can the mail containers see Postgres?"
if docker exec tv-postfix bash -c '(echo > /dev/tcp/postgres/5432) 2>/dev/null'; then
    ok "postfix -> postgres:5432 reachable"
else
    bad "postfix CANNOT reach postgres:5432"
    note "Containers are not sharing the mailnet network."
fi

# ---------------------------------------------------------------------------
hdr "3. Postgres auth over TCP (this is what Postfix actually does)"
# The earlier test used docker exec + local socket, which is 'trust' in this
# image and therefore never exercises the password. TCP is the real path.
out=$(docker exec tv-postfix bash -c \
  'PGPASSWORD=dev_mail_pw psql -h postgres -U tatvaos_mailedge -d tatvaos_mail -tAc "SELECT 1" 2>&1' || true)
if printf '%s' "$out" | grep -q '^1$'; then
    ok "tatvaos_mailedge can log in over TCP"
elif printf '%s' "$out" | grep -qi 'command not found'; then
    warn "no psql inside the postfix container - skipping (not a fault)"
else
    bad "TCP login as tatvaos_mailedge FAILED"
    note "$(printf '%s' "$out" | head -2)"
fi

# ---------------------------------------------------------------------------
hdr "4. THE decisive test: Postfix's own pgsql lookups"
# postmap -q runs the map exactly as Postfix does. If these fail, Postfix
# cannot know techvein.local is ours, reject_unauth_destination fires, and
# every message is refused - which looks like a mail bug but is a DB bug.
probe() {
    local label="$1" key="$2" map="$3" expect="$4"
    local r
    r=$(docker exec tv-postfix postmap -q "$key" "pgsql:$map" 2>&1)
    local rc=$?
    if [ $rc -eq 0 ] && [ -n "$r" ]; then
        ok "$label -> '$r'"
    elif [ $rc -eq 0 ]; then
        bad "$label -> NO RESULT (lookup ran, key not found)"
    else
        bad "$label -> LOOKUP ERROR"
        note "$(printf '%s' "$r" | head -2)"
    fi
}
probe "domain   techvein.local"      "techvein.local"      /etc/postfix/sql/virtual-domains.cf    1
probe "mailbox  amit@techvein.local" "amit@techvein.local" /etc/postfix/sql/virtual-mailboxes.cf  1
probe "alias    ceo@techvein.local"  "ceo@techvein.local"  /etc/postfix/sql/virtual-aliases.cf    amit

# ---------------------------------------------------------------------------
hdr "5. What Postfix believes its config is"
for p in mydestination virtual_mailbox_domains virtual_transport relayhost mynetworks; do
    printf '  %-26s %s\n' "$p" "$(docker exec tv-postfix postconf -h "$p" 2>/dev/null | head -1)"
done

# ---------------------------------------------------------------------------
hdr "6. Dovecot SQL auth"
d=$(docker exec tv-dovecot doveadm auth test amit@techvein.local devpass123 2>&1)
if printf '%s' "$d" | grep -qi 'auth succeeded'; then
    ok "dovecot authenticates amit@techvein.local"
elif printf '%s' "$d" | grep -qi 'auth failed'; then
    bad "auth failed - lookup ran but the password did not match"
    note "check the {SHA512-CRYPT} prefix on mailboxes.password_hash"
else
    bad "auth lookup did not complete - Dovecot cannot reach Postgres"
    note "$(printf '%s' "$d" | head -2)"
fi

# ---------------------------------------------------------------------------
hdr "7. Recent errors in the logs"
for s in postfix dovecot; do
    printf '\n  %s--- %s ---%s\n' "$D" "$s" "$X"
    docker compose logs --no-log-prefix --tail 200 "$s" 2>/dev/null \
        | grep -iE 'error|fatal|warning|denied|refused|unknown|cannot|failed' \
        | tail -8 | sed 's/^/    /' || echo "    (none)"
done

# ---------------------------------------------------------------------------
hdr "8. Live delivery attempt"
if command -v swaks >/dev/null 2>&1; then
    r=$(swaks --server localhost:2525 --from t@example.com --to amit@techvein.local \
              --header "Subject: diagnose" --body test 2>&1 | grep -E '^<~?\*?\s|<\*\*' | tail -6)
    printf '%s\n' "$r" | sed 's/^/    /'
else
    note "swaks not installed - sudo apt install -y swaks"
fi

printf '\n%s%s%s\n' "$C" "----------------------------------------" "$X"
printf '  Read section 4 first. If those lookups fail, everything above\n'
printf '  section 4 is fine and everything below it is a symptom.\n\n'

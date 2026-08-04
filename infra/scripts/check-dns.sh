#!/usr/bin/env bash
#
# TatvaOS Mail — DNS preflight
#
# Verifies every record required for deliverability BEFORE sending anything.
# Run this until it is fully green; testing with broken DNS wastes the IP's
# first impressions, which are the ones that matter most.
#
#   ./check-dns.sh [domain] [ip]

set -uo pipefail

DOMAIN="${1:-tatvaos.com}"
IP="${2:-172.105.57.198}"
HOST="mail.${DOMAIN}"
SELECTOR="${DKIM_SELECTOR:-tv2026a}"

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); X=$(c $'\033[0m')

P=0; F=0
hdr()  { printf '\n%s== %s%s\n' "$C" "$1" "$X"; }
ok()   { printf '  %s[ ok ]%s %s\n' "$G" "$X" "$1"; P=$((P+1)); }
bad()  { printf '  %s[FAIL]%s %s\n' "$R" "$X" "$1"; F=$((F+1)); }
warn() { printf '  %s[warn]%s %s\n' "$Y" "$X" "$1"; }
note() { printf '         %s%s%s\n' "$D" "$1" "$X"; }

command -v dig >/dev/null || { echo "need dnsutils: sudo apt install -y dnsutils"; exit 1; }

printf '\n%s  DNS preflight — %s (%s)%s\n' "$C" "$DOMAIN" "$IP" "$X"

# ---------------------------------------------------------------------------
hdr "Forward and reverse"

a=$(dig +short "$HOST" A | head -1)
[ "$a" = "$IP" ] && ok "A  $HOST -> $IP" || bad "A record is '$a', expected '$IP'"

ptr=$(dig -x "$IP" +short | head -1 | sed 's/\.$//')
if [ "$ptr" = "$HOST" ]; then
    ok "PTR $IP -> $HOST"
else
    bad "PTR is '${ptr:-none}', expected '$HOST'"
    note "Linode Cloud Manager > Network > Edit RDNS"
    note "A PTR that does not forward-confirm is worse than none."
fi

# ---------------------------------------------------------------------------
hdr "MX"
mx=$(dig +short "$DOMAIN" MX | sort -n | head -1)
[ -n "$mx" ] && ok "MX $mx" || bad "no MX record"

# ---------------------------------------------------------------------------
hdr "SPF"
spf=$(dig +short "$DOMAIN" TXT | tr -d '"' | grep -c '^v=spf1' || true)
spfr=$(dig +short "$DOMAIN" TXT | tr -d '"' | grep '^v=spf1' | head -1)

if [ "$spf" -eq 0 ]; then
    bad "no SPF record"
elif [ "$spf" -gt 1 ]; then
    bad "$spf SPF records — this is a PERMERROR, every message fails SPF"
    note "Exactly one is allowed. Merge them."
else
    ok "SPF $spfr"
    case "$spfr" in
        *"$IP"*)      ok "  sending IP authorised" ;;
        *include:*)   warn "  IP not listed directly; relying on an include" ;;
        *)            bad "  $IP is NOT authorised by this record" ;;
    esac
    case "$spfr" in
        *-all) ok "  hard fail (-all)" ;;
        *~all) warn "  soft fail (~all) — fine to start, tighten to -all" ;;
        *)     warn "  no all mechanism — record is incomplete" ;;
    esac
fi

# ---------------------------------------------------------------------------
hdr "DKIM"
dkim=$(dig +short "${SELECTOR}._domainkey.${DOMAIN}" TXT | tr -d '"' | tr -d ' ')
if [ -z "$dkim" ]; then
    bad "no DKIM record at ${SELECTOR}._domainkey.${DOMAIN}"
else
    case "$dkim" in
        *v=DKIM1*) ok "DKIM record present" ;;
        *)         bad "record exists but is not a DKIM record" ;;
    esac
    case "$dkim" in
        *p=*)
            klen=$(printf '%s' "$dkim" | sed 's/.*p=//' | tr -d ';' | wc -c)
            [ "$klen" -gt 200 ] && ok "  public key looks complete ($klen chars)" \
                                || bad "  public key truncated ($klen chars) — TXT splitting problem"
            ;;
        *) bad "  no p= public key" ;;
    esac
fi

# ---------------------------------------------------------------------------
hdr "DMARC"
dmarc=$(dig +short "_dmarc.${DOMAIN}" TXT | tr -d '"')
if [ -z "$dmarc" ]; then
    bad "no DMARC record"
else
    ok "DMARC $dmarc"
    case "$dmarc" in
        *p=none*)       ok "  p=none — correct starting point" ;;
        *p=quarantine*) warn "  p=quarantine — only if you have read the reports" ;;
        *p=reject*)     warn "  p=reject — make sure you know your own mail passes" ;;
    esac
    case "$dmarc" in
        *rua=*) ok "  aggregate reports configured" ;;
        *)      warn "  no rua= — you will get no reports, which defeats the point" ;;
    esac
fi

# ---------------------------------------------------------------------------
hdr "Required mailboxes (RFC 2142)"
for m in abuse postmaster; do
    note "$m@$DOMAIN must be deliverable — reviewers and receivers check"
done

# ---------------------------------------------------------------------------
hdr "Blocklists"
listed=0
for bl in zen.spamhaus.org bl.spamcop.net b.barracudacentral.org dnsbl.sorbs.net; do
    rev=$(echo "$IP" | awk -F. '{print $4"."$3"."$2"."$1}')
    if [ -n "$(dig +short "${rev}.${bl}" A)" ]; then
        bad "LISTED on $bl"
        listed=1
    else
        ok "not listed on $bl"
    fi
done
[ "$listed" -eq 1 ] && note "Ask Linode for a different IP. That is a normal request."

# ---------------------------------------------------------------------------
printf '\n%s%s%s\n' "$C" "----------------------------------------" "$X"
printf '  passed: %s%d%s   failed: %s%d%s\n' "$G" "$P" "$X" \
       "$([ $F -gt 0 ] && echo "$R" || echo "$D")" "$F" "$X"

if [ "$F" -eq 0 ]; then
    printf '\n  %sDNS is correct. Safe to start sending.%s\n\n' "$G" "$X"
    exit 0
else
    printf '\n  %sFix the failures before sending. The first messages from a new IP\n' "$Y"
    printf '  are the ones receivers weigh most heavily.%s\n\n' "$X"
    exit 1
fi

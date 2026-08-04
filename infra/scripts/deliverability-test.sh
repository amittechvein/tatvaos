#!/usr/bin/env bash
#
# TatvaOS Mail — Phase 0 deliverability test
#
# THE Phase 0 gate. Sends a controlled message to each seed address and records
# where it landed. Everything else in Phase 0 exists to make this test valid.
#
#   ./deliverability-test.sh
#
# Configure seed addresses first — inboxes YOU control, one per major receiver.

set -uo pipefail

DOMAIN="${MAIL_DOMAIN:-tatvaos.com}"
FROM="${MAIL_FROM:-postmaster@$DOMAIN}"
SERVER="${SMTP_SERVER:-localhost:25}"
RESULTS="${RESULTS_DIR:-./results}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"

# Seed inboxes — one per receiver. Fill these in.
SEEDS=(
    "${SEED_GMAIL:-}"
    "${SEED_OUTLOOK:-}"
    "${SEED_YAHOO:-}"
)
LABELS=(gmail outlook yahoo)

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); X=$(c $'\033[0m')
hdr() { printf '\n%s== %s%s\n' "$C" "$1" "$X"; }

command -v swaks >/dev/null || { echo "need swaks: sudo apt install -y swaks"; exit 1; }
mkdir -p "$RESULTS"
LOG="$RESULTS/$RUN_ID.md"

configured=0
for s in "${SEEDS[@]}"; do [ -n "$s" ] && configured=$((configured+1)); done
if [ "$configured" -eq 0 ]; then
    printf '\n%sNo seed addresses configured.%s\n\n' "$R" "$X"
    printf 'Set inboxes you control, then re-run:\n\n'
    printf '  export SEED_GMAIL=you@gmail.com\n'
    printf '  export SEED_OUTLOOK=you@outlook.com\n'
    printf '  export SEED_YAHOO=you@yahoo.com\n\n'
    printf '%sOnly send to addresses you own. Sending to addresses you do not\n' "$Y"
    printf 'control is what actually damages a domain reputation.%s\n\n' "$X"
    exit 1
fi

printf '\n%s  Deliverability test — run %s%s\n' "$C" "$RUN_ID" "$X"
printf '   from:   %s\n   server: %s\n' "$FROM" "$SERVER"

{
    echo "# Deliverability test — $RUN_ID"
    echo
    echo "| Field | Value |"
    echo "|---|---|"
    echo "| Date | $(date -u '+%Y-%m-%d %H:%M UTC') |"
    echo "| From | $FROM |"
    echo "| Server | $SERVER |"
    echo "| Sending IP | $(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo unknown) |"
    echo
} > "$LOG"

# ---------------------------------------------------------------------------
hdr "Sending"

# Deliberately ordinary business content. Marketing language, excess links and
# ALL CAPS all cost spam points and would make the result meaningless.
SUBJECT="TatvaOS Mail delivery test $RUN_ID"
BODY="Hello,

This is a delivery test from the TatvaOS Mail platform.

It confirms that SPF, DKIM and DMARC are configured correctly and that mail
from this server is accepted normally.

No action is needed.

Regards,
TatvaOS Mail
$DOMAIN"

sent=0
for i in "${!SEEDS[@]}"; do
    to="${SEEDS[$i]}"; label="${LABELS[$i]}"
    [ -z "$to" ] && continue
    printf '  %-9s %s ... ' "$label" "$to"
    if swaks --server "$SERVER" --from "$FROM" --to "$to" \
             --header "Subject: $SUBJECT" --body "$BODY" \
             --hide-all --silent 3 >/dev/null 2>&1; then
        printf '%saccepted%s\n' "$G" "$X"
        sent=$((sent+1))
        echo "- **$label** ($to) — accepted by our server" >> "$LOG"
    else
        printf '%sREJECTED%s\n' "$R" "$X"
        echo "- **$label** ($to) — REJECTED at submission" >> "$LOG"
    fi
done

# ---------------------------------------------------------------------------
hdr "mail-tester"
printf '  1. Open %shttps://www.mail-tester.com%s\n' "$C" "$X"
printf '  2. Copy the address it shows you\n'
printf '  3. Run:\n\n'
printf '     %sswaks --server %s --from %s --to <address> \\\n' "$D" "$SERVER" "$FROM"
printf '           --header "Subject: %s" --body "test"%s\n\n' "$SUBJECT" "$X"
printf '  4. Refresh. Target 10/10.\n'

# ---------------------------------------------------------------------------
hdr "Record the result — THIS is the deliverable"

cat >> "$LOG" <<'EOF'

## Placement — fill in by hand

Open each inbox and record where the message actually landed. This table is
the Phase 0 gate; nothing else in Phase 0 matters if these say Spam.

| Receiver | Inbox / Spam / Missing | Delay | Notes |
|---|---|---|---|
| Gmail | | | |
| Outlook | | | |
| Yahoo | | | |

## mail-tester score

| Score | Deductions |
|---|---|
| /10 | |

## Authentication results

From the received message: show original / view source, find `Authentication-Results`.

| Check | Pass / Fail |
|---|---|
| SPF | |
| DKIM | |
| DMARC | |

## Verdict

- [ ] **PASS** — inbox at all three. Own-IP sending is viable
- [ ] **PARTIAL** — inbox at some. Note which, and what the failures share
- [ ] **FAIL** — spam or missing. Relay-first (architecture §12) becomes the path

## Comparison against a relay

Send the same message through SES or Postmark and record placement here. This
comparison is the input to the own-IP vs relay decision (§17.1), and it is the
reason this test exists rather than a simple "did it arrive".

| Receiver | Own IP | Via relay |
|---|---|---|
| Gmail | | |
| Outlook | | |
| Yahoo | | |
EOF

printf '\n  Template written to %s%s%s\n' "$C" "$LOG" "$X"
printf '  %sWait 5 minutes, check each inbox, and fill it in.%s\n' "$D" "$X"
printf '  %sA message in Spam is not a failed test — it is the finding.%s\n\n' "$D" "$X"

printf '%s%s%s\n' "$C" "----------------------------------------" "$X"
printf '  sent: %d/%d\n\n' "$sent" "$configured"

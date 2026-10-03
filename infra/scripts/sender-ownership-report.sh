#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# sender-ownership-report.sh - the daily count from port 587's warn record.
#
# WHY. PR 380 ships the port 587 ownership check in WARN mode (Amit, 2 Oct
# 2026): nothing is refused, and every message that would be is recorded by
# the From-line filter in /var/log/tatvaos/sender-ownership-YYYY-MM.jsonl
# inside the postfix container (maillogs volume). Mr. Singh, 3 Oct: "a daily
# count from the record, in the deploy session's morning check: mismatches by
# organisation ID and kind", until the switch to enforce on 10 October.
#
# READ THE "FIXABLE" LINE FIRST. same_org_shared_no_right = someone sends as a
# shared mailbox of their own organisation without a send permission row. Add
# the permission (send_as) and that count drops. Anything other_org or
# not_hosted is what the check exists to stop - bring it to Mr. Singh before
# switching to enforce.
#
# Prints organisation ids, kinds, classes and counts. NEVER an address: the
# record holds none (local/scripts/test-mail.sh asserts that, and that this
# report prints none).
#
# Usage, on the server:   ./infra/scripts/sender-ownership-report.sh [HOURS]
#   HOURS   the window for the daily lines (default 24); the totals since the
#           record began are printed too.
#   POSTFIX the container (default tatvaos-postfix-1; local: tv-postfix)
# Exit 0 with a report (an empty record is a report: "nothing would have been
# refused"), 2 if the record could not be read.
# ---------------------------------------------------------------------------
set -uo pipefail
POSTFIX="${POSTFIX:-tatvaos-postfix-1}"
HOURS="${1:-24}"
case "$HOURS" in ''|*[!0-9]*) echo "HOURS must be a whole number (got '$HOURS')" >&2; exit 2;; esac

if ! docker exec "$POSTFIX" true >/dev/null 2>&1; then
    echo "could not reach the container $POSTFIX - the record was NOT read" >&2
    exit 2
fi
mode=$(docker exec "$POSTFIX" cat /etc/postfix/sender-ownership-mode 2>/dev/null | tr -cd 'a-z')
data=$(docker exec "$POSTFIX" sh -c 'cat /var/log/tatvaos/sender-ownership-*.jsonl 2>/dev/null; true')

printf '%s\n' "$data" | python3 -c '
import calendar, json, sys, time, collections
hours, mode = int(sys.argv[1]), sys.argv[2] or "unknown"
since = time.time() - hours * 3600
rows, bad = [], 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
        r["_t"] = calendar.timegm(time.strptime(r["ts"], "%Y-%m-%dT%H:%M:%SZ"))   # the record is UTC
        rows.append(r)
    except Exception:
        bad += 1
recent = [r for r in rows if r["_t"] >= since]
print(f"Port 587 sender ownership - mode: {mode} - last {hours} h: {len(recent)} would-be refusal(s); since the record began: {len(rows)}")
if bad:
    print(f"  WARNING: {bad} line(s) of the record could not be read")
if not rows:
    print("  nothing would have been refused (the record is empty)")
    sys.exit(0)
def table(title, items):
    c = collections.Counter((r.get("login_tenant") or "?", r.get("kind") or "?", r.get("class") or "?") for r in items)
    print(f"  {title}:")
    if not c:
        print("    (none)")
    for (org, kind, cls), n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"    {org}  {kind:<8}  {cls:<26}  {n}")
table(f"last {hours} h, by organisation (signing in), kind, class", recent)
fix = collections.Counter(r.get("login_tenant") or "?" for r in recent if r.get("class") == "same_org_shared_no_right")
print(f"  FIXABLE (add the send permission on the shared mailbox), last {hours} h: {sum(fix.values())}")
for org, n in sorted(fix.items()):
    print(f"    {org}  {n}")
table("since the record began", rows)
' "$HOURS" "$mode"

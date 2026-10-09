#!/usr/bin/env bash
# TatvaOS People — PeopleAccess is the only route to employee records, People
# HR and the reporting history (decision 0018 §4, accepted 9 Oct 2026).
#
# The same structural rule as tests/hire/check-job-gate.sh (Mr. Singh, 24 Sept
# 2026: "make the gate structural, not documented"). Here it matters more: a
# manager sees only the people below them because every read goes through
# PeopleAccess.VisibleAsync. A handler that read people.employees any other way
# would show a manager - or anyone - every employee record in the
# organisation, and nothing would look wrong: the tenant filter would still be
# working.
#
# Fails on: Set<Employee|ReportingChange|PeopleHrMember>() or SQL naming
# people.employees / people.reporting_changes / people.hr_members outside
# Modules/People/PeopleAccess.cs; a DbSet of any of them; a property by
# those names. Proves it can see: it must find the gate's own uses, and scan
# a real number of files.
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API="$ROOT/apps/api"
GATE="Modules/People/PeopleAccess.cs"

TYPES='(Employee|ReportingChange|PeopleHrMember)'
SET_RE="Set<[[:space:]]*(TatvaOS\\.Api\\.Modules\\.People\\.)?${TYPES}[[:space:]]*>"
DBSET_RE="DbSet<[[:space:]]*(TatvaOS\\.Api\\.Modules\\.People\\.)?${TYPES}[[:space:]]*>"
SQL_RE='people\.(employees|reporting_changes|hr_members)\b'
PROP_RE='\.(Employees|ReportingChanges|PeopleHrMembers|HrMembers)\b[^(]'

fails=0
bad() { printf '  ✗ %s\n' "$1"; fails=$((fails+1)); }
ok()  { printf '  ✓ %s\n' "$1"; }

cd "$API" || { bad "no apps/api at $API"; exit 1; }
n=$(find . -name '*.cs' -not -path './bin/*' -not -path './obj/*' | wc -l | tr -d ' ')
[ "${n:-0}" -ge 100 ] && ok "scanned $n C# files" \
                      || bad "scanned only ${n:-0} C# files — the search is not looking where the code is"

g=$(grep -cE "$SET_RE" "$GATE" 2>/dev/null || true)
[ "${g:-0}" -ge 5 ] && ok "the pattern finds the gate's own uses ($g in $GATE)" \
                    || bad "the pattern found ${g:-0} uses in $GATE — it would not see a bypass either"
s=$(grep -cE "$SQL_RE" "$GATE" 2>/dev/null || true)
[ "${s:-0}" -ge 2 ] && ok "the SQL pattern finds the gate's own SQL ($s lines)" \
                    || bad "the SQL pattern found ${s:-0} lines in $GATE — it would not see raw SQL elsewhere"

scan() {
    grep -rnE "$1" --include='*.cs' --exclude-dir=bin --exclude-dir=obj . 2>/dev/null \
        | sed 's|^\./||' \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
}

hit=$(scan "$SET_RE" | grep -v "^$GATE:" | head -5)
[ -n "$hit" ] && bad "Set<> of a People record outside PeopleAccess — go through the gate:
$hit"
hit=$(scan "$SQL_RE" | grep -v "^$GATE:" | head -5)
[ -n "$hit" ] && bad "a People table named in code (raw SQL?) — go through the gate:
$hit"
hit=$(scan "$PROP_RE" | head -5)
[ -n "$hit" ] && bad "a People DbSet member is used — it must not exist:
$hit"
hit=$(scan "$DBSET_RE" | head -5)
[ -n "$hit" ] && bad "a DbSet of a People record exists — PeopleAccess is the only route:
$hit"

if [ "$fails" -eq 0 ]; then
    ok "PeopleAccess is the only route to employee records, People HR and reporting history"
    exit 0
fi
printf '\n  %d finding(s). A manager, or anyone, could see records that are not theirs.\n' "$fails"
exit 1

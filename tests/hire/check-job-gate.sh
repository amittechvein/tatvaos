#!/usr/bin/env bash
# TatvaOS Hire — HireAccess is the only route to hire.job_openings.
#
# Mr. Singh, 24 Sept 2026 (PR 264): "make the gate structural, not
# documented". A hiring manager sees only the jobs that name them because
# every read goes through HireAccess.Jobs(level). A handler that read the
# table any other way would show them every job in the organisation, and
# nothing would look wrong — the tenant filter would still be working.
#
# C# already closes most of it: AppDbContext has no JobOpenings property, so
# `db.JobOpenings` does not compile. What C# cannot close is someone writing
# db.Set<JobOpening>() or raw SQL in another file, or putting the property
# back. This script fails on any of those.
#
# It also proves it can SEE: the pattern must match the legitimate uses in
# HireAccess.cs, and it must have scanned a real number of files. A guard
# that searched nothing would pass forever (testing-false-greens).
#
# One grep over the tree, not one per file: per-file took over two minutes
# on Git Bash for Windows, where every process start is expensive.
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API="$ROOT/apps/api"
GATE="Modules/Hire/HireAccess.cs"

SET_RE='Set<[[:space:]]*(TatvaOS\.Api\.Modules\.Hire\.)?JobOpening[[:space:]]*>'
DBSET_RE='DbSet<[[:space:]]*(TatvaOS\.Api\.Modules\.Hire\.)?JobOpening[[:space:]]*>'
SQL_RE='hire\.job_openings'
PROP_RE='\.JobOpenings\b'

fails=0
bad() { printf '  ✗ %s\n' "$1"; fails=$((fails+1)); }
ok()  { printf '  ✓ %s\n' "$1"; }

cd "$API" || { bad "no apps/api at $API"; exit 1; }
n=$(find . -name '*.cs' -not -path './bin/*' -not -path './obj/*' | wc -l | tr -d ' ')
[ "${n:-0}" -ge 100 ] && ok "scanned $n C# files" \
                      || bad "scanned only ${n:-0} C# files — the search is not looking where the code is"

# The pattern works: it matches the legitimate uses in the gate itself.
g=$(grep -cE "$SET_RE" "$GATE" 2>/dev/null || true)
[ "${g:-0}" -ge 3 ] && ok "the pattern finds the gate's own uses ($g in $GATE)" \
                    || bad "the pattern found ${g:-0} uses in $GATE — it would not see a bypass either"

# Every matching CODE line in the tree, as file:line:text. Comment lines may
# name the table, and do, to explain it; they are dropped.
scan() {
    grep -rnE "$1" --include='*.cs' --exclude-dir=bin --exclude-dir=obj . 2>/dev/null \
        | sed 's|^\./||' \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
}

hit=$(scan "$SET_RE" | grep -v "^$GATE:" | head -5)
[ -n "$hit" ] && bad "Set<JobOpening>() outside HireAccess — go through the gate:
$hit"
hit=$(scan "$SQL_RE" | grep -v "^$GATE:" | head -5)
[ -n "$hit" ] && bad "hire.job_openings named in code (raw SQL?) — go through the gate:
$hit"
hit=$(scan "$PROP_RE" | head -5)
[ -n "$hit" ] && bad "a JobOpenings member is used — the DbSet must not come back:
$hit"
hit=$(scan "$DBSET_RE" | head -5)
[ -n "$hit" ] && bad "a DbSet<JobOpening> exists again — HireAccess is the only route:
$hit"

if [ "$fails" -eq 0 ]; then
    ok "HireAccess is the only route to hire.job_openings"
    exit 0
fi
printf '\n  %d finding(s). A hiring manager could see jobs that are not theirs.\n' "$fails"
exit 1

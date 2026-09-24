#!/usr/bin/env bash
#
# Tests for backup-tiers.sh — no bucket, no server, no real clock.
#
#   bash infra/scripts/backup-tiers-test.sh
#
# The main test is a SIMULATION, not a snapshot: it plays the real sequence —
# a set uploaded every 2 hours for 14 days, the tier rule applied after each
# upload, the deletions carried forward — and then reads what the bucket
# would hold. A rule that looks right on one listing can still drift when it
# runs against its own previous output, and that is how it will really run.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
export TZ=UTC

# Overridable so a deliberately broken copy can be run through the same test
# — the way to prove each check can fail.
TIERS="${TIERS:-./infra/scripts/backup-tiers.sh}"
pass=0; fail=0
same()  { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1"; else fail=$((fail+1)); echo "  FAIL  $1: expected [$3], got [$2]"; fi; }
has()   { if printf '%s\n' "$2" | grep -qxF -- "$3"; then pass=$((pass+1)); echo "  ok    $1"; else fail=$((fail+1)); echo "  FAIL  $1: [$3] missing"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -qxF -- "$3"; then fail=$((fail+1)); echo "  FAIL  $1: [$3] present"; else pass=$((pass+1)); echo "  ok    $1"; fi; }

stamp() { date -d "@$1" +%Y%m%d-%H%M%S; }
H=3600
T0=$(date -d "2026-09-01 00:30:00" +%s)

echo "== simulation: every 2 hours for 14 days, rule applied after each upload"
bucket=""
t=$T0
end=$((T0 + 14 * 24 * H))
deleted_total=0
maxcount=0; mincount=999
while [ "$t" -le "$end" ]; do
    bucket=$(printf '%s\n%s' "$bucket" "$(stamp "$t").tar.gz.enc" | sed '/^$/d')
    doomed=$(printf '%s\n' "$bucket" | "$TIERS" "$t" 2>/dev/null)
    if [ -n "$doomed" ]; then
        deleted_total=$((deleted_total + $(printf '%s\n' "$doomed" | wc -l)))
        bucket=$(printf '%s\n' "$bucket" | grep -vxF -f <(printf '%s\n' "$doomed"))
    fi
    # Every run, not only the last: the count depends on the time of day
    # the run lands, and one ending hour could hide a worse one.
    if [ "$t" -ge $((T0 + 7 * 24 * H)) ]; then
        n=$(printf '%s\n' "$bucket" | wc -l)
        [ "$n" -gt "$maxcount" ] && maxcount=$n
        [ "$n" -lt "$mincount" ] && mincount=$n
    fi
    last=$t
    t=$((t + 2 * H))
done
count=$(printf '%s\n' "$bucket" | wc -l)
echo "  bucket after 14 days: $count sets (deleted $deleted_total over the run)"

ages=$(printf '%s\n' "$bucket" | while read -r n; do
    s=${n%.tar.gz.enc}
    e=$(date -d "${s:0:4}-${s:4:2}-${s:6:2} ${s:9:2}:${s:11:2}:${s:13:2}" +%s)
    echo $(( (last - e) / H ))
done)
in_day1=$(printf '%s\n' "$ages" | awk '$1<24' | wc -l)
in_day2=$(printf '%s\n' "$ages" | awk '$1>=24 && $1<48' | wc -l)
in_week=$(printf '%s\n' "$ages" | awk '$1>=48 && $1<168' | wc -l)
oldest=$(printf '%s\n' "$ages" | sort -n | tail -1)

same "last 24 hours: all 12 two-hourly sets"       "$in_day1" 12
same "24-48 hours: one per 6-hour slot (4)"         "$in_day2" 4
same "2-7 days: one per day (5)"                    "$in_week" 5
same "total"                                        "$count"   21
echo "  over the second week, every run: between $mincount and $maxcount sets"
if [ "$maxcount" -le 22 ] && [ "$mincount" -ge 20 ]; then pass=$((pass+1)); echo "  ok    never more than 22 or fewer than 20"
else fail=$((fail+1)); echo "  FAIL  count strayed to $mincount..$maxcount"; fi
if [ "$oldest" -lt 168 ]; then pass=$((pass+1)); echo "  ok    nothing older than 7 days (oldest ${oldest}h)"
else fail=$((fail+1)); echo "  FAIL  a set older than 7 days survived (${oldest}h)"; fi
# The simulation is only a test if deletions happened. A rule that deleted
# nothing would also "keep the newest set".
if [ "$deleted_total" -gt 100 ]; then pass=$((pass+1)); echo "  ok    the rule did delete ($deleted_total)"
else fail=$((fail+1)); echo "  FAIL  only $deleted_total deleted — the rule is not running"; fi
has "the newest set is kept" "$bucket" "$(stamp "$last").tar.gz.enc"

echo "== the 6-hourly and daily sets are spread out, not bunched"
gaps=$(printf '%s\n' "$ages" | sort -n | awk '$1>=24 {if (p!="") print $1-p; p=$1}' | sort -n | head -1)
if [ "${gaps:-0}" -ge 4 ]; then pass=$((pass+1)); echo "  ok    smallest gap past a day: ${gaps}h"
else fail=$((fail+1)); echo "  FAIL  two sets past a day are only ${gaps}h apart"; fi

echo "== things it must never delete"
now=$(date -d "2026-09-20 12:00:00" +%s)
old1="20260801-003000.tar.gz.enc"   # 50 days old
old2="20260802-003000.tar.gz.enc"
old3="20260803-003000.tar.gz.enc"
old4="20260804-003000.tar.gz.enc"
foreign=$'recordings/abc.webm\nREADME.txt\n20260801-003000.tar.gz\n20261399-003000.tar.gz.enc'
out=$(printf '%s\n%s\n%s\n%s\n%s\n' "$old1" "$old2" "$old3" "$old4" "$foreign" | "$TIERS" "$now" 2>/dev/null)
notes=$(printf '%s\n%s\n' "$old1" "$foreign" | "$TIERS" "$now" 2>&1 >/dev/null)
hasnt "floor: newest of four week-old sets kept"    "$out" "$old4"
hasnt "floor: second newest kept"                   "$out" "$old3"
hasnt "floor: third newest kept"                    "$out" "$old2"
has   "floor: the fourth is deleted"                "$out" "$old1"
hasnt "a sub-folder object is left alone"           "$out" "recordings/abc.webm"
hasnt "a stray file is left alone"                  "$out" "README.txt"
hasnt "an unencrypted name is left alone"           "$out" "20260801-003000.tar.gz"
hasnt "an impossible date is left alone"            "$out" "20261399-003000.tar.gz.enc"
has   "and it says so"                              "$notes" "backup-tiers: not a backup set, left alone: README.txt"

echo "== BACKUP_S3_MIN_KEEP can raise the floor"
out=$(printf '%s\n%s\n%s\n%s\n' "$old1" "$old2" "$old3" "$old4" | BACKUP_S3_MIN_KEEP=4 "$TIERS" "$now" 2>/dev/null)
same "floor of 4 keeps all four" "$out" ""

echo "== a set stamped in the future is kept"
fut="20261001-003000.tar.gz.enc"
out=$(printf '%s\n%s\n%s\n%s\n%s\n' "$fut" "$old1" "$old2" "$old3" "$old4" | "$TIERS" "$now" 2>/dev/null)
hasnt "future set kept" "$out" "$fut"

echo "== Windows line endings in the listing"
out=$(printf '%s\r\n%s\r\n%s\r\n%s\r\n' "$old1" "$old2" "$old3" "$old4" | "$TIERS" "$now" 2>/dev/null)
same "CRLF read the same as LF" "$out" "$old1"

echo "== empty listing"
out=$(printf '' | "$TIERS" "$now" 2>&1)
same "no output, no error" "$out" ""

echo
echo "PASS $pass  FAIL $fail"
[ "$fail" -eq 0 ]

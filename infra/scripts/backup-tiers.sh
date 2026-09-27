#!/usr/bin/env bash
#
# TatvaOS — which off-box backup sets to delete, under the tiered schedule
#
#   rclone lsf "$BACKUP_S3_REMOTE" | ./infra/scripts/backup-tiers.sh [NOW_EPOCH]
#
# Reads object names on stdin. Prints, one per line, the names to DELETE.
# Deletes nothing itself: backup.sh does the deleting, one named object at a
# time. Keeping the decision in a separate script means it can be tested on a
# laptop against made-up names, without a bucket, a server or a clock
# (infra/scripts/backup-tiers-test.sh).
#
# ─────────────────────────────────────────────────────────────────────────
#  THE SCHEDULE (Amit, 24 Sept 2026)
#
#    last 24 hours     every set               (one every 2 hours = 12)
#    24 to 48 hours    one per 6-hour slot     (about 4)
#    2 to 8 days       one per calendar day    (about 6)
#    older than 8 days deleted
#
#  About 22 sets.
#
#  WHY 8 AND NOT 7 — "AT LEAST SEVEN DAYS", ALWAYS (Amit, 26 Sept 2026).
#  Off-box backups cover seven days: that is Amit's decision. The first cut
#  kept one set per day until it turned 7 days old. But the set kept for a
#  day is that day's LAST one (23:30 when two-hourly), so the moment it
#  reached 168 hours and was dropped, the oldest set left was the NEXT day's
#  last — 144 hours old. Measured in Chennai on 26 Sept: 13 sets, oldest
#  156 h, and falling to 6 days at each daily drop. Seven days was the
#  ceiling, not the floor. Dropping at 8 days makes seven the floor: when a
#  day's set goes at 192 h, the next day's is 168 h old. The oldest restore
#  point is always between 7 and 8 days (backup-tiers-test.sh checks every
#  run). The cost is one more set in the bucket. The age of a set is read from its NAME
#  (YYYYmmdd-HHMMSS.tar.gz.enc, the stamp backup.sh gives it), not from the
#  bucket's modification time, so the answer does not change if an object is
#  ever copied or re-uploaded.
#
#  THE STAMPS ARE UTC, AND ARE READ AS UTC — pinned here, not left to the
#  machine's zone. backup.sh writes them with `date -u`; this script sets
#  TZ=UTC before reading one. If the server's zone ever changes, neither side
#  moves. (The test runs under Asia/Kolkata to prove it.)
#
#  Slots and days are fixed to the clock (00-06, 06-12, ...; midnight), not
#  counted back from now — a slot that moved with every run would pick a
#  different set to keep each time and eventually keep none of them. A slot
#  or day already covered by a NEWER kept set counts as covered, whichever
#  tier that set is in; without that, the slot straddling the 24-hour line
#  kept two sets two hours apart (the test caught it).
#
#  WHAT IT WILL NEVER DELETE, whatever the dates say:
#    - a name it cannot read as a stamp. Anything else in the bucket is not
#      ours to judge — it is printed to stderr and left alone.
#    - the newest BACKUP_S3_MIN_KEEP sets (default 3). If backups stop for a
#      week and then one run succeeds, a purely age-based rule would delete
#      every set but that one. This floor is what stops that.
#    - a set stamped in the future (clock trouble). Kept, and said so.
# ─────────────────────────────────────────────────────────────────────────

set -uo pipefail
export TZ=UTC

NOW="${1:-$(date +%s)}"
MIN_KEEP="${BACKUP_S3_MIN_KEEP:-3}"
H=3600

names=()
stamps=()
while IFS= read -r name; do
    name="${name%$'\r'}"
    [ -z "$name" ] && continue
    if [[ "$name" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})\.tar\.gz\.enc$ ]]; then
        names+=("$name")
        stamps+=("${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}")
    else
        echo "backup-tiers: not a backup set, left alone: $name" >&2
    fi
done

[ "${#names[@]}" -eq 0 ] && exit 0

# Every stamp read by ONE date call, as UTC (TZ above). One call per name
# took minutes over a long listing.
# date -f skips a line it cannot read, which would shift every answer after
# it by one — so if the count comes back short, read them one at a time.
mapfile -t parsed < <(printf '%s\n' "${stamps[@]}" | date -f - '+%s %Y%m%d' 2>/dev/null)
if [ "${#parsed[@]}" -ne "${#names[@]}" ]; then
    parsed=()
    for s in "${stamps[@]}"; do
        parsed+=("$(date -d "$s" '+%s %Y%m%d' 2>/dev/null || echo bad)")
    done
fi

# name <TAB> epoch <TAB> day, newest first.
rows=$(
    for i in "${!names[@]}"; do
        if [ "${parsed[$i]}" = "bad" ]; then
            echo "backup-tiers: not a real date, left alone: ${names[$i]}" >&2
            continue
        fi
        printf '%s\t%s\t%s\n' "${names[$i]}" "${parsed[$i]% *}" "${parsed[$i]#* }"
    done | sort -t$'\t' -k2,2nr
)

[ -z "$rows" ] && exit 0

declare -A slot6 day
i=0
while IFS=$'\t' read -r name epoch d; do
    i=$((i + 1))
    age=$((NOW - epoch))
    s=$((epoch / (6 * H)))

    if [ "$i" -le "$MIN_KEEP" ] || [ "$age" -lt $((24 * H)) ]; then
        [ "$age" -lt 0 ] && echo "backup-tiers: stamped in the future, kept: $name" >&2
        keep=1                                     # the floor, or the last day
    elif [ "$age" -lt $((48 * H)) ]; then
        [ -z "${slot6[$s]:-}" ] && keep=1 || keep=0
    elif [ "$age" -lt $((8 * 24 * H)) ]; then   # 8, not 7: see "WHY 8 AND NOT 7"
        [ -z "${day[$d]:-}" ] && keep=1 || keep=0
    else
        keep=0
    fi

    if [ "$keep" = "1" ]; then
        slot6[$s]=1; day[$d]=1
    else
        echo "$name"
    fi
done <<< "$rows"

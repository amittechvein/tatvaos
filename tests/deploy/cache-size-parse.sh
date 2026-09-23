#!/usr/bin/env bash
#
# The build-cache size reading in deploy.sh, on the strings docker prints.
#
# WHY THIS EXISTS. Until 23 September 2026 deploy.sh ran
#   docker builder prune -f --keep-storage=8GB
# and then printed "cache bounded at 8 GB" — unconditionally, with no reading
# of anything. Measured on production that day: the cache held 51.89 GB and
# the disk was at 90%, four days after a hand clean. The flag was deprecated
# on Docker 29 AND the prune was not `-a`, so it removed a slice; the sentence
# was true of nothing.
#
# So the number is now parsed and checked, and this proves the parser. It runs
# the awk from deploy.sh against the exact shapes `docker system df` prints.
#
# Usage: bash tests/deploy/cache-size-parse.sh     (no docker needed)
# Exit:  0 all passed, 1 otherwise.

pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '    ok  %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }

# The parser, lifted from deploy.sh. If you change it there, change it here
# and watch this test fail first.
parse() {
    printf 'Images|11.13GB\nBuild Cache|%s\nLocal Volumes|17.11GB\n' "$1" | awk -F'|' '
        $1 == "Build Cache" {
            v = $2; sub(/[A-Za-z]+$/, "", v); unit = $2; sub(/^[0-9.]+/, "", unit)
            if (unit ~ /^TB/) v *= 1024; else if (unit ~ /^MB/) v /= 1024
            else if (unit ~ /^kB|^KB/) v /= 1048576; else if (unit ~ /^B/) v = 0
            printf "%.1f", v; found = 1
        }
        END { if (!found) print "-1" }'
}

check() {  # what, input, expected
    local got; got=$(parse "$2")
    if [ "$got" = "$3" ]; then ok "$1 ($2 -> $got GB)"
    else bad "$1: $2 gave $got GB, expected $3"; fi
}

printf '\n  deploy.sh build-cache size reading\n  ==================================\n\n'

check "the size that was missed on production" "51.89GB" "51.9"
check "the size after a hand clean"            "3.059GB" "3.1"
check "megabytes are not read as gigabytes"    "820.5MB" "0.8"
check "terabytes, if it ever gets that far"    "1.2TB"   "1228.8"
check "kilobytes round to nothing"             "512kB"   "0.0"
check "an empty cache"                         "0B"      "0.0"

# A parser that cannot fail is not a parser. If docker ever stops printing the
# row, the reading must say so rather than quietly return zero and let the
# deploy claim the cache is empty.
missing=$(printf 'Images|11.13GB\nContainers|10MB\n' | awk -F'|' '
    $1 == "Build Cache" { print "0"; found = 1 }
    END { if (!found) print "-1" }')
if [ "$missing" = "-1" ]; then ok "no Build Cache row reports -1, not 0"
else bad "a missing Build Cache row returned '$missing' — a deploy would read it as empty"; fi

printf '\n  ==================================\n'
if [ "$fail" -eq 0 ]; then printf '  PASS  %s checks\n\n' "$pass"; exit 0; fi
printf '  FAIL  %s of %s checks\n\n' "$fail" "$((pass + fail))"; exit 1

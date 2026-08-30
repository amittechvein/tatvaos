#!/usr/bin/env bash
# =============================================================================
#  verify-space-link-predicate.sh — the public-link gate must say one thing
# =============================================================================
#
#  The anonymous download path has no session, so RLS cannot protect it. Two
#  SECURITY DEFINER functions are the only database access on that path:
#  peek_public_link, which the landing page reads, and consume_public_link,
#  which the download counts against. Their gating predicates are duplicated
#  by necessity — one reads, one writes — and the migration asks reviewers to
#  diff them by eye. A request to a reviewer is not a check. This is.
#
#  WHY IT SCANS THE WHOLE DIRECTORY, not one file. A migration re-runs on
#  every deploy and a later file may DROP and re-CREATE a function. The
#  definition that governs production is the LAST one to run, not the one
#  next to its twin in the file where both were introduced. Comparing two
#  definitions that sit together and are then both superseded verifies a
#  value nothing uses — rule 8 in a costume, and the exact defect this
#  script found on its first real run.
#
#  So: every CREATE of either function, across every file, in run order.
#  The last of each is live. Two different standards apply, on purpose:
#
#    THE LIVE PAIR must be identical COMMENT FOR COMMENT. That is the claim
#    the migration makes about itself, and the comments are how a reviewer
#    diffs the two by eye. A comment that disagrees with its twin is the
#    defect, not a cosmetic difference.
#
#    A SUPERSEDED COPY must have identical CONDITIONS, and any comment it
#    does carry must match the live one. A missing comment is allowed; a
#    contradicting one is not. Absence makes a reader ask; a stale comment
#    makes them confident, and confident is how the wrong line wins.
#
#  The second standard exists because superseded copies are deliberate here:
#  20260816 bootstraps consume_public_link for a database that has never seen
#  it, and says in its own header that a later file owns the shape. Demanding
#  cosmetic identity of a bootstrap would put this script permanently red for
#  a reason nobody should fix, and a check people learn to ignore has already
#  stopped being a check.
#
#  WHAT WOULD PROVE THIS SCRIPT WRONG (rule 6, asked before it was written):
#    - it reports agreement having found nothing — guarded: a missing
#      definition of either function is a hard failure, never a pass;
#    - it reports agreement while incapable of reporting anything else —
#      guarded: three positive controls run first — a broken condition in
#      the live definition, a broken condition in a superseded copy, and a
#      comment in a superseded copy that contradicts the live one. Each must
#      be caught. If any control passes, this script exits non-zero and says
#      so rather than reporting anything about the real files.
#
#  WHAT IT DOES NOT SEE, stated rather than left to be discovered: conditions
#  written into a JOIN ... ON clause instead of the WHERE. It reads WHERE and
#  AND lines only. A gate smuggled into a join would pass. Run order is taken
#  to be LC_ALL=C filename order, which is what the directory runner uses.
#
#  Exit codes:  0 agree   1 drifted   2 the check itself did not run
# =============================================================================
set -uo pipefail

FN_PEEK="peek_public_link"
FN_CONSUME="consume_public_link"

# The one legitimate difference between the live pair, with its reason —
# rule 10 requires a reason per exception line:
#   f.id = l.file_id  — consume UPDATEs public_links FROM files and joins them
#                       in its WHERE; peek joins in its FROM. Same relation,
#                       different statement shape. Not a gate.
ALLOWED_ONLY_IN_CONSUME="f.id = l.file_id"

if root=$(git rev-parse --show-toplevel 2>/dev/null); then
    INIT_DIR="${1:-$root/local/postgres/init}"
else
    INIT_DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)/local/postgres/init}"
fi

if [[ ! -d "$INIT_DIR" ]]; then
    echo "FAIL: not a directory: $INIT_DIR" >&2
    echo "      The predicate check did not run. This is not a pass." >&2
    exit 2
fi

# Emit one record per definition:
#   ##BLOCK <fn> <file> <line-number of its expiry condition, or 0>
#   <normalised condition>...
# Conditions keep their trailing comments: the migration's claim is
# "textually identical, comment for comment", so that is what is enforced.
scan() {
    local dir="$1" f
    while IFS= read -r f; do
        awk -v peek="$FN_PEEK" -v consume="$FN_CONSUME" '
            function flush() {
                if (n > 0) {
                    print "##BLOCK " fn " " FILENAME " " expline
                    for (i = 1; i <= n; i++) print conds[i]
                }
                n = 0; expline = 0
            }
            /CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?FUNCTION[[:space:]]+space\./ {
                if (inb) flush()
                inb = 0
                if (index($0, "space." peek "(")    > 0) { inb = 1; fn = peek }
                if (index($0, "space." consume "(") > 0) { inb = 1; fn = consume }
                next
            }
            inb && /^[[:space:]]*\$[A-Za-z_]*\$;/ { flush(); inb = 0; next }
            inb && /^[[:space:]]*(WHERE|AND)[[:space:]]/ {
                line = $0
                if (line ~ /l\.expires_at[[:space:]]*>[[:space:]]*now\(\)/) expline = FNR
                sub(/^[[:space:]]*(WHERE|AND)[[:space:]]+/, "", line)
                gsub(/[[:space:]]+/, " ", line)
                sub(/[[:space:]]+$/, "", line)
                if (line != "") conds[++n] = line
            }
            END { if (inb) flush() }
        ' "$f"
    done < <(LC_ALL=C find "$dir" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)
}

# Pull the sorted condition set of the Nth (1-based) block of a function.
block_conditions() {
    local data="$1" fn="$2" want="$3"
    awk -v fn="$fn" -v want="$want" '
        /^##BLOCK / { seen = ($2 == fn) ? seen + 1 : seen; on = ($2 == fn && seen == want); next }
        on && !/^##BLOCK / { print }
    ' <<<"$data" | LC_ALL=C sort
}

# A condition with its trailing comment removed.
bare() { sed -E 's/[[:space:]]*--[[:space:]].*$//'; }

# Conditions where BOTH sides carry a comment and the two comments disagree.
comment_clash() {
    awk -v A="$1" -v B="$2" '
        function key(s,  p) { p = index(s, " -- "); return p ? substr(s, 1, p - 1) : s }
        function cmt(s,  p) { p = index(s, " -- "); return p ? substr(s, p + 4)   : "" }
        BEGIN {
            m = split(B, b, "\n")
            for (i = 1; i <= m; i++) { c = cmt(b[i]); if (c != "") live[key(b[i])] = c }
            n = split(A, a, "\n")
            for (i = 1; i <= n; i++) {
                k = key(a[i]); c = cmt(a[i])
                if (c != "" && (k in live) && live[k] != c)
                    printf "%s\n  superseded: -- %s\n  live:       -- %s\n", k, c, live[k]
            }
        }'
}

block_count() { grep -c "^##BLOCK $2 " <<<"$1" || true; }
block_file()  { awk -v fn="$2" -v want="$3" '/^##BLOCK /{ if ($2==fn){c++; if(c==want){print $3; exit}} }' <<<"$1"; }
block_expln() { awk -v fn="$2" -v want="$3" '/^##BLOCK /{ if ($2==fn){c++; if(c==want){print $4; exit}} }' <<<"$1"; }

# Returns 0 agree, 1 drifted, 2 nothing to compare. Prints the difference.
compare_dir() {
    local dir="$1" quiet="${2:-}" data np nc live_peek live_consume i other only_a only_b
    data=$(scan "$dir")
    np=$(block_count "$data" "$FN_PEEK")
    nc=$(block_count "$data" "$FN_CONSUME")

    if (( np == 0 || nc == 0 )); then
        [[ -z $quiet ]] && {
            echo "  found $np definition(s) of $FN_PEEK and $nc of $FN_CONSUME" >&2
            echo "  Nothing was compared. Silence is not agreement." >&2
        }
        return 2
    fi

    live_peek=$(block_conditions "$data" "$FN_PEEK" "$np")
    live_consume=$(block_conditions "$data" "$FN_CONSUME" "$nc")

    local failed=0
    only_a=$(comm -23 <(printf '%s\n' "$live_peek") <(printf '%s\n' "$live_consume"))
    only_b=$(comm -13 <(printf '%s\n' "$live_peek") <(printf '%s\n' "$live_consume") | grep -vxF "$ALLOWED_ONLY_IN_CONSUME")
    if [[ -n "$only_a" || -n "$only_b" ]]; then
        failed=1
        [[ -z $quiet ]] && {
            echo "  LIVE PAIR DISAGREES"
            echo "    $FN_PEEK    <- $(basename "$(block_file "$data" "$FN_PEEK" "$np")")"
            echo "    $FN_CONSUME <- $(basename "$(block_file "$data" "$FN_CONSUME" "$nc")")"
            [[ -n "$only_a" ]] && printf '    only in peek:\n%s\n'    "$(sed 's/^/      /' <<<"$only_a")"
            [[ -n "$only_b" ]] && printf '    only in consume:\n%s\n' "$(sed 's/^/      /' <<<"$only_b")"
        }
    fi

    # Superseded copies: conditions must match exactly; a comment must match
    # only where the superseded copy carries one. Absence is fine — that is
    # why the bootstrap in 20260816 is not a failure. Contradiction is not.
    local fn total live live_bare other_bare clash
    for fn in "$FN_PEEK" "$FN_CONSUME"; do
        total=$(block_count "$data" "$fn")
        live=$(block_conditions "$data" "$fn" "$total")
        live_bare=$(bare <<<"$live")
        for (( i = 1; i < total; i++ )); do
            other=$(block_conditions "$data" "$fn" "$i")
            other_bare=$(bare <<<"$other")
            if [[ "$other_bare" != "$live_bare" ]]; then
                failed=1
                [[ -z $quiet ]] && {
                    echo "  SUPERSEDED COPY HAS DRIFTED — conditions differ"
                    echo "    $fn in $(basename "$(block_file "$data" "$fn" "$i")"), against the live"
                    echo "    definition in $(basename "$(block_file "$data" "$fn" "$total")"):"
                    diff <(printf '%s\n' "$other_bare") <(printf '%s\n' "$live_bare") | sed 's/^/      /'
                }
                continue
            fi
            clash=$(comment_clash "$other" "$live")
            if [[ -n "$clash" ]]; then
                failed=1
                [[ -z $quiet ]] && {
                    echo "  SUPERSEDED COPY HAS DRIFTED — a comment contradicts the live one"
                    echo "    $fn in $(basename "$(block_file "$data" "$fn" "$i")"):"
                    sed 's/^/      /' <<<"$clash"
                }
            fi
        done
    done
    return $failed
}

# --- positive controls ---------------------------------------------------
# Break the live definition, then break a superseded copy, and require each
# to be caught. A check that cannot fail has said nothing when it passes.
control() {
    local label="$1" fn="$2" which="$3" how="${4:-condition}" tmp data file ln
    tmp=$(mktemp -d)
    cp "$INIT_DIR"/*.sql "$tmp"/ 2>/dev/null
    data=$(scan "$tmp")
    local total; total=$(block_count "$data" "$fn")
    (( which < 0 )) && which=$(( total + 1 + which ))
    (( which < 1 || which > total )) && { rm -rf "$tmp"; echo "skip"; return 0; }
    file=$(block_file "$data" "$fn" "$which"); ln=$(block_expln "$data" "$fn" "$which")
    if [[ -z "$file" || "$ln" == "0" ]]; then rm -rf "$tmp"; echo "skip"; return 0; fi
    if [[ "$how" == "comment" ]]; then
        # Give the superseded copy a trailing comment that contradicts the
        # live one for the same condition.
        awk -v n="$ln" 'FNR==n { sub(/[[:space:]]*--[[:space:]].*$/, ""); $0 = $0 "  -- expiry is enforced elsewhere" } { print }' \
            "$file" > "$file.m" && mv "$file.m" "$file"
    else
        awk -v n="$ln" 'FNR==n { sub(/>[[:space:]]*now\(\)/, ">= now()") } { print }' "$file" > "$file.m" && mv "$file.m" "$file"
    fi
    compare_dir "$tmp" quiet >/dev/null 2>&1
    local rc=$?
    rm -rf "$tmp"
    if (( rc == 0 )); then
        echo "FAIL: positive control '$label' PASSED." >&2
        echo "      A deliberately broken copy was reported as agreeing, so this" >&2
        echo "      script is not checking anything. Fix the script, not the SQL." >&2
        exit 2
    fi
    echo "ok"
}

c1=$(control "broken condition, live definition"  "$FN_CONSUME" -1 condition)
c2=$(control "broken condition, superseded copy" "$FN_CONSUME"  1 condition)
c3=$(control "contradicting comment, superseded" "$FN_CONSUME"  1 comment)

# c2 and c3 legitimately report "skip" when there is no superseded copy to
# break. c1 has nothing to skip: if it did not run, no control ran, and a
# PASS below would mean only that nothing was tested.
if [[ "$c1" != "ok" ]]; then
    echo "FAIL: the live-definition control did not run (result: $c1)." >&2
    echo "      Nothing has demonstrated that this script can fail, so it will" >&2
    echo "      not report on the real files. Fix the script, not the SQL." >&2
    exit 2
fi

# --- the real comparison -------------------------------------------------
echo "Checking $INIT_DIR"
_scan=$(scan "$INIT_DIR")
echo "  definitions found: $FN_PEEK $(block_count "$_scan" "$FN_PEEK"), $FN_CONSUME $(block_count "$_scan" "$FN_CONSUME") (last of each is live)"
compare_dir "$INIT_DIR"; verdict=$?

case $verdict in
  0) echo "PASS: the public-link gate says one thing everywhere."
     echo "      controls: live=$c1 superseded=$c2 comment=$c3" ;;
  1) echo "FAIL: the public-link gate does not say one thing." >&2
     echo "      controls: live=$c1 superseded=$c2 comment=$c3" >&2 ;;
  2) echo "FAIL: could not find both functions. The check did not run." >&2 ;;
esac
exit $verdict

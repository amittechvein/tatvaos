#!/usr/bin/env bash
# =============================================================================
#  verify-loss-refund.sh — prove the storage-loss path actually works
# =============================================================================
#
#  WHAT THIS PROVES
#
#  When a public link resolves but the file's BYTES are gone from the volume,
#  three things must happen (SpaceLinkEndpoints.DownloadAsync):
#
#    1. the recipient sees the ordinary "link does not exist or has expired",
#       not a stack trace;
#    2. a WARNING is logged naming fileId, linkId and blobKey;
#    3. the download count is REFUNDED, because the recipient must not pay a
#       download for our fault (review finding F1).
#
#  None of that has ever executed. It only fires when a blob is missing, and
#  no blob has ever gone missing. The path also contains a SQL-to-C# column
#  mapping that no compiler checks — read it and it looks right; that is not
#  the same as knowing.
#
#  WHY A SCRIPT AND NOT A LIST OF COMMANDS
#
#  The manual recipe ends in `rm` against the live blob volume, driven by a
#  key pasted by hand. A wrong key destroys a customer's file with no undo,
#  and there is no confirmation step between the paste and the loss. That is
#  an unacceptable shape for a five-minute test, so the dangerous part is
#  automated and guarded instead:
#
#    · the filename MUST match delete-me-test-*  — this script structurally
#      cannot be pointed at a customer's file, however it is invoked;
#    · the query must return EXACTLY ONE row, so a repeated test name stops
#      it rather than deleting the wrong one of two;
#    · the blob must be under 1 MiB, because the throwaway file is tiny and
#      anything large means the key is wrong;
#    · the operator confirms by typing DELETE, having been shown the name,
#      the size and the key.
#
#  Any guard failing is a refusal, never a warning-and-continue.
#
#  USAGE — on the server, from the repo root:
#
#      1. In Space, upload a small throwaway file named
#         delete-me-test-YYYYMMDD.txt
#      2. Create a public link on it, max downloads 2. Keep the URL.
#      3. bash infra/scripts/verify-loss-refund.sh delete-me-test-YYYYMMDD.txt
#
#  Safe to re-run: use a new date in the filename each time.
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '        · %s\n' "$1"; }
head2(){ printf '\n  %s\n  %s\n' "$1" "$(printf '%.0s─' $(seq 1 60))"; }

FAILED=0

# ---- 0. The file name is the primary guard ---------------------------------
NAME="${1:-}"
if [[ -z "$NAME" ]]; then
    echo "usage: $0 delete-me-test-YYYYMMDD.txt" >&2
    exit 2
fi
if [[ "$NAME" != delete-me-test-* ]]; then
    echo "REFUSING: the file must be named delete-me-test-*" >&2
    echo "This script deletes bytes from the live volume. The name prefix is" >&2
    echo "what makes it impossible to point at a customer's file." >&2
    exit 2
fi

# ---- 1. Free check while we are here: is outbound TLS actually running? -----
#
#  Merged is not running. Twice this week we tested against code that had
#  never deployed, so the config being right in git is checked against the
#  process that is actually serving mail.
head2 "outbound TLS (free check — different subsystem, same visit)"
PF=$(docker ps --format '{{.Names}}' | grep -i postfix | head -1)
if [[ -z "$PF" ]]; then
    bad "no postfix container running — cannot verify"
    FAILED=1
else
    LEVEL=$(docker exec "$PF" postconf -h smtp_tls_security_level 2>/dev/null | tr -d '\r')
    if [[ "$LEVEL" == "may" ]]; then
        ok "smtp_tls_security_level = may — the RUNNING process, not the file"
    else
        bad "smtp_tls_security_level = '${LEVEL:-unset}', expected 'may'"
        info "the fix is on main but this container has not picked it up"
        info "reload postfix, then re-run"
        FAILED=1
    fi
fi

# ---- 2. Locate the containers and the volume -------------------------------
head2 "locating the pieces"
PG=$(docker ps --format '{{.Names}}' | grep postgres | head -1)
[[ -n "$PG" ]] && ok "postgres container: $PG" || { bad "no postgres container"; exit 1; }

VOL=$(docker volume ls --format '{{.Name}}' | grep spaceblobs | head -1)
[[ -n "$VOL" ]] && ok "blob volume: $VOL" || { bad "no spaceblobs volume found"; exit 1; }
info "discovered, not assumed — the compose project prefix is not guaranteed"

API=$(docker ps --format '{{.Names}}' | grep -E '(^|[-_])api' | head -1)
[[ -n "$API" ]] && ok "api container: $API" || info "no api container found; log check will be skipped"

PSQL=(docker exec -i "$PG" psql -U postgres -d tatvaos_mail -tAF'|')

# ---- 3. Find the row, and insist there is exactly one ----------------------
head2 "the test file"
ROWS=$("${PSQL[@]}" -c "
    select f.id, f.blob_key, f.size_bytes, l.id, l.download_count
      from space.files f
      join space.public_links l on l.file_id = f.id
     where f.name = '${NAME//\'/\'\'}'
       and f.deleted_at is null;" 2>/dev/null | grep -c '|')

if [[ "$ROWS" -eq 0 ]]; then
    bad "no live file named '$NAME' with a public link"
    info "upload it in Space and create a link first (see the header)"
    exit 1
fi
if [[ "$ROWS" -gt 1 ]]; then
    bad "$ROWS rows match '$NAME' — refusing"
    info "a repeated test name means deleting the wrong one of two. Use a new date."
    exit 1
fi
ok "exactly one matching file and link"

IFS='|' read -r FILE_ID BLOB_KEY SIZE LINK_ID COUNT_BEFORE < <("${PSQL[@]}" -c "
    select f.id, f.blob_key, f.size_bytes, l.id, l.download_count
      from space.files f
      join space.public_links l on l.file_id = f.id
     where f.name = '${NAME//\'/\'\'}'
       and f.deleted_at is null;")

info "fileId   $FILE_ID"
info "linkId   $LINK_ID"
info "blobKey  $BLOB_KEY"
info "size     $SIZE bytes"
info "count    $COUNT_BEFORE (this must NOT change)"

if [[ "$SIZE" -gt 1048576 ]]; then
    bad "that file is over 1 MiB — the throwaway file should be tiny"
    info "refusing: a large file means the key is not what you think it is"
    exit 1
fi
ok "under 1 MiB, consistent with a throwaway test file"

if ! docker run --rm -v "${VOL}:/b:ro" alpine test -f "/b/${BLOB_KEY}"; then
    bad "the blob is already absent from the volume"
    info "nothing to delete; the test cannot prove anything from here"
    exit 1
fi
ok "the blob is present on the volume, about to be removed"

# ---- 4. The one irreversible step, behind an explicit confirmation ---------
head2 "confirm"
echo "  About to delete these bytes from ${VOL}:"
echo "      ${BLOB_KEY}   (${SIZE} bytes, ${NAME})"
echo
echo "  The database row stays. Only the bytes go. This is the fault we are"
echo "  simulating, and it cannot be undone."
echo
read -r -p "  Type DELETE to proceed: " CONFIRM
[[ "$CONFIRM" == "DELETE" ]] || { echo "  Cancelled. Nothing was deleted."; exit 0; }

docker run --rm -v "${VOL}:/b" alpine rm -f "/b/${BLOB_KEY}" \
    && ok "bytes removed" \
    || { bad "removal failed"; exit 1; }

# ---- 5. Now make the fault happen ------------------------------------------
head2 "trigger it"
echo "  Open the public link in a PRIVATE window now."
echo "  Expected: the ordinary 'this link does not exist or has expired'."
echo
read -r -p "  Press Enter once you have opened it: " _

# ---- 6. The three things that must all be true -----------------------------
head2 "results"

# (a) the count was refunded
COUNT_AFTER=$("${PSQL[@]}" -c "
    select download_count from space.public_links where id = '${LINK_ID}';")
if [[ "$COUNT_AFTER" == "$COUNT_BEFORE" ]]; then
    ok "download_count unchanged at $COUNT_AFTER — the refund posted"
else
    bad "download_count went $COUNT_BEFORE -> $COUNT_AFTER"
    info "the refund did not post; a recipient would have lost a download to our fault"
    FAILED=1
fi

# (b) the warning was logged, naming all three fields
if [[ -n "${API:-}" ]]; then
    LOG=$(docker logs "$API" --tail 300 2>&1 | grep -i "REFUNDED" | tail -1)
    if [[ -z "$LOG" ]]; then
        bad "no REFUNDED warning in the last 300 log lines"
        info "the logging never fired — check the endpoint was actually reached"
        FAILED=1
    else
        ok "warning logged"
        for field in "$FILE_ID" "$LINK_ID" "$BLOB_KEY"; do
            if grep -qF "$field" <<<"$LOG"; then
                ok "  names $field"
            else
                bad "  does NOT name $field"
                info "a log line that omits the key cannot tell you whether one file"
                info "went or a whole prefix did — which is the point of logging it"
                FAILED=1
            fi
        done
    fi
else
    info "api container not found — check the log by hand for REFUNDED"
fi

# (c) the page was ordinary. Only the operator can judge this one.
echo
read -r -p "  Did the page show the NORMAL 'link does not exist' message? [y/N] " PAGE
if [[ "$PAGE" == "y" || "$PAGE" == "Y" ]]; then
    ok "the recipient saw the ordinary message, not an error"
else
    bad "the page was not the ordinary message"
    info "a raw error here means the response path threw rather than returning"
    info "the 404 — the failure this whole test exists to find"
    FAILED=1
fi

head2 "verdict"
if [[ "$FAILED" -eq 0 ]]; then
    ok "the storage-loss path works. It has now actually run, once."
    info "clean up: delete $NAME from Space when you are done"
    exit 0
else
    bad "something above is wrong — do not close this terminal, the detail is above"
    exit 1
fi

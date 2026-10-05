#!/usr/bin/env bash
#
# TatvaOS — the nightly backup
#
#   ./infra/scripts/backup.sh            # run it now
#   ./infra/scripts/backup.sh --install  # install (or update) the cron entry
#
# Run ON the production server, from the repo checkout.
#
# ─────────────────────────────────────────────────────────────────────────
#  WHY THIS EXISTS SEPARATELY FROM deploy.sh
#
#  deploy.sh takes a pre-deploy Postgres dump, and until Space shipped that
#  was genuinely everything: mail lives in the maildir, but the maildir was
#  reproducible from nothing that mattered more than the database.
#
#  It is no longer everything. Space stores FILE BYTES on a docker volume,
#  behind opaque blob keys whose only index is the database. A lost volume is
#  not "restore from yesterday" — it is every document every customer has
#  uploaded, gone, with a database full of rows pointing at nothing. And the
#  maildir is the actual mail.
#
#  It is deliberately NOT part of deploy.sh: copying tens of gigabytes of
#  blobs on every deploy makes deploying slow enough that people stop doing
#  it, and a backup that only runs when someone deploys is not a backup.
#
#  THIS IS STILL A ONE-MACHINE BACKUP. It protects against deleting a volume,
#  a bad migration, a corrupted file. It does NOT protect against losing the
#  server. Getting BACKUP_REMOTE set below is the difference between a backup
#  and a comforting ritual.
# ─────────────────────────────────────────────────────────────────────────

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

# rclone lives in ~/bin — installed WITHOUT sudo, because the deploy user has
# none. Cron runs with a bare PATH, so the script says where to look rather
# than hoping the environment does.
export PATH="$HOME/bin:$PATH"

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); B=$(c $'\033[1m'); X=$(c $'\033[0m')
step() { printf '\n%s%s>> %s%s\n' "$B" "$C" "$1" "$X"; }
ok()   { printf '   %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
bad()  { printf '   %s[FAIL]%s %s\n' "$R" "$X" "$1"; }
warn() { printf '   %s[warn]%s %s\n' "$Y" "$X" "$1"; }
note() { printf '   %s%s%s\n' "$D" "$1" "$X"; }

# ONE OPTION AT MOST, AND ONLY ONE WE KNOW. Until 2 Oct 2026 an argument this
# script did not recognise was ignored and a FULL backup ran - found when
# --recordings-only, before it existed, made a set and thinned the bucket
# from 120 to 22 in a test. A typo (--recordings-onyl) or an option from
# another script must do nothing, and say so, before anything is touched.
# (Mr. Singh: "a script that silently ignores a flag is a hazard".)
if [ "$#" -gt 1 ]; then
    bad "one option at most (got $#: $*) — nothing was done"
    exit 2
fi
case "${1:-}" in
    ""|--install|--recordings-only) ;;
    *)  bad "unknown option \"$1\" — nothing was done. Options: --install, --recordings-only, or none for a full backup."
        exit 2 ;;
esac

DEST="${BACKUP_DIR:-/srv/backups/tatvaos}"

# The config file loads FIRST, before any BACKUP_* default is read — it used
# to load just before the upload step, which meant a BACKUP_KEEP_DAYS put in
# it was silently ignored by the retention logic that had already run its
# default. One file, loaded once, before anything reads a knob.
S3_CONF="${DEST}/.backup-env"
if [ -f "$S3_CONF" ]; then
    # set -a EXPORTS everything the file sets — openssl and rclone are child
    # processes and an unexported passphrase broke the first upload.
    set -a
    # shellcheck disable=SC1090
    . "$S3_CONF"
    set +a
fi

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# The tiered schedule (backup-tiers.sh): a set every 2 hours, thinned to one
# per 6 hours after a day and one per day after two, gone after a week. Off
# unless BACKUP_S3_TIERED=1, so merging this changes nothing on the server
# until .backup-env and the cron line are changed on purpose.
TIERED="${BACKUP_S3_TIERED:-}"
# How many sets stay on THIS disk once a set is safely off the box. Unset =
# the old rule, KEEP_DAYS days. Twelve sets a day at several GB each would
# fill the disk within days, so the tiered schedule refuses to install
# without this.
LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-}"
# 0 would delete the set this run has just made; anything not a number would
# make the prune below do something nobody chose. Refuse both, loudly.
if [ -n "$LOCAL_KEEP" ] && ! [[ "$LOCAL_KEEP" =~ ^[1-9][0-9]*$ ]]; then
    printf '[FAIL] BACKUP_LOCAL_KEEP must be a whole number, 1 or more (got "%s")\n' "$LOCAL_KEEP"
    exit 1
fi
# rsync/scp target for off-box copies, e.g. user@host:/backups/tatvaos.
# Empty means local only — which is a single point of failure, loudly.
REMOTE="${BACKUP_REMOTE:-}"

# UTC BY NAME, not by the machine's default. backup-tiers.sh reads this stamp
# back to decide what to delete, and it reads it as UTC. If the server's zone
# is ever set to IST (the metering counts months in IST; someone will), a
# stamp written in local time would be read 5½ hours off, the 6-hour slots
# would shift, and nothing would say so. Production is UTC today, so this
# changes nothing there — it stops it changing later. (Mr. Singh, 25 Sept.)
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="${DEST}/${STAMP}"

# ---------------------------------------------------------------------------
#  Off-box copy of meeting recordings. Defined here so --recordings-only
#  (below the lock) can run it alone; a full run calls it after the main
#  set's upload, at the step of the same name.
#
#  Recordings are the one artefact the scheduled set leaves out (every two
#  hours on production since 26 Sept 2026): at ~10 GB they would triple every
#  upload (Mr. Singh, 24 Sept 2026). Losing the box
#  today loses up to 30 days of them — for a school, lessons. So they are
#  COPIED, never mirrored: `rclone copy` uploads only what is new and never
#  deletes, so a recording removed on the server — by the age-off, a bug, a
#  user or a mistaken command — stays recoverable in the bucket for the rest
#  of its 31 days. A separate prune by AGE alone (`--min-age 31d`) keeps the
#  bucket from outliving the product's own retention. (Mr. Singh, 25 Sept:
#  "a pure mirror isn't a backup against deletion.") Cost at 10 GB: about
#  twenty cents a month.
#
#  ENCRYPTED WITH THE SAME PAPER PASSPHRASE, NO NEW SECRET. rclone's crypt
#  backend is configured here, in the environment, for these commands only:
#  its password is BACKUP_ENC_PASSPHRASE obscured, so the passphrase that
#  opens the sets also opens the recordings. Filenames are encrypted too (a
#  recording's name carries a meeting id). Nothing is written to rclone.conf
#  and nothing is printed.
#
#  THE RECEIPT: EVERY FILE ON THE VOLUME IS ALSO IN THE BUCKET. Counts can no
#  longer be equal — the bucket keeps files the age-off has removed — so the
#  check is set difference, not arithmetic: the volume's file list minus the
#  bucket's must be empty. Extra files in the bucket are fine; one missing is
#  the failure. `rclone copy` exiting 0 after copying nothing is the
#  false-pass shape this project keeps finding; the listing is the receipt.
#
#  THIS STEP CANNOT FAIL THE MAIN SET. It runs after the set has been built
#  and uploaded, keeps its own verdict in rec_failed, and never sets `failed`.
#  Losing a recording is bad; losing last night's mail backup because a
#  recording upload failed would be worse. Its failure is printed in capitals
#  and repeated in the summary, so it is loud without being fatal.
#
#  Off by default until Amit's go lands in .backup-env:
#      BACKUP_RECORDINGS_REMOTE='linode:tatvaos-recordings'
#      BACKUP_RECORDINGS_KEEP_DAYS=31                      # optional
# ---------------------------------------------------------------------------
copy_recordings_offbox() {
    rec_failed=0
    if [ -n "${BACKUP_RECORDINGS_REMOTE:-}" ] && [ -n "${BACKUP_S3_REMOTE:-}" ] && [ -n "${BACKUP_ENC_PASSPHRASE:-}" ]; then
        if ! command -v rclone >/dev/null 2>&1; then
            bad "RECORDINGS: rclone is not installed — recordings were NOT copied off the box"
            rec_failed=1
        else
            # A crypt remote that exists only for this process.
            export RCLONE_CONFIG_RECCRYPT_TYPE=crypt
            export RCLONE_CONFIG_RECCRYPT_REMOTE="$BACKUP_RECORDINGS_REMOTE"
            export RCLONE_CONFIG_RECCRYPT_FILENAME_ENCRYPTION=standard
            export RCLONE_CONFIG_RECCRYPT_DIRECTORY_NAME_ENCRYPTION=true
            RCLONE_CONFIG_RECCRYPT_PASSWORD=$(rclone obscure "$BACKUP_ENC_PASSPHRASE")
            export RCLONE_CONFIG_RECCRYPT_PASSWORD
            RC_ENV="-e RCLONE_CONFIG_RECCRYPT_TYPE -e RCLONE_CONFIG_RECCRYPT_REMOTE -e RCLONE_CONFIG_RECCRYPT_FILENAME_ENCRYPTION -e RCLONE_CONFIG_RECCRYPT_DIRECTORY_NAME_ENCRYPTION -e RCLONE_CONFIG_RECCRYPT_PASSWORD"
            # Pinned by DIGEST, not by tag (Mr. Singh, 2 Oct 2026, as the render
            # image is): `1.68` is a moving tag, and the backup path must not
            # change because someone pushed to Docker Hub. 1.68.2's multi-arch
            # index digest, read from Docker Hub on 2 Oct 2026 (the `1.68` tag
            # pointed at the same digest that day). To move it, look up the new
            # tag's digest, change both halves, and re-run the proof.
            RC_IMG="rclone/rclone:1.68.2@sha256:74c51b8817e5431bd6d7ed27cb2a50d8ee78d77f6807b72a41ef6f898845942b"
            rc() { docker run --rm $RC_ENV -v "$HOME/.config/rclone:/config/rclone:ro" "$@"; }
            REC_TMP=$(mktemp -d)
            # What of rclone's output may reach the log: an ALLOW list, not a
            # deny list. The 2 Oct 2026 proof run printed a recording's name
            # through rclone's once-a-minute "Transferring:" block, which the
            # first version's "drop the INFO lines" filter did not know about.
            # So only the totals pass, plus error/notice lines with the file
            # part replaced; anything else rclone prints, now or in a later
            # version, is dropped.
            rec_safe_log() {
                grep -E '^[[:space:]]*(Transferred|Checks|Elapsed time|Errors|Deleted|Renamed):|ERROR|NOTICE' "$1" \
                    | sed -E 's/((ERROR|NOTICE)[[:space:]]*:[[:space:]]*)[^:]+:[[:space:]]/\1<a recording>: /' \
                    | sed 's/^/   /'
            }
            # The volume is read only, through a throwaway container, the same
            # way the other volumes are read above. Bytes stream from the volume
            # to the bucket; nothing lands on the root disk.
            if docker run --rm -v tatvaos_connectrec:/src:ro alpine sh -c 'cd /src && find . -type f | sed "s#^\./##" | sort' > "$REC_TMP/volume" 2>/dev/null; then
                on_volume=$(wc -l < "$REC_TMP/volume")
                # -v names every file it copies, and a recording's name carries a
                # meeting id: the output goes to a temp file, only the COUNT of
                # uploads is printed, and every line except those per-file INFO
                # lines (errors, warnings, the transfer totals) is shown as before.
                # The count is the proof the copy is incremental: a second run
                # straight after the first must say 0.
                if rc -v tatvaos_connectrec:/src:ro "$RC_IMG" copy /src reccrypt: --transfers 2 -v > "$REC_TMP/copy.log" 2>&1; then
                    uploaded=$(grep -c -E 'Copied \((new|replaced)' "$REC_TMP/copy.log")
                    rec_safe_log "$REC_TMP/copy.log"
                    rc "$RC_IMG" lsf -R --files-only reccrypt: 2>/dev/null | sort > "$REC_TMP/bucket"
                    # Set difference: on the volume but not in the bucket.
                    missing=$(comm -23 "$REC_TMP/volume" "$REC_TMP/bucket" | wc -l)
                    in_bucket=$(wc -l < "$REC_TMP/bucket")
                    if [ "$missing" -eq 0 ] && [ "$in_bucket" -ge "$on_volume" ]; then
                        ok "recordings copied — every one of the ${on_volume} files on the volume is in the bucket (${in_bucket} there, encrypted); ${uploaded} uploaded this run"
                        # Prune by age alone, never by what the volume has.
                        rc "$RC_IMG" delete --min-age "${BACKUP_RECORDINGS_KEEP_DAYS:-31}d" reccrypt: 2>/dev/null
                        note "bucket keeps recordings ${BACKUP_RECORDINGS_KEEP_DAYS:-31} days, whatever the volume does"
                    else
                        bad "RECORDINGS: ${missing} file(s) on the volume are NOT in the bucket (${in_bucket} there, ${on_volume} on the volume)"
                        rec_failed=1
                    fi
                else
                    bad "RECORDINGS: copy FAILED — the bucket may be behind the volume"
                    rec_safe_log "$REC_TMP/copy.log" | tail -20
                    rec_failed=1
                fi
            else
                bad "RECORDINGS: could not read the recordings volume — nothing was copied"
                rec_failed=1
            fi
            rm -rf "$REC_TMP"
            unset RCLONE_CONFIG_RECCRYPT_PASSWORD
        fi
    else
        note "recordings copy not configured (BACKUP_RECORDINGS_REMOTE unset) — recordings exist only on this machine"
    fi
    # The main set's verdict is untouched by the above. Say so if it went wrong,
    # loudly, where the summary will be read.
    if [ "$rec_failed" -ne 0 ]; then
        printf '\n   %s%sRECORDINGS WERE NOT FULLY COPIED OFF THE BOX — see above. The main backup set is unaffected.%s\n\n' "$B" "$R" "$X"
    fi
}

# ---------------------------------------------------------------------------
if [ "${1:-}" = "--install" ]; then
    # The log lives beside the backups, NOT in /var/log: that directory is
    # root-owned, the deploy user cannot create a file there, and cron would
    # have failed on the redirect before the script ever ran — silently,
    # every night, which is the worst way for a backup to be broken.
    mkdir -p "$DEST"
    # The schedule follows the retention rule, so the two cannot disagree:
    # every 2 hours only when the tiered thinning is on, otherwise every 6.
    # Two-hourly sets under the old 30-day rule would be ~360 sets in the
    # bucket, far past what the plan includes.
    if [ "$TIERED" = "1" ]; then
        if [ -z "$LOCAL_KEEP" ]; then
            bad "BACKUP_S3_TIERED=1 needs BACKUP_LOCAL_KEEP set too (see the top of this script)"
            exit 1
        fi
        WHEN="30 */2 * * *"; SAID="every 2 hours at half past"
    else
        WHEN="30 2,8,14,20 * * *"; SAID="every 6 hours (02:30, 08:30, 14:30, 20:30)"
    fi
    LINE="${WHEN} cd $(pwd) && ./infra/scripts/backup.sh >> ${DEST}/backup.log 2>&1"
    # Idempotent, and it REPLACES an existing entry rather than stacking a
    # second one — two entries would run two backups at once.
    old=$(crontab -l 2>/dev/null | grep -F 'infra/scripts/backup.sh')
    if [ "$old" = "$LINE" ]; then
        ok "cron entry already installed: $SAID"
    else
        [ -n "$old" ] && note "replacing: $old"
        (crontab -l 2>/dev/null | grep -vF 'infra/scripts/backup.sh'; echo "$LINE") | crontab -
        ok "installed: $SAID, logging to ${DEST}/backup.log"
    fi
    crontab -l | grep -F 'backup.sh' | sed 's/^/   /'
    exit 0
fi

mkdir -p "$DEST" || { bad "cannot write $DEST"; exit 1; }

# One backup at a time. At every 2 hours a slow run (a big mail import, a
# slow bucket) can still be going when the next one starts; two at once would
# double the disk used and race each other's retention.
exec 9>"${DEST}/.backup.lock"
if ! flock -n 9; then
    bad "the previous backup is still running — this run did nothing"
    exit 1
fi

# ---------------------------------------------------------------------------
#  --recordings-only: the recordings copy and nothing else, under the same
#  lock as a full run. No set is made, nothing is written to this disk, and
#  the main bucket is not touched: it reads the recordings volume and writes
#  only to BACKUP_RECORDINGS_REMOTE. Exit 0 only if every file on the volume
#  is in the bucket. Made for the proof run Mr. Singh asked for on 2 Oct 2026
#  (set the remote for that one command, run it twice: the second must say
#  "0 uploaded"), and for re-running the copy after a failure without waiting
#  two hours or making a 4 GB set.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--recordings-only" ]; then
    step "Off-box copy — meeting recordings ONLY (no set is made)"
    if [ -z "${BACKUP_RECORDINGS_REMOTE:-}" ]; then
        bad "BACKUP_RECORDINGS_REMOTE is not set — there is nothing to copy to"
        exit 1
    fi
    copy_recordings_offbox
    exit "$rec_failed"
fi

mkdir -p "$OUT" || { bad "cannot write $OUT"; exit 1; }

failed=0
offbox_ok=0

# ---------------------------------------------------------------------------
step "Database"
if docker ps --format '{{.Names}}' | grep -q postgres; then
    PG=$(docker ps --format '{{.Names}}' | grep postgres | head -1)
    # Compressed on the way out — a plain dump of a mail database is mostly
    # text and gzip takes roughly 90% of it away.
    if docker exec -t "$PG" pg_dumpall -U postgres 2>/dev/null | gzip > "${OUT}/postgres.sql.gz"; then
        ok "postgres.sql.gz ($(du -h "${OUT}/postgres.sql.gz" | cut -f1))"
    else
        bad "pg_dumpall failed"; failed=1
    fi
else
    bad "no postgres container running"; failed=1
fi

# ---------------------------------------------------------------------------
# Volumes, read through a throwaway alpine container: the volumes are owned by
# container users (5000 for blobs and vmail), so tarring them from the host as
# root works but reading them as the deploy user does not.
#
# Each volume is its own tarball. One combined archive means a single corrupt
# byte costs everything, and it makes "restore just the blobs" impossible.
# ---------------------------------------------------------------------------
backup_volume() {
    local vol="$1" name="$2"
    if ! docker volume inspect "$vol" >/dev/null 2>&1; then
        warn "$name: volume $vol does not exist — skipped"
        return
    fi
    if docker run --rm -v "${vol}:/src:ro" -v "${OUT}:/out" alpine \
           tar czf "/out/${name}.tar.gz" -C /src . 2>/dev/null; then
        ok "${name}.tar.gz ($(du -h "${OUT}/${name}.tar.gz" | cut -f1))"
    else
        bad "$name failed"; failed=1
    fi
}

step "Space file bytes"
# The database knows blob keys; only this volume has the bytes behind them.
backup_volume tatvaos_spaceblobs spaceblobs

step "Mail store"
backup_volume tatvaos_vmail vmail

# NOT here, on purpose: tatvaos_oidckeys, the OpenID Connect provider's RSA
# keys (decision 0004). A lost signing key is replaced by generating a new one
# and relying parties fetch it from the published key set; a backed-up copy
# is one more place the key that signs everyone's sign-in could be taken
# from. If you are adding a volume below and it is this one, stop.
step "DKIM keys"
# Small, and losing them means re-publishing DNS for every customer domain.
backup_volume tatvaos_dkimkeys dkimkeys

# ---------------------------------------------------------------------------
step "Meeting recordings"
#
#  Connect's recordings live in tatvaos_connectrec and were in no backup at
#  all until this was written — a new volume arrived with a new product and
#  nothing swept it up.
#
#  They are NOT backed up by default, and that is a judgement rather than an
#  oversight: nothing expires a recording yet, so this volume grows without
#  limit, and a nightly tar of unbounded video would eventually take longer
#  than a night and fill the disk it is protecting against. Retention is
#  decided (7/30/90/180/365, default 90 - docs/CONNECT_DECISIONS.md) but not
#  built. Turn this on once it is.
#
#  What it does unconditionally is REPORT THE SIZE, every night, so the gap
#  is visible rather than silently absent. A backup that quietly covers less
#  than you think is the failure mode this whole script exists to avoid.
# ---------------------------------------------------------------------------
rec_size=$(docker run --rm -v tatvaos_connectrec:/v alpine du -sh /v 2>/dev/null | cut -f1)
if [ "${BACKUP_RECORDINGS:-}" = "1" ]; then
    backup_volume tatvaos_connectrec connectrec
else
    note "recordings NOT backed up (${rec_size:-unknown} in tatvaos_connectrec)."
    note "Set BACKUP_RECORDINGS=1 once retention is enforced."
fi

# ---------------------------------------------------------------------------
step "Environment"
# The one file that is deliberately never committed, and without which none of
# the above can be brought back up.
if cp infra/docker/.env "${OUT}/env.txt" 2>/dev/null; then
    chmod 600 "${OUT}/env.txt"

    # The DIRECTORY, not only this file. env.txt was the only artefact locked
    # down, and it is the smallest secret here: postgres.sql.gz is every
    # tenant, user and password hash, vmail.tar.gz is everyone's mail, and both
    # land 644 — some owned by root, because the docker helper writes them, so
    # `deploy` cannot chmod them at all. 700 on the directory denies traversal
    # whatever mode or owner the files inside end up with, and keeps holding
    # for artefacts added later.
    chmod 700 "$OUT"  2>/dev/null || true
    chmod 700 "$DEST" 2>/dev/null || true
    ok "env.txt (secrets — 0600)"
else
    warn "infra/docker/.env not readable — skipped"
fi

# ---------------------------------------------------------------------------
step "Off-box copy — object storage"
#
#  THE WARNING BELOW FIRED EVERY NIGHT AND NOBODY HEARD IT. "This backup
#  exists only on this machine" was printed into a log that lives on the same
#  machine — the failure it warns about would have destroyed the warning too.
#  As of 24 Aug 2026 (Amit's ruling) the nightly set also goes to an
#  S3-compatible bucket in Mumbai.
#
#  ENCRYPTED BEFORE IT LEAVES, ALWAYS. env.txt inside this set is every secret
#  the platform has; a bucket is one leaked credential away from public, and
#  an unencrypted backup in it would be the single worst object to leak.
#  openssl AES-256 with a passphrase that lives in TWO places: the config file
#  below (so cron can encrypt), and ON PAPER with Amit (so losing this machine
#  does not mean holding backups nobody can open). The passphrase is typed in,
#  never generated-and-printed — every secret that has ever appeared on a
#  screen in this project has ended up in a chat transcript.
#
#  Credentials live in ${DEST}/.backup-env (0600), DELIBERATELY NOT in
#  infra/docker/.env: the app's env file is itself inside every backup, and
#  bucket credentials stored inside the thing the bucket holds is a loop that
#  hands both to whoever gets either.
#
#  Expected in ${DEST}/.backup-env:
#      BACKUP_S3_REMOTE='linode:tatvaos-backups'   # rclone remote:bucket
#      BACKUP_ENC_PASSPHRASE='...'                 # also on paper, offline
#      BACKUP_S3_KEEP_DAYS=7                       # optional; default 30, production sets 7.
#                                                  # Not used when BACKUP_S3_TIERED=1.
#      BACKUP_KEEP_DAYS=3                          # optional; default 14, production sets 3.
#                                                  # deploy.sh's pre-deploy copies use it too.
#      BACKUP_S3_TIERED=1                          # optional: the 2h/6h/daily schedule
#      BACKUP_LOCAL_KEEP=2                         # required with BACKUP_S3_TIERED
# ---------------------------------------------------------------------------
# (.backup-env is loaded at the top of the script, before any knob is read.)

if [ -n "${BACKUP_S3_REMOTE:-}" ] && [ -n "${BACKUP_ENC_PASSPHRASE:-}" ]; then
    if ! command -v rclone >/dev/null 2>&1; then
        bad "rclone is not installed — the off-box copy did NOT happen"
        failed=1
    else
        OBJECT="${BACKUP_S3_REMOTE}/${STAMP}.tar.gz.enc"
        # Streamed: tar -> encrypt -> upload, nothing large touches /tmp.
        # -pbkdf2 -iter 200000 because openssl's default key derivation is
        # weak enough to be a finding on its own.
        if tar czf - -C "$DEST" "$STAMP" \
             | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
                 -pass env:BACKUP_ENC_PASSPHRASE 2>/dev/null \
             | rclone rcat "$OBJECT" 2>&1 | sed 's/^/   /'; then

            # PROVE the object exists and is a plausible size. rcat returning
            # zero after writing zero bytes is exactly the false-pass shape
            # this project keeps finding; the listing is the receipt.
            SIZE=$(rclone size --json "$OBJECT" 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2)
            if [ -n "$SIZE" ] && [ "$SIZE" -gt 1024 ]; then
                ok "uploaded ${STAMP}.tar.gz.enc ($((SIZE / 1024 / 1024)) MB) — encrypted, off this machine"
                offbox_ok=1
            else
                bad "upload reported success but the object is missing or empty"
                failed=1
            fi

            # Bucket retention, independent of local retention — and only
            # after THIS run's set is proven to be in the bucket. A run whose
            # upload failed thins nothing.
            if [ "$offbox_ok" = "1" ] && [ "$TIERED" = "1" ]; then
                listing=$(rclone lsf --files-only "$BACKUP_S3_REMOTE" 2>/dev/null)
                if ! grep -qxF -- "${STAMP}.tar.gz.enc" <<< "$listing"; then
                    # The set just uploaded must be in the listing. If it is
                    # not, the listing is wrong (failed, truncated) and must
                    # not be read as "these are all the sets there are".
                    bad "the bucket listing does not show this run's set — retention skipped"
                    failed=1
                else
                    doomed=$(printf '%s\n' "$listing" | bash ./infra/scripts/backup-tiers.sh 2>"${OUT}.tiers-notes")
                    sed 's/^/   /' "${OUT}.tiers-notes"; rm -f "${OUT}.tiers-notes"
                    gone=0
                    while IFS= read -r obj; do
                        [ -z "$obj" ] && continue
                        # One named object at a time — never a recursive
                        # delete, so nothing else in the bucket can go.
                        if rclone deletefile "${BACKUP_S3_REMOTE}/${obj}" 2>/dev/null; then
                            gone=$((gone + 1))
                        else
                            warn "could not delete ${obj}"
                        fi
                    done <<< "$doomed"
                    left=$(rclone lsf --files-only "$BACKUP_S3_REMOTE" 2>/dev/null | grep -c '\.tar\.gz\.enc$')
                    note "tiered: every set for a day, 6-hourly to two days, daily to eight days (never less than seven)"
                    note "deleted ${gone}, ${left} set(s) in the bucket"
                fi
            elif [ "$offbox_ok" = "1" ]; then
                rclone delete --min-age "${BACKUP_S3_KEEP_DAYS:-30}d" "$BACKUP_S3_REMOTE" 2>/dev/null
                note "bucket keeps ${BACKUP_S3_KEEP_DAYS:-30} days"
            fi
        else
            bad "encrypt/upload FAILED — this backup exists only on this machine"
            failed=1
        fi
    fi
else
    warn "object-storage copy not configured (${S3_CONF} missing or incomplete)"
    note "This backup exists only on this machine and will not survive losing it."
fi

# ---------------------------------------------------------------------------
step "Off-box copy — meeting recordings (copy and age out)"
copy_recordings_offbox

step "Off-box copy — rsync (legacy hook)"
if [ -n "$REMOTE" ]; then
    if rsync -a --delete-after "${OUT}/" "${REMOTE}/${STAMP}/" 2>&1 | sed 's/^/   /'; then
        ok "copied to ${REMOTE}/${STAMP}"
    else
        bad "off-box copy FAILED — this backup exists only on this machine"; failed=1
    fi
else
    note "BACKUP_REMOTE not set — fine, the object-storage copy above is the off-box path."
fi

# ---------------------------------------------------------------------------
step "Retention"
if [ -n "$LOCAL_KEEP" ] && [ "$offbox_ok" = "1" ]; then
    # Keep only the newest LOCAL_KEEP sets on this disk. The bucket is the
    # history; the local sets are for a quick "restore one mailbox" without a
    # download. Only whole directories named like a stamp, only inside DEST,
    # and only on a run whose own set is proven off the box — otherwise the
    # local copies may be the only copies, and the old rule below applies.
    find "$DEST" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
         -regex '.*/[0-9]{8}-[0-9]{6}' -printf '%f\n' \
        | sort -r | tail -n "+$((LOCAL_KEEP + 1))" \
        | while IFS= read -r old; do rm -rf "${DEST:?}/${old}"; done
    ok "keeping the newest $LOCAL_KEEP set(s) here — $(find "$DEST" -mindepth 1 -maxdepth 1 -type d | wc -l) on disk"
else
    [ -n "$LOCAL_KEEP" ] && warn "this set is not proven off the box — keeping $KEEP_DAYS days of local sets, not $LOCAL_KEEP"
    # Only ever prunes inside DEST, and only whole timestamped directories.
    find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" \
         -exec rm -rf {} + 2>/dev/null
    ok "keeping $KEEP_DAYS days — $(find "$DEST" -mindepth 1 -maxdepth 1 -type d | wc -l) set(s) on disk"
fi

# ---------------------------------------------------------------------------
step "Verdict"
printf '   total %s in %s\n' "$(du -sh "$OUT" | cut -f1)" "$OUT"
# Repeated here because this is the line people read. It does not change the
# set's verdict or the exit code: see the recordings step.
if [ "${rec_failed:-0}" -ne 0 ]; then
    bad "RECORDINGS were NOT fully copied off the box this run (the set below is unaffected)"
fi
if [ "$failed" -eq 0 ]; then
    ok "backup complete"
else
    bad "backup finished WITH FAILURES — read the log above"
    exit 1
fi

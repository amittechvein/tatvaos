#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  restore-drill.sh — prove the off-box backup can actually be restored.
#
#  Step (a) of Mr. Singh's three-step order for removing the 323 old plain
#  pre-deploy copies (PR 254). The local half is done: on WSL, with real
#  Postgres, a real pg_dumpall was encrypted, restored into a separate cluster
#  and compared, 28/28, including tenancy across all 51 FORCE-RLS tables and
#  two calibrations that went red. This is the production half, and it proves
#  the one thing that cannot: that PRODUCTION's newest off-box object, written
#  by production's backup.sh with production's passphrase, restores.
#
#  ── WHAT THIS TOUCHES, STATED PLAINLY ───────────────────────────────────────
#
#  It runs ON the production box. It reads:
#    · the newest object in the off-box bucket (a full copy of everything);
#    · BACKUP_ENC_PASSPHRASE, to decrypt it (never printed, never logged);
#    · row COUNTS from the live database, to compare against — counts only,
#      no addresses, no message bodies, no names.
#  It writes only into a scratch directory it creates and destroys.
#  It NEVER writes to the live database. The drill container is started with
#  --network none, so it cannot reach the live database even by mistake.
#
#  ── THE THING MOST LIKELY TO GO WRONG ───────────────────────────────────────
#
#  A drill that fails halfway and leaves a decrypted copy of every customer's
#  data sitting in a stray container is a WORSE state than never having
#  drilled. Mr. Singh, 26 Sept: "the throwaway container is removed whatever
#  the outcome — put the cleanup in a trap, not at the end of the script."
#  So: cleanup() is trapped on EXIT, INT and TERM. EXIT is the one that
#  matters - under `set -e` a failed command exits, and every exit runs it,
#  including the paths I did not think of. (An ERR trap is deliberately NOT
#  added: it would fire in ADDITION to EXIT, not instead of it, and cleanup
#  would run twice.) It is written to be safe to run
#  twice and safe to run when nothing was created yet.
#
#  ── USAGE ───────────────────────────────────────────────────────────────────
#
#      ./restore-drill.sh --plan     # touches nothing; prints what it WOULD do
#      ./restore-drill.sh --run      # the drill
#
#  Run --plan first and read it. --run refuses unless the preconditions hold.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

# rclone lives in ~/bin on this box - installed without sudo, because the
# deploy user has none. backup.sh has said so since it was written: "Cron runs
# with a bare PATH, so the script says where to look rather than hoping the
# environment does." This script hoped, and --plan stopped on 26 Sept with
# "rclone not on PATH" while rclone was sitting in ~/bin all along.
export PATH="$HOME/bin:$PATH"

MODE="${1:---plan}"
case "$MODE" in --plan|--run) ;; *) echo "usage: $0 [--plan|--run]"; exit 2 ;; esac

STAMP="$(date -u +%Y%m%d-%H%M%S)"
PROD_DIR="/srv/tatvaos-production"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups/tatvaos}"
BACKUP_CONF="$BACKUP_DIR/.backup-env"
DRILL_NAME="tatvaos-restore-drill-$STAMP"
SCRATCH=""                      # set later; cleanup handles the empty case
MIN_FREE_GB=15                  # a 982 MB plain dump restores to a few GB;
                                # 15 is deliberately more than needed
PG_IMAGE="postgres:17"          # production's major version, not 18

ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; }
note() { echo "  --    $*"; }
die()  { echo; echo "STOPPED: $*"; exit 1; }

# ── CLEANUP: a trap, not a final line ────────────────────────────────────────
# Runs on every exit path. Never fails the script itself — a cleanup that
# throws would mask the drill's own result and, worse, stop later cleanup
# steps from running.
cleanup() {
    local rc=$?
    set +e
    echo
    echo "  cleanup (always runs)"
    if docker ps -aq --filter "name=^${DRILL_NAME}$" | grep -q .; then
        docker rm -f "$DRILL_NAME" >/dev/null 2>&1 \
            && ok "drill container removed" \
            || bad "COULD NOT REMOVE $DRILL_NAME — remove it by hand, it holds customer data"
    else
        ok "no drill container to remove"
    fi
    # The container was started with an anonymous volume; -v on rm takes it,
    # but check for strays too.
    docker volume ls -q --filter "name=${DRILL_NAME}" 2>/dev/null | while read -r v; do
        docker volume rm -f "$v" >/dev/null 2>&1 && ok "volume $v removed"
    done
    if [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ]; then
        # The decrypted dump is every customer's data in plain text. Overwrite
        # before unlinking where shred exists; remove either way.
        find "$SCRATCH" -type f -exec shred -u {} + 2>/dev/null
        rm -rf -- "$SCRATCH" \
            && ok "scratch directory removed" \
            || bad "COULD NOT REMOVE $SCRATCH — it may hold a decrypted copy"
    else
        ok "no scratch directory to remove"
    fi
    unset PASS RESTORE_PASS 2>/dev/null
    echo
    [ "$rc" -eq 0 ] && echo "DRILL FINISHED" || echo "DRILL STOPPED (exit $rc) — cleanup above still ran"
    exit "$rc"
}
trap cleanup EXIT INT TERM

echo
echo "restore-drill ($MODE) — $STAMP"
echo "============================================"

# ── PRECONDITIONS. All of them fail closed. ─────────────────────────────────
echo
echo "  preconditions"

[ -r "$BACKUP_CONF" ] || die "cannot read $BACKUP_CONF as $(id -un)"
ok "$BACKUP_CONF readable as $(id -un)"

# Same mechanism deploy.sh's conf_value uses.
conf_value() { ( set -a; . "$BACKUP_CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" ); }
REMOTE="$(conf_value BACKUP_S3_REMOTE)"
PASS="$(conf_value BACKUP_ENC_PASSPHRASE)"
[ -n "$REMOTE" ] || die "BACKUP_S3_REMOTE is empty"
[ -n "$PASS" ]   || die "BACKUP_ENC_PASSPHRASE is empty"
ok "remote and passphrase resolve (neither printed)"

# NO DEPLOY, AND NO DRILL, DURING A LIVE MEETING (Amit, 19 Sept). The drill
# does not restart anything, but it does take disk and I/O on the box that is
# carrying the meeting.
# Deliberately NOT probed here. I do not have a liveness check I have seen
# work, and a probe that always answers "unknown" is a check with no failure
# mode - it would read as reassurance while measuring nothing. This is a
# human gate: Amit confirms no meeting is live, in the same message as the go.
note "live meeting: NOT checked by this script. Amit confirms before --run."

FREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
if [ "${FREE_GB:-0}" -lt "$MIN_FREE_GB" ]; then
    die "only ${FREE_GB}G free on / — need ${MIN_FREE_GB}G. Clear the Docker build cache first (infra/scripts/deploy.sh does this automatically since #230); never prune volumes on this box."
fi
ok "${FREE_GB}G free on / (need ${MIN_FREE_GB}G)"

command -v rclone >/dev/null || die "rclone not on PATH"
command -v docker >/dev/null || die "docker not on PATH"
ok "rclone and docker present"

# ── WHAT WOULD BE RESTORED ──────────────────────────────────────────────────
echo
echo "  the object"

NEWEST="$(rclone lsf --files-only --format "tp" "$REMOTE" 2>/dev/null | sort | tail -1 | cut -d';' -f2-)"
[ -n "$NEWEST" ] || die "no objects listed at $REMOTE"
SIZE="$(rclone size --json "$REMOTE/$NEWEST" 2>/dev/null | tr -dc '0-9,{}:"a-z' || true)"
ok "newest off-box object: $NEWEST"
note "size: $SIZE"

if [ "$MODE" = "--plan" ]; then
    echo
    echo "  --plan stops here. --run would then:"
    echo "    1. docker run -d --name $DRILL_NAME --network none $PG_IMAGE"
    echo "    2. rclone cat the object above (nothing downloaded to disk)"
    echo "    3. openssl -d, then pull ONLY */postgres.sql.gz from the tar"
    echo "       (vmail and blobs are never decrypted at all)"
    echo "    4. gunzip that member straight into the container psql"
    echo "    5. no plaintext copy of the database is written to this host"
    echo "    6. compare row COUNTS per table against live (counts only)"
    echo "    7. run the tenancy query on the RESTORED copy: with no tenant"
    echo "       set, every FORCE-RLS table must return 0 rows"
    echo "    8. cleanup() — container, volume and scratch dir, whatever happened"
    exit 0
fi

# ── THE DRILL ───────────────────────────────────────────────────────────────
echo
echo "  restore"

# NOTHING DECRYPTED EVER TOUCHES THIS DISK.
#
# The off-box object is `tar czf -` of the whole backup set: postgres.sql.gz
# AND a .tar.gz of every Docker volume - vmail.tar.gz is everyone's mail,
# blobs is every uploaded file. The first draft of this script downloaded it,
# decrypted it and unpacked it into /var/tmp: 4.3 GB compressed, far more
# unpacked, on a box with 32 GB free - and then fed a TAR STREAM to psql,
# which would simply have failed. --plan caught it on 26 Sept 2026.
#
# So: stream it. rclone cat -> decrypt -> pull ONLY */postgres.sql.gz out of
# the archive -> gunzip -> straight into the drill container. The mail and
# the files are never decrypted at all, and no plaintext copy of the database
# exists anywhere on the host, not even briefly.

docker run -d --name "$DRILL_NAME" --network none \
    -e POSTGRES_PASSWORD=drill -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$PG_IMAGE" >/dev/null
ok "throwaway $PG_IMAGE started, no network"

for i in $(seq 1 60); do
    docker exec "$DRILL_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
    [ "$i" = 60 ] && die "drill Postgres never became ready"
    sleep 2
done
ok "drill Postgres ready"

RESTORE_PASS="$PASS"; export RESTORE_PASS
# pipefail is load-bearing here: without it a failure in rclone, openssl or
# tar is hidden by psql exiting 0 on an empty stream, and the drill would
# report a restored database that is in fact empty.
set -o pipefail
rclone cat "$REMOTE/$NEWEST" \
  | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:RESTORE_PASS \
  | tar -xzO --wildcards "*/postgres.sql.gz" \
  | gunzip \
  | docker exec -i "$DRILL_NAME" psql -U postgres -v ON_ERROR_STOP=1 -q
unset RESTORE_PASS
ok "streamed, decrypted and restored - nothing written to this disk"

# ── THE COMPARISON ──────────────────────────────────────────────────────────
echo
echo "  comparison (row counts only — no customer content is read or printed)"

LIVE_PG="$(docker ps -qf name=postgres | head -1)"
[ -n "$LIVE_PG" ] || die "cannot find the live postgres container"

fails=0
for db in tatvaos_mail tatvaos_ai tatvaos_docs tatvaos_hire; do
    # EXACT counts. pg_stat_user_tables.n_live_tup is an ESTIMATE, and on a
    # freshly restored cluster it is empty until ANALYZE runs - so this would
    # have compared a real number against nothing, and reported a difference
    # that meant nothing about the restore.
    q="select coalesce(sum(cnt),0)::text from (
         select (xpath('/row/c/text()',
                 query_to_xml(format('select count(*) c from %I.%I', schemaname, tablename),
                              false, true, '')))[1]::text::bigint cnt
         from pg_tables where schemaname not in ('pg_catalog','information_schema')) t"
    livec="$(docker exec "$LIVE_PG" psql -U postgres -d "$db" -t -A -c "$q" 2>/dev/null || echo skip)"
    drillc="$(docker exec "$DRILL_NAME" psql -U postgres -d "$db" -t -A -c "$q" 2>/dev/null || echo missing)"
    if [ "$livec" = "skip" ]; then note "$db: not on live, skipped"; continue; fi
    # A number is REQUIRED on both sides. Otherwise two empty strings compare
    # equal and the check passes having measured nothing.
    if ! [[ "$livec" =~ ^[0-9]+$ ]] || ! [[ "$drillc" =~ ^[0-9]+$ ]]; then
        bad "$db: did not get a number from both sides (live '"'"'$livec'"'"', restored '"'"'$drillc'"'"')"
        fails=$((fails+1)); continue
    fi
    if [ "$drillc" = "$livec" ]; then ok "$db: $drillc rows, same on both"
    else bad "$db: live $livec, restored $drillc"; fails=$((fails+1)); fi
done

# Tenancy on the RESTORED copy: with no tenant set, RLS must show nothing.
leak="$(docker exec "$DRILL_NAME" psql -U tatvaos_app -d tatvaos_mail -t -A -c \
        "select coalesce(sum(c),0)::text from (select count(*) c from mail.messages
          union all select count(*) from mail.folders) t" 2>/dev/null || echo error)"
if ! [[ "$leak" =~ ^[0-9]+$ ]]; then bad "tenancy check returned no number - it measured nothing"; fails=$((fails+1))
elif [ "$leak" = "0" ]; then ok "tenancy holds on the restored copy: 0 rows with no tenant set"
else bad "TENANCY LEAK on the restored copy: $leak rows visible with no tenant set"; fails=$((fails+1)); fi

echo
if [ "$fails" -eq 0 ]; then echo "  RESTORE PROVEN — $NEWEST restores and is tenant-safe"
else echo "  RESTORE NOT PROVEN — $fails check(s) failed above"; exit 1; fi

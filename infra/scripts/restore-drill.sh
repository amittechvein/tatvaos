#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  restore-drill.sh — prove the off-box backup can actually be restored.
#
#  Step (a) of Mr. Singh's three-step order for removing the 323 old plain
#  pre-deploy copies (PR 254). The local half is done: on WSL, with real
#  Postgres, a real pg_dumpall was encrypted, restored into a separate cluster
#  and compared, 28/28. This is the production half, and it proves the one
#  thing that cannot: that PRODUCTION's newest off-box object, written by
#  production's backup.sh with production's passphrase, restores.
#
#  ── WHAT THIS TOUCHES, STATED PLAINLY ───────────────────────────────────────
#
#  It runs ON the production box. It reads:
#    · the newest object in the off-box bucket, as a STREAM (never downloaded);
#    · BACKUP_ENC_PASSPHRASE, to decrypt it (never printed, never logged);
#    · row COUNTS from the live database — counts only, no addresses, no
#      bodies, no names.
#  It NEVER writes to the live database. The drill container runs with
#  --network none, so it cannot reach the live database even by mistake.
#
#  ── NOTHING DECRYPTED EVER TOUCHES THIS DISK ────────────────────────────────
#
#  The off-box object is `tar czf -` of the WHOLE backup set: postgres.sql.gz
#  AND a .tar.gz of every Docker volume. vmail.tar.gz is everyone's mail;
#  blobs is every uploaded file. 4.28 GB compressed, on a disk with 32 GB free.
#
#  The first draft of this script downloaded it, decrypted it and unpacked ALL
#  of it into /var/tmp — every customer's mail in plaintext on the production
#  disk, in order to restore a database — and then fed a TAR STREAM to psql,
#  which would have failed anyway. --plan caught it on 26 Sept 2026.
#
#  So it streams, and pulls exactly one member out of the archive on the way
#  past. The mail and the files are never decrypted at all.
#
#  Mr. Singh, 26 Sept, on the structural point behind that: one archive of
#  everything under one encryption means the commonest restore — the database
#  alone — must stream through everyone's mail to reach a few hundred MB of
#  SQL. "Streaming makes that safe today; it doesn't make it right."
#  backup.sh should write the three components as separate encrypted objects.
#  That is a backup.sh change, queued behind this.
#
#  ── THE THING MOST LIKELY TO GO WRONG ───────────────────────────────────────
#
#  A drill that fails halfway and leaves a decrypted copy of every customer's
#  data in a stray container is a WORSE state than never having drilled.
#  Mr. Singh, 26 Sept: "the throwaway container is removed whatever the
#  outcome — put the cleanup in a trap, not at the end of the script."
#
#  ── AND THE FALSE GREEN THAT WOULD MATTER MOST ──────────────────────────────
#
#  `set -o pipefail` is load-bearing. Without it a failure in rclone, openssl
#  or tar is hidden by psql exiting 0 on an empty stream, and the drill reports
#  a restored database that is in fact empty. Mr. Singh: "A drill that can't
#  tell an empty restore from a real one is the false green that matters most,
#  since it's the one you'd trust at three in the morning."
#
#  So --calibrate exists, and it breaks the stream three ways — plus a positive
#  control — against the SAME function --run uses.
#
#  ── USAGE ───────────────────────────────────────────────────────────────────
#
#      ./restore-drill.sh --plan        # touches nothing; prints what --run does
#      ./restore-drill.sh --calibrate   # proves a broken stream is reported
#      ./restore-drill.sh --run         # the drill
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

# rclone lives in ~/bin on this box — installed without sudo, because the
# deploy user has none. backup.sh has said so since it was written: "Cron runs
# with a bare PATH, so the script says where to look rather than hoping the
# environment does." This script hoped, and --plan stopped with "rclone not on
# PATH" while rclone sat in ~/bin all along.
export PATH="$HOME/bin:$PATH"

MODE="${1:---plan}"
case "$MODE" in --plan|--run|--calibrate) ;; *) echo "usage: $0 [--plan|--calibrate|--run]"; exit 2 ;; esac

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups/tatvaos}"
BACKUP_CONF="$BACKUP_DIR/.backup-env"
DRILL_NAME="tatvaos-restore-drill-$STAMP"
CAL_NAME="tatvaos-restore-cal-$STAMP"
SCRATCH=""
MIN_FREE_GB=15
PG_IMAGE="postgres:17"          # production's major version, not 18
MEMBER='*/postgres.sql.gz'      # the ONLY member taken out of the archive

ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; }
note() { echo "  --    $*"; }
die()  { echo; echo "STOPPED: $*"; exit 1; }

# ── CLEANUP: a trap, not a final line ────────────────────────────────────────
cleanup() {
    local rc=$?
    set +e
    echo
    echo "  cleanup (always runs)"
    for c in "$DRILL_NAME" "$CAL_NAME"; do
        if docker ps -aq --filter "name=^${c}$" | grep -q .; then
            docker rm -f -v "$c" >/dev/null 2>&1 \
                && ok "container $c removed" \
                || bad "COULD NOT REMOVE $c — remove it by hand, it may hold customer data"
        fi
    done
    docker volume ls -q --filter "name=tatvaos-restore-" 2>/dev/null | while read -r v; do
        docker volume rm -f "$v" >/dev/null 2>&1 && ok "stray volume $v removed"
    done
    if [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ]; then
        find "$SCRATCH" -type f -exec shred -u {} + 2>/dev/null
        rm -rf -- "$SCRATCH" && ok "scratch removed" || bad "COULD NOT REMOVE $SCRATCH"
    fi
    unset PASS RESTORE_PASS 2>/dev/null
    echo
    [ "$rc" -eq 0 ] && echo "DRILL FINISHED" || echo "DRILL STOPPED (exit $rc) — cleanup above still ran"
    exit "$rc"
}
trap cleanup EXIT INT TERM

# ── THE PIPELINE, ONCE ───────────────────────────────────────────────────────
# --run and --calibrate both go through this. A calibration that exercises a
# copy of the code proves nothing about the code that runs.
#
# Call it as a condition (`if ! stream_restore ...`): that is also what
# suspends `set -e` inside it, so a deliberate failure can be caught.
stream_restore() {                     # $1 source-cmd  $2 pass  $3 member  $4 container
    local src="$1" pw="$2" member="$3" cont="$4" rc=0 s
    local errf; errf="$(mktemp)"
    RESTORE_PASS="$pw"; export RESTORE_PASS
    set -o pipefail
    { eval "$src" \
      | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:RESTORE_PASS \
      | tar -xzO --wildcards "$member" \
      | gunzip \
      | docker exec -i "$cont" psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null
    } 2>"$errf"
    # PIPESTATUS must be read before ANY other command, including an
    # assignment. Read per stage rather than trusting pipefail alone: when
    # this goes wrong the question is always WHICH stage, and "the pipeline
    # failed" does not answer it.
    local st=("${PIPESTATUS[@]}")
    for s in "${st[@]}"; do [ "$s" -ne 0 ] && rc="$s"; done
    STREAM_STAGES="src=${st[0]} openssl=${st[1]} tar=${st[2]} gunzip=${st[3]} psql=${st[4]}"
    STREAM_ERR="$(tail -4 "$errf" 2>/dev/null | tr '\n' " " )"
    rm -f "$errf"
    unset RESTORE_PASS
    return "$rc"
}

start_pg() {                           # $1 container name
    docker run -d --name "$1" --network none \
        -e POSTGRES_PASSWORD=drill -e POSTGRES_HOST_AUTH_METHOD=trust \
        "$PG_IMAGE" >/dev/null
    local i
    for i in $(seq 1 60); do
        docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && return 0
        sleep 2
    done
    die "Postgres in $1 never became ready"
}

echo
echo "restore-drill ($MODE) — $STAMP"
echo "============================================"

# ── PRECONDITIONS. All of them fail closed. ─────────────────────────────────
echo
echo "  preconditions"

[ -r "$BACKUP_CONF" ] || die "cannot read $BACKUP_CONF as $(id -un)"
ok "$BACKUP_CONF readable as $(id -un)"

conf_value() { ( set -a; . "$BACKUP_CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" ); }
REMOTE="$(conf_value BACKUP_S3_REMOTE)"
PASS="$(conf_value BACKUP_ENC_PASSPHRASE)"
[ -n "$REMOTE" ] || die "BACKUP_S3_REMOTE is empty"
[ -n "$PASS" ]   || die "BACKUP_ENC_PASSPHRASE is empty"
ok "remote and passphrase resolve (neither printed)"

# Deliberately NOT probed: I have no liveness check I have seen work, and a
# probe that always answers "unknown" is a check with no failure mode. Human
# gate: Amit confirms no meeting is live, in the same message as the go.
note "live meeting: NOT checked by this script. Amit confirms before --run."

FREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
[ "${FREE_GB:-0}" -ge "$MIN_FREE_GB" ] \
    || die "only ${FREE_GB}G free on / — need ${MIN_FREE_GB}G. Clear the Docker build cache (deploy.sh does it automatically since #230); never prune volumes on this box."
ok "${FREE_GB}G free on / (need ${MIN_FREE_GB}G)"

command -v rclone >/dev/null || die "rclone not on PATH"
command -v docker >/dev/null || die "docker not on PATH"
ok "rclone and docker present"

# ── CALIBRATION ─────────────────────────────────────────────────────────────
if [ "$MODE" = "--calibrate" ]; then
    echo
    echo "  calibration — can this drill tell a broken stream from a real one?"
    echo "  (a small archive built here, in backup.sh's shape; the real object"
    echo "   is not touched, and 4.28 GB is not streamed four times)"

    SCRATCH="$(mktemp -d /var/tmp/restore-cal-XXXXXX)"; chmod 700 "$SCRATCH"
    mkdir -p "$SCRATCH/SET"
    printf 'create table drill_probe(x int);\ninsert into drill_probe values (1);\n' \
        | gzip > "$SCRATCH/SET/postgres.sql.gz"
    # Incompressible filler, added FIRST so postgres.sql.gz sits at the END of
    # the archive. The first version truncated a 1 KB object to 2000 bytes -
    # which contained the whole member, so it restored perfectly while claiming
    # to test a broken stream. A truncation that removes nothing is not one.
    dd if=/dev/urandom of="$SCRATCH/SET/aaa-filler.bin" bs=1M count=4 2>/dev/null
    CALPASS='calibration-only-not-a-real-secret'
    CALPASS_ENV="$CALPASS"; export CALPASS_ENV
    tar czf - -C "$SCRATCH" SET/aaa-filler.bin SET/postgres.sql.gz \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:CALPASS_ENV \
      > "$SCRATCH/obj.enc"
    unset CALPASS_ENV
    # Half the object: comfortably inside the filler, so the member IS cut.
    head -c "$(( $(stat -c %s "$SCRATCH/obj.enc") / 2 ))" \
        "$SCRATCH/obj.enc" > "$SCRATCH/truncated.enc"
    ok "built a $(du -h "$SCRATCH/obj.enc" | cut -f1) test object"

    start_pg "$CAL_NAME"
    ok "calibration Postgres ready"

    probe_exists() {
        docker exec "$CAL_NAME" psql -U postgres -t -A \
            -c "select count(*)::text from pg_tables where tablename='drill_probe'" 2>/dev/null
    }

    reset_probe() {
        docker exec "$CAL_NAME" psql -U postgres -q \
            -c "drop table if exists drill_probe" >/dev/null 2>&1
    }

    cal_fails=0
    # The three ways the stream can break upstream of psql. Each MUST be
    # reported as a failure, and each MUST leave nothing behind.
    while IFS='|' read -r label src pw member; do
        [ -n "$label" ] || continue
        # Every case starts from nothing. The first version did not reset, so a
        # case that legitimately restored left drill_probe behind and the
        # POSITIVE CONTROL then failed with "relation already exists" - a red
        # that had nothing to do with what it was testing.
        reset_probe
        if [ "$(probe_exists)" != "0" ]; then
            bad "$label: could not reset the probe - this case would prove nothing"
            cal_fails=$((cal_fails+1)); continue
        fi
        if stream_restore "$src" "$pw" "$member" "$CAL_NAME"; then
            bad "$label: the drill reported SUCCESS — this is the false green"
            note "   stages: $STREAM_STAGES"
            cal_fails=$((cal_fails+1))
        elif [ "$(probe_exists)" = "0" ]; then
            ok "$label: reported as failure, and nothing was restored"
            note "   stages: $STREAM_STAGES"
        else
            bad "$label: reported failure but data got through"
            cal_fails=$((cal_fails+1))
        fi
    done <<EOF
wrong passphrase|cat $SCRATCH/obj.enc|definitely-the-wrong-passphrase|$MEMBER
member absent from archive|cat $SCRATCH/obj.enc|$CALPASS|*/not-in-this-archive.sql.gz
truncated object|cat $SCRATCH/truncated.enc|$CALPASS|$MEMBER
EOF

    # The positive control. Without it, a pipeline that failed at EVERYTHING
    # would pass the three checks above and mean nothing.
    reset_probe
    if stream_restore "cat $SCRATCH/obj.enc" "$CALPASS" "$MEMBER" "$CAL_NAME"; then
        if [ "$(probe_exists)" = "1" ]; then
            ok "POSITIVE CONTROL: an intact stream restores, and is seen to"
        else
            bad "POSITIVE CONTROL: reported success but nothing arrived"; cal_fails=$((cal_fails+1))
        fi
    else
        bad "POSITIVE CONTROL: an intact stream FAILED — the drill cannot pass anything"
        note "   stages: $STREAM_STAGES"
        note "   stderr: $STREAM_ERR"
        cal_fails=$((cal_fails+1))
    fi

    echo
    [ "$cal_fails" -eq 0 ] \
        && echo "  CALIBRATED — a broken stream is reported, an intact one is not" \
        || { echo "  CALIBRATION FAILED — $cal_fails case(s); do NOT trust --run"; exit 1; }
    exit 0
fi

# ── WHAT WOULD BE RESTORED ──────────────────────────────────────────────────
echo
echo "  the object"
NEWEST="$(rclone lsf --files-only --format "tp" "$REMOTE" 2>/dev/null | sort | tail -1 | cut -d';' -f2-)"
[ -n "$NEWEST" ] || die "no objects listed at $REMOTE"
ok "newest off-box object: $NEWEST"
note "size: $(rclone size --json "$REMOTE/$NEWEST" 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2) bytes"

if [ "$MODE" = "--plan" ]; then
    echo
    echo "  --plan stops here. --run would then:"
    echo "    1. docker run -d --name $DRILL_NAME --network none $PG_IMAGE"
    echo "    2. rclone cat the object above — nothing downloaded to disk"
    echo "    3. openssl -d, then take ONLY $MEMBER from the tar"
    echo "       (vmail and blobs are never decrypted at all)"
    echo "    4. gunzip that member straight into the container's psql"
    echo "    5. compare row COUNTS per database against live — counts only"
    echo "    6. tenancy on the RESTORED copy: no tenant set must mean 0 rows"
    echo "    7. cleanup() — container, volume, scratch, whatever happened"
    exit 0
fi

# ── THE DRILL ───────────────────────────────────────────────────────────────
echo
echo "  restore"
start_pg "$DRILL_NAME"
ok "throwaway $PG_IMAGE started, no network"

if ! stream_restore "rclone cat \"$REMOTE/$NEWEST\"" "$PASS" "$MEMBER" "$DRILL_NAME"; then
    note "stages: $STREAM_STAGES"
    note "stderr: $STREAM_ERR"
    die "the stream failed — and --calibrate proves that is reported, not swallowed"
fi
ok "streamed, decrypted and restored — nothing written to this disk"

# ── THE COMPARISON ──────────────────────────────────────────────────────────
echo
echo "  comparison (row counts only — no customer content is read or printed)"

LIVE_PG="$(docker ps -qf name=postgres | head -1)"
[ -n "$LIVE_PG" ] || die "cannot find the live postgres container"

fails=0
for db in tatvaos_mail tatvaos_ai tatvaos_docs tatvaos_hire; do
    # EXACT counts. n_live_tup is an estimate AND is empty on a freshly
    # restored cluster until ANALYZE runs — it would have compared a real
    # number against nothing.
    q="select coalesce(sum(cnt),0)::text from (
         select (xpath('/row/c/text()',
                 query_to_xml(format('select count(*) c from %I.%I', schemaname, tablename),
                              false, true, '')))[1]::text::bigint cnt
         from pg_tables where schemaname not in ('pg_catalog','information_schema')) t"
    livec="$(docker exec "$LIVE_PG" psql -U postgres -d "$db" -t -A -c "$q" 2>/dev/null || echo skip)"
    drillc="$(docker exec "$DRILL_NAME" psql -U postgres -d "$db" -t -A -c "$q" 2>/dev/null || echo missing)"
    if [ "$livec" = "skip" ]; then note "$db: not on live, skipped"; continue; fi
    # A number is REQUIRED on both sides — two empty strings compare equal and
    # would pass having measured nothing.
    if ! [[ "$livec" =~ ^[0-9]+$ ]] || ! [[ "$drillc" =~ ^[0-9]+$ ]]; then
        bad "$db: no number from both sides (live '$livec', restored '$drillc')"
        fails=$((fails+1)); continue
    fi
    if [ "$drillc" = "$livec" ]; then ok "$db: $drillc rows, same on both"
    else bad "$db: live $livec, restored $drillc"; fails=$((fails+1)); fi
done

leak="$(docker exec "$DRILL_NAME" psql -U tatvaos_app -d tatvaos_mail -t -A -c \
        "select coalesce(sum(c),0)::text from (select count(*) c from mail.messages
          union all select count(*) from mail.folders) t" 2>/dev/null || echo error)"
if ! [[ "$leak" =~ ^[0-9]+$ ]]; then
    bad "tenancy check returned no number — it measured nothing"; fails=$((fails+1))
elif [ "$leak" = "0" ]; then ok "tenancy holds on the restored copy: 0 rows with no tenant set"
else bad "TENANCY LEAK on the restored copy: $leak rows with no tenant set"; fails=$((fails+1)); fi

echo
[ "$fails" -eq 0 ] \
    && echo "  RESTORE PROVEN — $NEWEST restores and is tenant-safe" \
    || { echo "  RESTORE NOT PROVEN — $fails check(s) failed above"; exit 1; }

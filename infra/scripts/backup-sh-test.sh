#!/usr/bin/env bash
#
# End-to-end tests for backup.sh's retention, with every outside thing faked:
# docker, rclone (a directory is the bucket), openssl and crontab.
#
#   bash infra/scripts/backup-sh-test.sh        # Linux: needs flock + GNU find
#
# What it proves is the part of backup.sh that DELETES things — which sets
# leave the bucket, which leave the disk, and that neither happens on a run
# whose own set did not make it off the box. The dump and the tarballs are
# not the subject here; verify-backup-restore.sh is.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
REPO=$(pwd)
# India time on purpose: backup.sh must stamp in UTC whatever the zone, and
# the local prune must sort those stamps the same way. See backup-tiers.sh.
export TZ=Asia/Kolkata

command -v flock >/dev/null || { echo "needs flock (util-linux) — run on Linux or in WSL"; exit 2; }

pass=0; fail=0
same()  { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1"; else fail=$((fail+1)); echo "  FAIL  $1: expected [$3], got [$2]"; fi; }
has()   { if printf '%s\n' "$2" | grep -qF -- "$3"; then pass=$((pass+1)); echo "  ok    $1"; else fail=$((fail+1)); echo "  FAIL  $1: [$3] missing"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -qF -- "$3"; then fail=$((fail+1)); echo "  FAIL  $1: [$3] present"; else pass=$((pass+1)); echo "  ok    $1"; fi; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"

# --- fakes --------------------------------------------------------------------
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_DOCKER_CALLS:-/dev/null}"
case "$1" in
  ps)     echo "tatvaos-postgres-1" ;;
  exec)   head -c 4000 /dev/urandom | base64 ;;
  volume) exit 1 ;;                     # every volume "missing" — skipped with a warning
  run)
    # The recordings copy (#257) runs three things in containers. The
    # recordings volume is $FAKE_REC_VOL and its bucket is $FAKE_REC_BUCKET;
    # FAKE_REC_HIDE leaves one name out of the bucket listing, FAIL_REC_COPY
    # makes the upload fail.
    case "$*" in
      *"tatvaos_connectrec:/src:ro alpine"*)
        cd "$FAKE_REC_VOL" && find . -type f | sed 's#^\./##' | sort ;;
      *" copy /src reccrypt:"*)
        [ -n "${FAIL_REC_COPY:-}" ] && { echo "ERROR : connection refused"; exit 1; }
        (cd "$FAKE_REC_VOL" && find . -type f | sed 's#^\./##') | while read -r f; do
          if [ ! -e "$FAKE_REC_BUCKET/$f" ]; then
            mkdir -p "$(dirname "$FAKE_REC_BUCKET/$f")"; cp "$FAKE_REC_VOL/$f" "$FAKE_REC_BUCKET/$f"
            echo "2026/10/02 00:00:00 INFO  : $f: Copied (new)"
          fi
        done
        # rclone -v prints a progress block every minute that NAMES the
        # files in flight. Seen on production in the 2 Oct proof run:
        # "Transferring:" then " * 01a0d6d9…-OqPhbJlu_iu2.mp4: 31% /1.654Gi".
        printf 'Transferring:\n * room-a1/meeting-a1-part1.mp4: 31%% /1.654Gi, 43.670Mi/s, 26s\n'
        echo "Transferred:   	          0 B / 0 B, -, 0 B/s, ETA -" ;;
      *" lsf -R --files-only reccrypt:"*)
        (cd "$FAKE_REC_BUCKET" && find . -type f | sed 's#^\./##') | grep -v -x -F -e "${FAKE_REC_HIDE:-(none)}" ;;
      *" delete --min-age "*" reccrypt:"*) : ;;
      *) printf '0\t/v\n' ;;
    esac ;;
esac
EOF
cat > "$T/bin/openssl" <<'EOF'
#!/usr/bin/env bash
cat
EOF
# The bucket is $FAKE_BUCKET. Remote names look like fake:tatvaos-backups.
cat > "$T/bin/rclone" <<'EOF'
#!/usr/bin/env bash
B="$FAKE_BUCKET"
echo "$*" >> "$FAKE_BUCKET.calls"
obj() { printf '%s' "${1#*:*/}"; }
case "$1" in
  rcat)       [ -n "${FAIL_RCAT:-}" ] && { cat >/dev/null; exit 1; }; cat > "$B/$(obj "$2")" ;;
  size)       f="$B/$(obj "$3")"; [ -f "$f" ] && printf '{"count":1,"bytes":%s}\n' "$(stat -c %s "$f")" ;;
  lsf)        [ -n "${FAIL_LSF:-}" ] && exit 1; ls -1 "$B" ;;
  deletefile) rm -f "$B/$(obj "$2")" ;;
  delete)     : ;;
  obscure)    echo "obscured" ;;
esac
EOF
cat > "$T/bin/crontab" <<'EOF'
#!/usr/bin/env bash
# Read ALL of stdin before writing, as the real crontab does. `cat > file`
# truncated the file while `crontab -l` in the same pipeline was still
# reading it, and the fake lost the other lines — the real one does not.
if [ "${1:-}" = "-l" ]; then cat "$FAKE_CRON" 2>/dev/null; else new=$(cat); printf '%s\n' "$new" > "$FAKE_CRON"; fi
EOF
chmod +x "$T/bin/"*

export HOME="$T"                 # backup.sh puts $HOME/bin first on PATH
export PATH="$T/bin:$PATH"
export FAKE_CRON="$T/crontab"

H=3600
stamp() { date -u -d "@$1" +%Y%m%d-%H%M%S; }

# A fresh world: a bucket with 10 days of 2-hourly sets plus one foreign file,
# and a backup directory holding five old sets and one directory that is not a set.
fresh() {
    export BACKUP_DIR="$T/dest"; export FAKE_BUCKET="$T/bucket"
    rm -rf "$BACKUP_DIR" "$FAKE_BUCKET" "$FAKE_BUCKET.calls"
    mkdir -p "$BACKUP_DIR" "$FAKE_BUCKET"
    now=$(date +%s)
    for k in $(seq 1 120); do
        head -c 2000 /dev/zero > "$FAKE_BUCKET/$(stamp $((now - k * 2 * H))).tar.gz.enc"
    done
    echo keep > "$FAKE_BUCKET/notes.txt"
    for k in 1 2 3 4 5; do mkdir -p "$BACKUP_DIR/$(stamp $((now - k * 2 * H)))"; done
    mkdir -p "$BACKUP_DIR/not-a-set"
    # Things that share the directory and must survive the local prune —
    # Mr. Singh's condition two (25 Sept): a pre-deploy copy, as deploy.sh
    # names it (it really lives elsewhere, but the prune must not care), a
    # directory with that name, the log, the config.
    echo x > "$BACKUP_DIR/pre-deploy-$(stamp $((now - 10 * 24 * H))).sql.gz.enc"
    mkdir -p "$BACKUP_DIR/pre-deploy-$(stamp $((now - 10 * 24 * H)))"
    echo x > "$BACKUP_DIR/backup.log"
    cat > "$BACKUP_DIR/.backup-env" <<ENV
BACKUP_S3_REMOTE='fake:tatvaos-backups'
BACKUP_ENC_PASSPHRASE='test-only'
BACKUP_S3_TIERED=1
BACKUP_LOCAL_KEEP=2
BACKUP_KEEP_DAYS=3
ENV
}
sets_in_bucket() { ls -1 "$FAKE_BUCKET" | grep -c '\.tar\.gz\.enc$'; }
sets_on_disk()   { find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}-[0-9]{6}' | wc -l; }
run() { out=$(bash "$REPO/infra/scripts/backup.sh" 2>&1); rc=$?; }

echo "== a normal tiered run"
fresh
before=$(sets_in_bucket)
pre=$(date -u +%Y%m%d-%H%M); run; post=$(date -u +%Y%m%d-%H%M)
same  "exit code"                             "$rc" 0
same  "120 sets before the run"               "$before" 120
n=$(sets_in_bucket)
if [ "$n" -ge 20 ] && [ "$n" -le 22 ]; then pass=$((pass+1)); echo "  ok    bucket thinned to $n sets"
else fail=$((fail+1)); echo "  FAIL  bucket holds $n sets, expected 20-22"; fi
newest=$(ls -1 "$FAKE_BUCKET" | grep '\.tar\.gz\.enc$' | sort | tail -1)
has   "this run's set is in the bucket"       "$out" "uploaded ${newest}"
same  "the foreign file is untouched"         "$(cat "$FAKE_BUCKET/notes.txt")" keep
hasnt "no recursive delete was used"          "$(cat "$FAKE_BUCKET.calls")" "delete --min-age"
has   "it says what it deleted"               "$out" "deleted $((before + 1 - n)), $n set(s) in the bucket"
same  "two sets left on this disk"            "$(sets_on_disk)" 2
[ -d "$BACKUP_DIR/${newest%.tar.gz.enc}" ] && { pass=$((pass+1)); echo "  ok    the newest local set is one of them"; } \
                                          || { fail=$((fail+1)); echo "  FAIL  the newest local set was deleted"; }
[ -d "$BACKUP_DIR/not-a-set" ] && { pass=$((pass+1)); echo "  ok    a directory that is not a set is left alone"; } \
                               || { fail=$((fail+1)); echo "  FAIL  not-a-set was deleted"; }
same  "the pre-deploy copy (10 days old) survives"  "$(ls "$BACKUP_DIR" | grep -c '^pre-deploy-.*\.sql\.gz\.enc$')" 1
same  "a pre-deploy-named directory survives"       "$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'pre-deploy-*' | wc -l)" 1
same  "the log survives"                            "$(cat "$BACKUP_DIR/backup.log")" x
[ -f "$BACKUP_DIR/.backup-env" ] && { pass=$((pass+1)); echo "  ok    the config survives"; } \
                                 || { fail=$((fail+1)); echo "  FAIL  .backup-env was deleted"; }
# The minute may tick during the run, so either end of it is accepted.
if printf '%s
' "$out" | grep -qE "uploaded ($pre|$post)"; then pass=$((pass+1)); echo "  ok    this run's stamp is UTC, not IST"
else fail=$((fail+1)); echo "  FAIL  the stamp is not UTC (wanted $pre or $post): $(printf '%s
' "$out" | grep -o 'uploaded [0-9-]*')"; fi

echo "== the upload fails: nothing is thinned, anywhere"
fresh
FAIL_RCAT=1 run
same  "exit code"                             "$rc" 1
same  "bucket untouched"                      "$(sets_in_bucket)" 120
same  "local sets kept (5 old + this one)"    "$(sets_on_disk)" 6
has   "and it says why"                       "$out" "not proven off the box"

echo "== the listing fails: nothing is deleted from the bucket"
fresh
FAIL_LSF=1 run
same  "exit code"                             "$rc" 1
same  "bucket holds the old sets + this one"  "$(sets_in_bucket)" 121
has   "and it says so"                        "$out" "retention skipped"

echo "== another backup is still running"
fresh
exec 8>"$BACKUP_DIR/.backup.lock"; flock -n 8
run
exec 8>&-
same  "exit code"                             "$rc" 1
has   "and it says so"                        "$out" "still running"
same  "no new set made"                       "$(sets_on_disk)" 5
same  "bucket untouched"                      "$(sets_in_bucket)" 120

echo "== tiered switched off: the old 30-day rule, no tiered deletes"
fresh
sed -i '/BACKUP_S3_TIERED/d; /BACKUP_LOCAL_KEEP/d' "$BACKUP_DIR/.backup-env"
run
same  "exit code"                             "$rc" 0
same  "nothing deleted by name"               "$(grep -c '^deletefile' "$FAKE_BUCKET.calls")" 0
has   "old rule ran"                          "$(cat "$FAKE_BUCKET.calls")" "delete --min-age 30d"
same  "local sets kept by days, not count"    "$(sets_on_disk)" 6

echo "== BACKUP_LOCAL_KEEP must be 1 or more"
for bad in 0 two -1; do
    fresh
    sed -i "s/^BACKUP_LOCAL_KEEP=.*/BACKUP_LOCAL_KEEP=$bad/" "$BACKUP_DIR/.backup-env"
    run
    same "BACKUP_LOCAL_KEEP=$bad refused"      "$rc" 1
    same "BACKUP_LOCAL_KEEP=$bad deleted nothing" "$(sets_on_disk)" 5
done

# --- recordings (#257): copied off the box, never failing the set -----------
recordings_world() {
    export FAKE_REC_VOL="$T/recvol" FAKE_REC_BUCKET="$T/recbucket" FAKE_DOCKER_CALLS="$T/docker.calls"
    rm -rf "$FAKE_REC_VOL" "$FAKE_REC_BUCKET" "$FAKE_DOCKER_CALLS"
    mkdir -p "$FAKE_REC_VOL/room-a1" "$FAKE_REC_BUCKET"
    for n in 1 2 3; do echo "video $n" > "$FAKE_REC_VOL/room-a1/meeting-a1-part$n.mp4"; done
    echo "BACKUP_RECORDINGS_REMOTE='fake:tatvaos-recordings'" >> "$BACKUP_DIR/.backup-env"
}
rec_only() { out=$(bash "$REPO/infra/scripts/backup.sh" --recordings-only 2>&1); rc=$?; }

echo "== recordings: --recordings-only copies every file, and only that"
fresh; recordings_world
rec_only
same  "exit code"                             "$rc" 0
has   "the receipt: every file is in the bucket" "$out" "every one of the 3 files on the volume is in the bucket"
has   "it counts what it uploaded"            "$out" "3 uploaded this run"
same  "all three are in the bucket"           "$(find "$FAKE_REC_BUCKET" -type f | wc -l)" 3
same  "no set was made on this disk"          "$(sets_on_disk)" 5
same  "the main bucket was not touched"       "$(sets_in_bucket)" 120
hasnt "no recording's name is printed"        "$out" "meeting-a1-part"
has   "the rclone image is pulled by digest"  "$(cat "$FAKE_DOCKER_CALLS")" "rclone/rclone:1.68.2@sha256:74c51b8817e5431bd6d7ed27cb2a50d8ee78d77f6807b72a41ef6f898845942b"
rec_only
same  "a second run: exit code"               "$rc" 0
has   "a second run uploads nothing"          "$out" "0 uploaded this run"

echo "== recordings: one file missing from the bucket is a failure"
export FAKE_REC_HIDE="room-a1/meeting-a1-part2.mp4"
rec_only
unset FAKE_REC_HIDE
same  "exit code"                             "$rc" 1
has   "it names the shortfall"                "$out" "1 file(s) on the volume are NOT in the bucket"
hasnt "but not the file"                      "$out" "meeting-a1-part2"

echo "== recordings: the upload fails"
out=$(FAIL_REC_COPY=1 bash "$REPO/infra/scripts/backup.sh" --recordings-only 2>&1); rc=$?
same  "exit code"                             "$rc" 1
has   "and it says so"                        "$out" "copy FAILED"

echo "== recordings: a failed upload is loud, and the main set still succeeds"
fresh; recordings_world
out=$(FAIL_REC_COPY=1 bash "$REPO/infra/scripts/backup.sh" 2>&1); rc=$?
same  "exit code (the set is fine)"           "$rc" 0
has   "the set completes"                     "$out" "backup complete"
has   "the verdict repeats the failure"       "$out" "RECORDINGS were NOT fully copied off the box this run"

echo "== recordings: --recordings-only with no remote is refused"
fresh
rec_only
same  "exit code"                             "$rc" 1
has   "and it says why"                       "$out" "BACKUP_RECORDINGS_REMOTE is not set"
same  "no set was made"                       "$(sets_on_disk)" 5
unset FAKE_REC_VOL FAKE_REC_BUCKET FAKE_DOCKER_CALLS

echo "== an unknown option is refused, and nothing runs"
# Found in the #257 red run (2 Oct 2026): the script ignored any argument it
# did not know, so --recordings-only against the old code ran a FULL backup.
# A typo of a real option must do nothing at all, loudly.
fresh
out=$(bash "$REPO/infra/scripts/backup.sh" --recordings-onyl 2>&1); rc=$?
same  "a misspelt option: exit code"          "$rc" 2
has   "and it names the option"               "$out" 'unknown option "--recordings-onyl"'
same  "no set was made"                       "$(sets_on_disk)" 5
same  "the bucket was not touched"            "$(sets_in_bucket)" 120
out=$(bash "$REPO/infra/scripts/backup.sh" --install --recordings-only 2>&1); rc=$?
same  "two options at once: exit code"        "$rc" 2
same  "still no set made"                     "$(sets_on_disk)" 5

echo "== --install"
fresh
echo "30 2 * * * cd /srv/tatvaos-production && ./infra/scripts/backup.sh >> /x/backup.log 2>&1" > "$FAKE_CRON"
echo "0 4 * * * something-else" >> "$FAKE_CRON"
out=$(bash "$REPO/infra/scripts/backup.sh" --install 2>&1); rc=$?
same  "exit code"                             "$rc" 0
same  "one backup line, not two"              "$(grep -c 'backup.sh' "$FAKE_CRON")" 1
has   "every 2 hours"                         "$(cat "$FAKE_CRON")" "30 */2 * * * cd "
has   "other cron lines survive"              "$(cat "$FAKE_CRON")" "0 4 * * * something-else"
out=$(bash "$REPO/infra/scripts/backup.sh" --install 2>&1)
has   "second run is a no-op"                 "$out" "already installed"
same  "still one line"                        "$(grep -c 'backup.sh' "$FAKE_CRON")" 1

sed -i '/BACKUP_LOCAL_KEEP/d' "$BACKUP_DIR/.backup-env"
out=$(bash "$REPO/infra/scripts/backup.sh" --install 2>&1); rc=$?
same  "tiered without LOCAL_KEEP refused"     "$rc" 1
has   "cron unchanged"                        "$(cat "$FAKE_CRON")" "30 */2 * * * cd "

sed -i '/BACKUP_S3_TIERED/d' "$BACKUP_DIR/.backup-env"
out=$(bash "$REPO/infra/scripts/backup.sh" --install 2>&1); rc=$?
same  "not tiered: exit code"                 "$rc" 0
has   "not tiered: every 6 hours"             "$(cat "$FAKE_CRON")" "30 2,8,14,20 * * * cd "
same  "still one line"                        "$(grep -c 'backup.sh' "$FAKE_CRON")" 1

echo
echo "PASS $pass  FAIL $fail"
[ "$fail" -eq 0 ]

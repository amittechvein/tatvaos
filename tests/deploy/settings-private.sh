#!/usr/bin/env bash
#
# deploy.sh's "Settings files are private" step — run for real, in a scratch
# git repository, with nothing stubbed but the four printing helpers.
#
# WHY THIS EXISTS. On 28 Sept 2026 production's infra/docker/.env was mode
# 664 with three copies beside it the same way. Mr. Singh (by 28 Sept, in a
# separate session; first written "1 Oct"): the deploy
# refuses if any .env* in the settings directory can be read by anyone but
# the deploying account. A refusal that does not refuse is worse than none,
# so every case here has a mutant of deploy.sh that must turn it red.
#
# It does NOT copy the step. It cuts the real block out of deploy.sh, from
# `step "Settings files are private"` to the next section rule.
#
# NEEDS A FILESYSTEM THAT KEEPS UNIX MODES (Linux, or WSL's own disk).
# Every check here is about modes, so on one that does not (Git Bash on
# NTFS) it does not skip quietly: it says NOT RUN and exits 2.
#
# Usage: bash tests/deploy/settings-private.sh
# Exit:  0 all passed, 1 a check failed, 2 could not run.
#
# ── CALIBRATION, 28 September 2026 — five mutants of deploy.sh, run in WSL ──
#  1. `-perm /077` weakened to `-perm /007` -> exactly ".env at 640 is
#     refused" red (1 of 10): the step said "readable by ... only" of a
#     group-readable file.
#  2. the `exit 1` after the refusal removed -> all four "refused" checks red:
#     the step printed "refusing to deploy" and carried on, rc 0.
#  3. the git-tracked exception removed -> 6 of 10 red, the healthy case
#     first: the published example (664) stops every deploy.
#  4. exception by NAME (*.example*) instead of by git -> exactly
#     ".env.example.bak is refused" red: the copy a name rule lets through.
#  5. age never taken from the name -> exactly "an old copy is named by the
#     date in its NAME" red: a 20-day-old copy made with cp looked new.
# ---------------------------------------------------------------------------

set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
DEPLOY_SH="${DEPLOY_SH:-$root/infra/scripts/deploy.sh}"   # a mutant can be swapped in

pass=0; fail=0
ok_()  { pass=$((pass + 1)); printf '    ok  %s\n' "$1"; }
bad_() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }

block=$(awk '/^step "Settings files are private"/{on=1} on && /^# -{20,}/{exit} on' "$DEPLOY_SH")
[ -n "$block" ] || { echo "  could not find the step in $DEPLOY_SH — NOT RUN"; exit 2; }

probe=$(mktemp -d); touch "$probe/f"; chmod 600 "$probe/f"
if [ "$(stat -c %a "$probe/f")" != 600 ]; then
    rm -rf "$probe"
    echo "  NOT RUN: this filesystem does not keep Unix modes. Run it on Linux or inside WSL."
    exit 2
fi
rm -rf "$probe"

# A scratch checkout: a git repository with the published example tracked at
# 664, as git writes it on the server, and a private .env.
fresh() {
    local d; d=$(mktemp -d)
    ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t \
      && mkdir -p infra/docker && echo 'SECRET=CHANGE_ME' > infra/docker/.env.production.example \
      && chmod 664 infra/docker/.env.production.example && git add -A && git commit -q -m seed \
      && ( umask 077; echo 'SECRET=real' > infra/docker/.env ) )
    echo "$d"
}
run_step() {
    ( cd "$1"
      step() { :; }; ok() { echo "OK: $*"; }; bad() { echo "BAD: $*"; }; note() { echo "NOTE: $*"; }
      eval "$block"
      echo "STEP-FINISHED" )
}
refused() { # label, dir, name that must be reported
    local out rc; out=$(run_step "$2"); rc=$?
    if [ $rc -ne 0 ] && [[ "$out" == *"refusing to deploy"* ]] && [[ "$out" == *"$3"* ]] && [[ "$out" != *STEP-FINISHED* ]]; then ok_ "$1"
    else bad_ "$1 — rc=$rc: $(echo "$out" | head -4 | tr '\n' ' ')"; fi
}
stamp() { date -u -d "$1" +%Y%m%dT%H%M%SZ; }

printf '\n  deploy.sh: settings files are private\n  =====================================\n\n'

# 1. The healthy case, which is production today.
d=$(fresh); ( cd "$d/infra/docker"; umask 077; cp .env ".env.before-x-$(stamp now)" )
out=$(run_step "$d"); rc=$?
[ $rc -eq 0 ] && [[ "$out" == *"2 settings file(s), each readable by"* ]] && [[ "$out" == *STEP-FINISHED* ]] \
    && ok_ ".env and a fresh copy, both 600: the deploy carries on, and says it checked 2" \
    || bad_ "healthy case: rc=$rc out=$out"
[[ "$out" != *"older than seven days"* ]] && ok_ "...and a fresh copy is not called old" || bad_ "a fresh copy was called old"
[ "$(stat -c %a "$d/infra/docker/.env.production.example")" = 664 ] && [ $rc -eq 0 ] \
    && ok_ "the published example (tracked, 664) does not stop a deploy" \
    || bad_ "the tracked example stopped the deploy"
rm -rf "$d"

# 2. .env itself readable by others: the 28 Sept finding.
d=$(fresh); chmod 664 "$d/infra/docker/.env"
refused ".env at 664 is refused, by name" "$d" "infra/docker/.env"; rm -rf "$d"

# 3. Group-readable only. 640 is not "world-readable", and is still refused.
d=$(fresh); chmod 640 "$d/infra/docker/.env"
refused ".env at 640 (group only) is refused" "$d" "mode 640"; rm -rf "$d"

# 4. A copy is a second copy of every secret.
d=$(fresh); ( cd "$d/infra/docker"; cp .env .env.before-sharing-20260927T065043Z; chmod 664 .env.before-sharing-20260927T065043Z )
out=$(run_step "$d"); rc=$?
[ $rc -ne 0 ] && [[ "$out" == *"1 settings file(s) can be read"* ]] && [[ "$out" == *".env.before-sharing-20260927T065043Z"* ]] \
    && ok_ "a copy at 664 is refused even though .env itself is 600 — and only the copy is named" \
    || bad_ "open copy: rc=$rc out=$out"
rm -rf "$d"

# 5. The name rule's blind spot: an untracked file that LOOKS like an example.
d=$(fresh); ( cd "$d/infra/docker"; cp .env .env.example.bak; chmod 644 .env.example.bak )
refused ".env.example.bak (untracked, 644) is refused — decided by git, not by the name" "$d" ".env.example.bak"; rm -rf "$d"

# 6. An old copy, private: named, not refused. Its own date is FRESH (cp made
#    it now); only the name says it is old.
d=$(fresh); old=".env.before-promotion-$(stamp '20 days ago')"
( cd "$d/infra/docker"; umask 077; cp .env "$old" )
out=$(run_step "$d"); rc=$?
[ $rc -eq 0 ] && [[ "$out" == *"1 copy(ies) of .env older than seven days"* ]] && [[ "$out" == *"$old"* ]] \
    && ok_ "an old copy is named by the date in its NAME, and the deploy still carries on" \
    || bad_ "old copy: rc=$rc out=$out"
rm -rf "$d"

# 7. A copy with no date in its name falls back to the file's own date.
d=$(fresh); ( cd "$d/infra/docker"; umask 077; cp .env .env.staging-backup; touch -d '52 days ago' .env.staging-backup )
out=$(run_step "$d"); rc=$?
[ $rc -eq 0 ] && [[ "$out" == *".env.staging-backup"* ]] && [[ "$out" == *"older than seven days"* ]] \
    && ok_ "a copy with no date in its name is aged by the file's date (the 52-day-old one)" \
    || bad_ "undated old copy: rc=$rc out=$out"
rm -rf "$d"

# 8. Nothing to check is a broken check, not a pass.
d=$(fresh); rm -f "$d/infra/docker/.env"
out=$(run_step "$d"); rc=$?
[ $rc -ne 0 ] && [[ "$out" == *"the check itself is broken"* ]] \
    && ok_ "no settings file found at all stops the deploy rather than passing on nothing" \
    || bad_ "empty case: rc=$rc out=$out"
rm -rf "$d"

printf '\n  =====================================\n'
if [ "$fail" -eq 0 ]; then printf '  PASS  %s checks\n\n' "$pass"; exit 0; fi
printf '  FAIL  %s of %s checks\n\n' "$fail" "$((pass + fail))"; exit 1

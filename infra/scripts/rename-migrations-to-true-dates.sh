#!/usr/bin/env bash
# ============================================================================
#  Rename migration files that carry a date they were not written on.
#
#      bash infra/scripts/rename-migrations-to-true-dates.sh          # show
#      bash infra/scripts/rename-migrations-to-true-dates.sh --apply  # do it
#
#  Prints what it would do and changes nothing, unless --apply is passed.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY THIS IS NOT TIDINESS.
#
#   local/postgres/init is replayed IN FILENAME ORDER, from empty, on every
#   fresh install. The filename is not a label — it IS the dependency order.
#
#   Ten of Connect's migrations were written in August and named for
#   September. Nothing broke, because everything written afterwards was named
#   later still. Then the first file named honestly arrived:
#
#       20260826-connect-recording-shares.sql   written 26 August
#
#   It sorts BEFORE 20260901-20260910, which create the tables it alters. On a
#   fresh database it fails on its first line. The person who named a file
#   correctly is the one the bug lands on, which is precisely backwards.
#
#   So: every file gets the date it was actually written, taken from git
#   rather than from anybody's memory, and from then on a true date is safe.
#
#  ─────────────────────────────────────────────────────────────────────────
#   HOW THE TRUE DATE IS FOUND, AND WHY NOT BY HAND.
#
#   git log --diff-filter=A on the file gives the commit that ADDED it. That
#   is the day it was written, it is recorded at the time by something with no
#   opinion, and it cannot be misremembered a week later. A hand-written
#   mapping in this script would be exactly the guess the whole problem is
#   made of.
#
#   --follow is used so a file already renamed once still reports the date it
#   first appeared, not the date it was moved.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHAT IT REFUSES TO DO.
#
#   • It will not run with a dirty working tree. A rename mixed into other
#     uncommitted work is a rename nobody can review or undo.
#   • It will not move a file onto a name that already exists.
#   • It will not touch a file whose date is already correct.
#   • It will not silently reorder anything. If the renames move any file
#     relative to another, it prints exactly what moved and REFUSES until
#     --i-checked-the-order is passed as well.
#
#     Some reordering is the POINT, not a bug: a new file named honestly is
#     supposed to sort after the tables it depends on rather than before them.
#     What must not happen is two ALREADY-APPLIED migrations swapping, because
#     production was built in the old order and a fresh install would then be
#     built in a different one. Only a person knows which files have run
#     where, so the script shows the movement and stops.
#
#   It uses `git mv`, so the rename is staged and `git status` shows exactly
#   what happened before anything is committed.
# ============================================================================

set -euo pipefail

DIR="local/postgres/init"
APPLY=0
ORDER_OK=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --i-checked-the-order) ORDER_OK=1 ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

if [[ ! -d "$DIR" ]]; then
  echo "Run this from the repository root — $DIR is not here."
  exit 2
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repository. The true dates come from git history, so this"
  echo "cannot run without it."
  exit 2
fi

# ── Refuse to work in a dirty tree ──────────────────────────────────────────
if [[ -n "$(git status --porcelain -- "$DIR")" ]]; then
  echo "There are uncommitted changes in $DIR."
  echo "Commit or stash them first — a rename mixed into other work is a"
  echo "rename nobody can review."
  exit 1
fi

echo "Reading true dates from git history…"
echo

plan_from=()
plan_to=()
plan_date=()
unchanged=0
missing=0

for path in "$DIR"/*.sql; do
  file="$(basename "$path")"

  # Only files that start with a date. Anything else is left alone.
  if [[ ! "$file" =~ ^([0-9]{8})(-.*)$ ]]; then
    continue
  fi
  named="${BASH_REMATCH[1]}"
  rest="${BASH_REMATCH[2]}"

  # The commit that ADDED this file. --follow so a previous rename does not
  # hide the original.
  true_date="$(git log --follow --diff-filter=A --format=%ad --date=format:%Y%m%d -- "$path" | tail -1)"

  if [[ -z "$true_date" ]]; then
    echo "  ?  $file"
    echo "     never committed, so git has no date for it. Left alone."
    missing=$((missing + 1))
    continue
  fi

  if [[ "$true_date" == "$named" ]]; then
    unchanged=$((unchanged + 1))
    continue
  fi

  plan_from+=("$file")
  plan_to+=("${true_date}${rest}")
  plan_date+=("$true_date")
done

# ── Same-day collisions get a letter, per the README ────────────────────────
#
#  Several migrations written on one day is the normal case, not an edge one:
#  the folder's own README says "if two files land on the same date, order
#  them by name (20260904-a-..., 20260904-b-...)".
#
#  Without that, a date collision hands ordering to alphabetical chance — so
#  20260819-connect-meeting-mode would jump ahead of
#  20260819-connect-retention purely because 'm' sorts before 'r'. The letters
#  keep the order the files are in NOW, which is the order production was
#  built in and therefore the only order known to work.
#
#  Files already carrying a letter keep theirs rather than gaining a second.
for i in "${!plan_to[@]}"; do
  d="${plan_date[$i]}"
  same=0
  for j in "${!plan_date[@]}"; do
    [[ "${plan_date[$j]}" == "$d" ]] && same=$((same + 1))
  done
  # Also collide with files ALREADY on that date and not being renamed.
  for existing in "$DIR/$d"-*.sql; do
    [[ -e "$existing" ]] || continue
    base="$(basename "$existing")"
    skip=0
    for k in "${!plan_from[@]}"; do
      [[ "${plan_from[$k]}" == "$base" ]] && skip=1
    done
    [[ $skip -eq 0 ]] && same=$((same + 1))
  done

  [[ $same -lt 2 ]] && continue

  rest="${plan_to[$i]#$d}"          # -name.sql
  # Already lettered? Leave it.
  [[ "$rest" =~ ^-[a-z]- ]] && continue

  # Position among the files landing on this date, in their CURRENT order.
  n=0
  for j in "${!plan_date[@]}"; do
    [[ "${plan_date[$j]}" != "$d" ]] && continue
    n=$((n + 1))
    [[ $j -eq $i ]] && break
  done
  letter="$(printf "\\$(printf '%03o' $((96 + n)))")"   # 1 -> a, 2 -> b …
  plan_to[$i]="${d}-${letter}${rest}"
done

if [[ ${#plan_from[@]} -eq 0 ]]; then
  echo "Every migration already carries the date it was written."
  echo "($unchanged correct, $missing uncommitted.)"
  exit 0
fi

# ── Does the order change, and does that matter? ────────────────────────────
#
#  The folder is replayed in filename order, so a rename can change the order
#  the schema is built in. Some of that is the point: a new file named
#  honestly SHOULD sort after the tables it depends on. What must never happen
#  is two already-applied migrations swapping, because production was built in
#  the old order and a fresh install would be built in the new one.
#
#  The script cannot know which files have run on which database. So it shows
#  precisely what moved and stops, and a person decides.
before="$(ls "$DIR"/*.sql | xargs -n1 basename)"
after="$(
  {
    for path in "$DIR"/*.sql; do
      file="$(basename "$path")"
      out="$file"
      for i in "${!plan_from[@]}"; do
        [[ "${plan_from[$i]}" == "$file" ]] && out="${plan_to[$i]}"
      done
      echo "$out"
    done
  } | sort
)"

# Compare position-for-position by the part after the date, which is the
# file's identity. If that sequence differs, the build order moved.
#
# The optional -x- is the same-day ordering letter and is stripped too: it is
# part of the NAMING, not of the file's identity, and leaving it in would make
# every same-day rename look like a reorder when it is the opposite — the
# letter is there precisely to preserve the order.
STRIP='s/^[0-9]{8}(-[a-z])?-/-/'
ids_before="$(echo "$before" | sed -E "$STRIP")"
ids_after="$(echo "$after"  | sed -E "$STRIP")"

echo "Planned renames:"
echo
for i in "${!plan_from[@]}"; do
  printf '  %s\n     -> %s\n' "${plan_from[$i]}" "${plan_to[$i]}"
done
echo
echo "($unchanged already correct.)"
echo

if [[ "$ids_before" == "$ids_after" ]]; then
  echo "The build order is unchanged by these renames."
  echo
elif [[ $ORDER_OK -eq 1 ]]; then
  echo "The build order CHANGES, and you have said you checked it:"
  echo
  diff <(echo "$ids_before") <(echo "$ids_after") || true
  echo
else
  echo "The build order CHANGES. Read this before going further."
  echo
  echo "  before:"
  echo "$ids_before" | sed 's/^/    /'
  echo
  echo "  after:"
  echo "$ids_after" | sed 's/^/    /'
  echo
  echo "  what moved:"
  diff <(echo "$ids_before") <(echo "$ids_after") | sed 's/^/    /' || true
  echo
  echo "THE ONE QUESTION TO ANSWER:"
  echo
  echo "  Does any migration that has ALREADY RUN on production move relative"
  echo "  to another one that has already run?"
  echo
  echo "    If only NEW, never-applied files moved — that is the point of this"
  echo "    rename and it is fine."
  echo
  echo "    If two already-applied files swapped — STOP. Production was built"
  echo "    in the old order and a fresh install would be built in the new one."
  echo "    Take it to whoever owns the schema."
  echo
  echo "When you are sure:"
  echo
  echo "    bash infra/scripts/rename-migrations-to-true-dates.sh \\"
  echo "         --apply --i-checked-the-order"
  echo
  echo "Nothing was changed."
  exit 1
fi

# ── Nothing may land on an existing name ────────────────────────────────────
for i in "${!plan_to[@]}"; do
  if [[ -e "$DIR/${plan_to[$i]}" ]]; then
    echo "STOPPING. ${plan_to[$i]} already exists."
    echo "Nothing was changed."
    exit 1
  fi
done

if [[ $APPLY -eq 0 ]]; then
  echo "Nothing has been changed. To do it:"
  echo
  echo "    bash infra/scripts/rename-migrations-to-true-dates.sh --apply"
  echo
  echo "Then check the result and commit:"
  echo
  echo "    git status --short"
  echo "    bash infra/scripts/verify-migrations.sh"
  exit 0
fi

for i in "${!plan_from[@]}"; do
  git mv "$DIR/${plan_from[$i]}" "$DIR/${plan_to[$i]}"
  echo "  renamed ${plan_from[$i]}"
done

echo
echo "Done, and staged. Two things before committing:"
echo
echo "  1. git status --short          — every line should be a rename (R)"
echo "  2. bash infra/scripts/verify-migrations.sh"
echo "                                 — replays the folder from empty"
echo
echo "A migration whose HEADER names a date is not changed by this script."
echo "Those dates were correct all along; it is the filenames that lied."

#!/usr/bin/env bash
# ============================================================================
#  Replay local/postgres/init into an EMPTY database and see whether it works.
#
#      bash infra/scripts/verify-migrations.sh
#
#  Exit 0 = a fresh install would succeed. Exit 1 = it would not.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY THIS HAD TO EXIST, WRITTEN 26 AUGUST 2026.
#
#   Two things came together on that day.
#
#   FIRST: I had been telling people this script already existed and was
#   green on 54 files. It did not exist. Nobody had checked, including me,
#   and the claim had been repeated into a schema proposal sent for review.
#   That is worth writing down here rather than quietly fixing, because the
#   reason the bug below survived is that everybody believed something was
#   watching for it.
#
#   SECOND: something WAS wrong. Replaying the folder from empty failed on
#   two files:
#
#     20260822-connect-captions.sql
#         ERROR: schema "connect" does not exist
#     20260822-connect-retention-default-30.sql
#         ERROR: column "connect_recording_retention_days" of relation
#                "tenants" does not exist
#
#   Both are August files correctly named for August. Both depend on Connect
#   tables created by files named 20260901-20260910 — August work wearing
#   SEPTEMBER dates. 20260822 sorts before 20260901, so the dependants ran
#   first and a fresh database died on the second one.
#
#   Production never noticed, and could not: the objects already exist there,
#   so re-running these files on production succeeds every time. What was
#   broken was every fresh database — a rebuild, A RESTORE FROM BACKUP, or a
#   new developer's first local setup.
#
#   That is the same failure this directory's README already describes
#   happening once before, with 20260816-space-public-links.sql. It happened
#   again because nothing was checking, and because a filename convention is
#   only as good as the thing that enforces it.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHAT IT DOES, AND WHAT IT DOES NOT PROVE.
#
#   It creates a throwaway database, applies every *.sql in filename order
#   with ON_ERROR_STOP, and reports the first error in each file that fails.
#   Filename order is not an approximation of what deploy.sh does — it is the
#   same `for f in local/postgres/init/*.sql` loop.
#
#   It then applies the WHOLE FOLDER A SECOND TIME, because every file in
#   here is required to be idempotent and re-runs on every deploy. A file
#   that works once and fails twice breaks the NEXT deploy, not this one,
#   which is a much worse way to find out.
#
#   It does NOT prove the schema is right, only that it can be built. It says
#   nothing about whether the tables are the ones the application expects.
#
#   *seed* files are skipped, exactly as deploy.sh skips them.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHERE IT GETS A DATABASE.
#
#   Docker if the daemon is reachable — that is the server, and it matches
#   what production actually runs. Otherwise a throwaway cluster from a local
#   postgres install, which is how it runs on a machine without docker.
#   Either way the database is created empty and destroyed at the end; it
#   never touches the real one, and it refuses to run against a remote host.
# ============================================================================

set -uo pipefail

DIR="local/postgres/init"
PGIMAGE="${PGIMAGE:-postgres:16-alpine}"
DBNAME="migration_verify"

if [[ ! -d "$DIR" ]]; then
  echo "Run this from the repository root — $DIR is not here."
  exit 2
fi

# Refuse to be pointed at anything real. This script drops a database.
if [[ -n "${PGHOST:-}" || -n "${PGDATABASE:-}" ]]; then
  echo "PGHOST or PGDATABASE is set in your environment."
  echo "This script creates and DROPS a database, so it will not run while it"
  echo "might be aimed at a real one. Unset them and run it again."
  exit 2
fi

CLEANUP=""
trap '[[ -n "$CLEANUP" ]] && eval "$CLEANUP" >/dev/null 2>&1' EXIT

# ── A database, from whatever is available ──────────────────────────────────
if docker info >/dev/null 2>&1; then
  echo "Using docker ($PGIMAGE)."
  NAME="migverify-$$"
  # psql runs INSIDE the container. The host needs no postgres client at all
  # (the production server has none), and no port is published, so the
  # throwaway database is reachable from nowhere but this script.
  docker run -d --rm --name "$NAME" \
    -e POSTGRES_PASSWORD=verify -e POSTGRES_DB="$DBNAME" \
    "$PGIMAGE" >/dev/null || { echo "Could not start $PGIMAGE."; exit 2; }
  CLEANUP="docker rm -f $NAME"
  PSQL=(docker exec -i "$NAME" psql -U postgres)

  printf 'Waiting for postgres'
  for _ in $(seq 1 40); do
    "${PSQL[@]}" -d "$DBNAME" -c 'select 1' >/dev/null 2>&1 && break
    printf '.'; sleep 1
  done
  echo
elif command -v initdb >/dev/null 2>&1 || [[ -x /usr/lib/postgresql/16/bin/initdb ]]; then
  BIN="$(command -v initdb >/dev/null 2>&1 && dirname "$(command -v initdb)" || echo /usr/lib/postgresql/16/bin)"
  echo "No docker daemon; using a throwaway cluster from $BIN."
  command -v psql >/dev/null 2>&1 \
    || { echo "Found $BIN but no psql on PATH - the check cannot run."; exit 2; }
  DATA="$(mktemp -d)"
  chmod 777 "$DATA"

  # postgres refuses to run as root, so a cluster started here runs as
  # whatever unprivileged account is available.
  RUNAS=""
  if [[ "$(id -u)" -eq 0 ]]; then
    RUNAS="$(id -un postgres 2>/dev/null || id -un nobody 2>/dev/null || true)"
    [[ -z "$RUNAS" ]] && { echo "Running as root with no unprivileged account to fall back on."; exit 2; }
    chown -R "$RUNAS" "$DATA"
  fi
  run() { if [[ -n "$RUNAS" ]]; then su "$RUNAS" -c "$1"; else bash -c "$1"; fi; }

  run "$BIN/initdb -D $DATA/db -U postgres -A trust" >/dev/null 2>&1 \
    || { echo "initdb failed."; exit 2; }
  mkdir -p "$DATA/run"; [[ -n "$RUNAS" ]] && chown "$RUNAS" "$DATA/run"
  run "$BIN/pg_ctl -D $DATA/db -l $DATA/pg.log -o '-p 5455 -k $DATA/run' start" >/dev/null 2>&1 \
    || { echo "Could not start postgres. Log:"; tail -20 "$DATA/pg.log"; exit 2; }
  CLEANUP="run \"$BIN/pg_ctl -D $DATA/db stop -m immediate\"; rm -rf $DATA"

  PSQL=(psql -h "$DATA/run" -p 5455 -U postgres)
  "${PSQL[@]}" -q -c "CREATE DATABASE $DBNAME;" >/dev/null 2>&1
else
  echo "Need either a running docker daemon or a local postgres install."
  echo "On the server, docker is there. Locally: apt install postgresql-16."
  exit 2
fi

# A check that cannot reach its database must say so, not report every file
# as failed. Exit 2 is "could not run"; exit 1 below is "ran, and found rot".
"${PSQL[@]}" -d "$DBNAME" -c 'select 1' >/dev/null 2>&1 \
  || { echo "Could not reach the throwaway database. The check did NOT run."; exit 2; }

# ── Pass 1: build it from nothing ───────────────────────────────────────────
echo
echo "Pass 1 — applying every file in filename order, into an empty database."
echo

failed=0
count=0
for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  # deploy.sh skips these, so this must too — otherwise it tests something
  # production never runs.
  case "$name" in *seed*) continue ;; esac
  count=$((count + 1))

  if out="$("${PSQL[@]}" -v ON_ERROR_STOP=1 -q -d "$DBNAME" 2>&1 < "$f")"; then
    continue
  fi
  failed=$((failed + 1))
  echo "  FAILED  $name"
  echo "$out" | grep -E 'ERROR|FATAL' | head -2 | sed 's/^/          /'
  echo
done

if [[ $failed -gt 0 ]]; then
  echo "────────────────────────────────────────────────────────────────"
  echo "$failed of $count files failed on an EMPTY database."
  echo
  echo "Production is probably fine — the objects already exist there, so"
  echo "these same files re-run without complaint. What is broken is every"
  echo "FRESH database: a rebuild, a restore from backup, or a new"
  echo "developer's first setup."
  echo
  echo "'does not exist' almost always means filename order. The folder is"
  echo "applied as a plain string sort, so a file must be named such that"
  echo "everything it depends on sorts EARLIER. See $DIR/README.md, and"
  echo "infra/scripts/rename-migrations-to-true-dates.sh."
  exit 1
fi

echo "  $count files applied cleanly."

# ── Pass 2: every file re-runs on every deploy ──────────────────────────────
echo
echo "Pass 2 — applying all $count again, because deploy.sh does."
echo

repeat=0
for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  case "$name" in *seed*) continue ;; esac
  if out="$("${PSQL[@]}" -v ON_ERROR_STOP=1 -q -d "$DBNAME" 2>&1 < "$f")"; then
    continue
  fi
  repeat=$((repeat + 1))
  echo "  NOT IDEMPOTENT  $name"
  echo "$out" | grep -E 'ERROR|FATAL' | head -2 | sed 's/^/                  /'
  echo
done

if [[ $repeat -gt 0 ]]; then
  echo "────────────────────────────────────────────────────────────────"
  echo "$repeat file(s) work once and fail the second time."
  echo
  echo "Every file here re-runs in full on EVERY deploy, and deploy.sh stops"
  echo "on the first error and refuses to recreate the app containers. So"
  echo "this does not break the deploy that adds the file — it breaks the"
  echo "NEXT one, when nobody is looking for it."
  echo
  echo "Use IF NOT EXISTS, CREATE OR REPLACE, and DROP POLICY IF EXISTS"
  echo "before CREATE POLICY."
  exit 1
fi

echo "  $count files re-applied cleanly."
echo
echo "────────────────────────────────────────────────────────────────"
echo "A fresh install would work, and a second deploy would too."
echo "($count files, twice. This says nothing about whether the schema is"
echo " the one the application expects — only that it can be built.)"

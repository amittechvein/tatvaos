#!/usr/bin/env python3
"""
verify-one-migration.py - prove ONE migration against an ALREADY-DEPLOYED
database, including a state you arrange by hand.

THIS IS NOT infra/scripts/verify-migrations.sh, AND DOES NOT REPLACE IT.
Different question, different guarantee. A green here is not a deploy gate.

A migration has at least two states to prove against:

  1. EMPTY            - it applies to a database built from nothing.
  2. ALREADY-DEPLOYED - it applies to a database that has been running, where
                        earlier files have had their effect and somebody has
                        since changed a row through the console.

verify-migrations.sh covers state 1 by design: it builds the whole directory
from nothing and re-applies it. This script is the first tool we have that can
reach state 2. Run both. Neither substitutes for the other.

WHY STATE 2 IS NOT ACADEMIC
---------------------------
20260909-hire-people-products.sql, 9 September 2026. 0028-product-catalogue.sql
used to DELETE the 'people' row; this file re-inserted it, taking the INSERT
branch rather than ON CONFLICT UPDATE - and the INSERT branch sets
is_available = false. So the day somebody flipped People live in the console,
the next deploy switched it off again, silently, and nobody would have connected
a deploy to a product vanishing.

On a FRESH install nothing inserts 'people' before 0028, so the DELETE is a
no-op and the interaction does not exist at all. A forward-reference check, an
ordering check and a clean apply from empty were all run against that file.
All three were green, all three were correct, and all three were STRUCTURALLY
BLIND to it: they could only ever see the case where the bug cannot appear.

It was found by arranging the state where it lives - flip the row, then re-run
the file as a deploy would. That is what --arrange is for.

PRODUCE THE RED FIRST
---------------------
--calibrate takes a deliberately broken copy of the migration and fails the run
unless that copy breaks one of your expectations. A check nobody has seen go red
is not a check (house rule 6). Without a calibration, "two clean runs" is a
sentence, not a result. The flag is optional so the tool stays usable; when it
is omitted the output says so, every time.

ASSERTION GOTCHA, met the day this was written
----------------------------------------------
psql -t -A renders a boolean as 'true'/'false' inside a concatenation
(SELECT code || '=' || is_available) but as 't'/'f' when selected alone
(SELECT is_available). An assertion written for one form fails against the
other. That produced a red on a correct migration, which is the SAFE direction.
The dangerous version is an assertion loose enough to go GREEN on a broken one -
so compare exact strings and let a mismatch shout.

USAGE
-----
  pip install --break-system-packages pgserver     # ships its own Postgres 16;
                                                   # no root, no Docker
  python3 infra/scripts/verify-one-migration.py \
      local/postgres/init/20260909-hire-people-products.sql \
      --stub /tmp/stub.sql \
      --arrange "UPDATE core.products SET is_available = true WHERE code='people'" \
      --expect "SELECT is_available FROM core.products WHERE code='people'=t" \
      --calibrate /tmp/broken-variant.sql

--stub is required and is yours to write: the minimum schema this one file
needs. There is deliberately no default. Guessing a schema for you is how a
harness ends up proving something about a shape the repo does not have.
"""

import argparse
import os
import subprocess
import sys
import tempfile

PGCRYPTO_NOTE = "citext and pgcrypto are unavailable here (no root); stub those columns as text"


def load_pgserver():
    try:
        import pgserver
        return pgserver
    except ImportError:
        sys.exit(
            "pgserver is not installed.\n"
            "  pip install --break-system-packages pgserver\n"
            "It ships its own Postgres 16 binaries, so this needs neither root nor Docker."
        )


class Db:
    """One throwaway Postgres. Dies with this process."""

    def __init__(self, pgserver, label):
        self.label = label
        self.dir = tempfile.mkdtemp(prefix="verify-one-%s-" % label)
        self.server = pgserver.get_server(self.dir)
        self.uri = self.server.get_uri()
        self.psql_bin = os.path.join(os.path.dirname(pgserver.__file__), "pginstall", "bin", "psql")

    def run(self, sql=None, path=None):
        cmd = [self.psql_bin, self.uri, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A"]
        cmd += ["-f", path] if path else ["-c", sql]
        p = subprocess.run(cmd, capture_output=True, text=True)
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()


def split_expectation(raw):
    """'SELECT ...=value' -> (sql, expected). Splits on the LAST '=' so that
    SQL containing '=' works without escaping."""
    if "=" not in raw:
        sys.exit("--expect needs the form \"SQL=EXPECTED VALUE\": %r" % raw)
    sql, expected = raw.rsplit("=", 1)
    return sql.strip(), expected.strip()


def play(db, migration, stub, runs, arrange, expectations, log):
    """Apply stub, run the migration `runs` times, arrange state, run once more,
    then evaluate expectations. Returns list of (label, ok, detail)."""
    results = []
    rc, out = db.run(path=stub) if os.path.exists(stub) else db.run(sql=stub)
    if rc != 0:
        sys.exit("the --stub failed to apply:\n" + out)

    for i in range(1, runs + 1):
        rc, out = db.run(path=migration)
        results.append(("run %d of %d applies cleanly" % (i, runs), rc == 0, out if rc else ""))
        if rc != 0:
            return results

    if arrange:
        rc, out = db.run(path=arrange) if os.path.exists(arrange) else db.run(sql=arrange)
        if rc != 0:
            sys.exit("the --arrange step failed:\n" + out)
        rc, out = db.run(path=migration)
        results.append(("re-applies after the arranged change", rc == 0, out if rc else ""))

    for sql, expected in expectations:
        rc, out = db.run(sql=sql)
        ok = (rc == 0 and out == expected)
        results.append(("expected %r" % expected, ok, "got %r" % out))
    return results


def main():
    ap = argparse.ArgumentParser(
        description="Prove ONE migration against an already-deployed database. "
                    "Not a replacement for verify-migrations.sh.")
    ap.add_argument("migration", help="the .sql file under test")
    ap.add_argument("--stub", required=True,
                    help="SQL file (or literal SQL) creating the minimum schema this file needs")
    ap.add_argument("--runs", type=int, default=2,
                    help="how many times to apply it; every file here re-runs on every deploy (default 2)")
    ap.add_argument("--arrange", metavar="SQL",
                    help="SQL file or literal applied AFTER the first run: the already-deployed state")
    ap.add_argument("--expect", action="append", default=[], metavar="SQL=VALUE",
                    help="assertion evaluated after the final run; repeatable")
    ap.add_argument("--calibrate", metavar="BROKEN.sql",
                    help="a deliberately broken copy; the run FAILS unless it breaks an expectation")
    args = ap.parse_args()

    pgserver = load_pgserver()
    expectations = [split_expectation(e) for e in args.expect]

    print("verify-one-migration: %s" % os.path.basename(args.migration))
    print("  %s\n" % PGCRYPTO_NOTE)

    main_db = Db(pgserver, "subject")
    results = play(main_db, args.migration, args.stub, args.runs, args.arrange, expectations, print)
    failed = []
    for label, ok, detail in results:
        print("  %s  %s%s" % ("PASS" if ok else "FAIL", label, ("   " + detail) if detail else ""))
        if not ok:
            failed.append(label)

    calibrated = False
    if args.calibrate:
        if not expectations:
            failed.append("--calibrate needs at least one --expect to break")
            print("  FAIL  --calibrate given with no --expect: nothing for the broken copy to break")
        else:
            cal_db = Db(pgserver, "calibration")
            cal = play(cal_db, args.calibrate, args.stub, args.runs, args.arrange, expectations, print)
            broke = [lbl for lbl, ok, _ in cal if lbl.startswith("expected") and not ok]
            calibrated = bool(broke)
            print("\n  %s  CALIBRATION: the broken copy %s" % (
                "PASS" if calibrated else "FAIL",
                "fails %d expectation(s), so a red is reachable" % len(broke) if calibrated
                else "passed everything - these expectations cannot go red, so their green means nothing"))
            if not calibrated:
                failed.append("calibration")

    print("\n  Proved: this file applies and re-applies %s, and the expectations above hold." % (
        "against the state you arranged" if args.arrange else "against a stubbed schema"))
    print("  NOT proved: that local/postgres/init builds from nothing (that is")
    print("              verify-migrations.sh, a different guarantee - run it too);")
    print("              nor any behaviour that depends on real column types. This")
    print("              harness has no citext and no pgcrypto, so a column stubbed")
    print("              as text will not show you citext's own case or uniqueness")
    print("              semantics. If your constraint leans on those, this is blind.")
    if not args.calibrate:
        print("  NOT calibrated: no --calibrate was given, so nothing here has been seen")
        print("              to go red. Treat the greens as untested until it has.")

    print("\n%s" % ("ALL CHECKS PASSED" if not failed else "FAILED: " + ", ".join(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

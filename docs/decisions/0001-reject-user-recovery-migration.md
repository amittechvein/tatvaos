# 0001 — Reject `20260904-user-recovery.sql`, and split the work that was in it

**Status:** accepted
**Date:** 2026-09-13
**Decided by:** CTO. Flagged originally by Mail, who diffed the file and was
right that it was dangerous.

---

## Context

An untracked file, `local/postgres/init/20260904-user-recovery.sql`, sat in the
migrations directory for four weeks. Untracked, so it never reached production —
a deploy ships `main`. But **every file in `local/postgres/init/` re-runs on
every local stack start**, so it was live for anyone bringing up `local/`, and
one `git add .` from being live for everyone.

It did two unrelated things: added `core.users.recovery_email` (nullable, plus
an index), and made `core.users.phone` mandatory — `NOT NULL` plus
`CHECK (length(phone) > 0)`. Its header claimed *"Idempotent and additive."*

It was flagged three times. **The diagnosis attached to it was wrong all three
times, in the reassuring direction**, which is the reason this record exists.

### The diagnosis we carried

Stated repeatedly, including by me: it backfills `phone = ''` and then adds
`CHECK (length(phone) > 0)` against the rows it just emptied, so it fails, so
it breaks every deploy at that file.

The first clause is true. The conclusion is not.

```sql
UPDATE core.users SET phone = '' WHERE phone IS NULL;          -- line 27

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'users'
               AND column_name = 'phone' AND is_nullable = 'YES') THEN
    ALTER TABLE core.users ALTER COLUMN phone SET NOT NULL;
    ALTER TABLE core.users ADD CONSTRAINT check_phone_not_empty
      CHECK (length(phone) > 0);                                -- line 39
  END IF;
END $$;
```

The destructive pair is guarded by `is_nullable = 'YES'`:

| Against | Pass 1 | Pass 2 |
|---|---|---|
| An **empty** database | line 27 empties nothing; constraint added — **passes** | guard sees `is_nullable = 'NO'`, block skipped — **passes** |
| A database with **any** user whose `phone` is NULL | those rows become `''`; the constraint rejects them — **fails** |  |

So the file **passes `infra/scripts/verify-migrations.sh`**, and therefore
passes the `Migrations / Build twice` gate merged as #95, because that gate
builds from nothing. It fails only against a database that already holds rows.
Production is the only such database.

"Breaks every deploy" describes a fault CI catches, and a fault that is
self-limiting — so nobody hurried. The real shape is **passes CI, fails once,
in Mumbai.** This is precisely the limit stated in the header of
`.github/workflows/migrations.yml`: *green means the schema CAN BE BUILT,
twice; it says nothing about whether it is the schema the application expects.*
That sentence was written as a caution on 8 September. This file is its first
instance.

### Two further defects, found in the same reading

1. **Both guards ask about the wrong table.** Every `information_schema.columns`
   lookup filters on `table_name = 'users'` with **no `table_schema`
   predicate**. `information_schema` spans schemas, so a `users` table in any
   other schema satisfies the guard. The condition and the action can refer to
   different objects.
2. **The guard tests nullability but protects a constraint.** `ADD CONSTRAINT`
   is not idempotent alone; here it is shielded by a nullability check, which
   works only because this file is the sole thing setting `NOT NULL`. Should
   `phone` become `NOT NULL` by any other route, `check_phone_not_empty` is
   **silently never added** and the file still reports success.

---

## Options

1. **Fix it in place.** Cheapest in the moment. Rejected: it bundles an
   uncontroversial additive column with a product decision nobody has made, and
   leaving it in `local/postgres/init/` keeps it running on every local stack
   while it is being argued about.
2. **Delete it.** Clean. Rejected: the `recovery_email` half is worth having and
   the fault analysis would go with it.
3. **Remove it from the tree, keep the file, record the analysis.** Chosen.

---

## Decision

The file is **rejected and moved out of the repository.** It now sits outside
the tree as `20260904-user-recovery.sql.rejected`. Nothing is lost.

There is **nothing to rebuild** for recovery email — see the correction above;
it is already on `main`. What remains is only the phone question, owner
**Core**, since `core.users` is Core's table:

- **`phone` mandatory is a product decision and goes to Amit first.** It was
  never brought to him. Every existing user without a phone number either gets
  asked for one or loses their recovery path.
- **Never backfill to a value the constraint forbids.** Collect the data, prove
  no NULLs remain, *then* constrain. A migration cannot invent a phone number.
- **Guard on `table_schema` and `table_name` together**, and guard on the
  existence of the thing being created — `pg_constraint` for a constraint — not
  on a proxy for it.
- **Prove it against a copy that has rows.** A fresh-build check cannot see
  this class of fault. `docs/runbooks/backup-and-restore.md` is the path to such
  a copy.

---

## Correction, 13 September 2026 — same day, after Core's handover

**The paragraph below that said "recovery email is now unstarted" was wrong,
and it was wrong for the second time in one document about the same file.**

`local/postgres/init/20260904-user-recovery-email.sql` is **tracked, on `main`,
and shipped.** It implements recovery email properly and better: five columns
rather than one, `recovery_email_verified_at` so an unverified address can never
be used for recovery, a SHA-256 `recovery_email_token_hash`, an attempts
counter, and a *partial* index. Its header records why it is non-unique on
purpose.

So the rejected file was not half a feature. **Both halves were bad:**

- the `recovery_email` half was a **worse duplicate of work already in the
  tree** — a bare nullable `text` column with no verification and no token, and
  on any database that had already run the tracked migration it was a near
  no-op, because its own `IF NOT EXISTS` guard saw the column and skipped;
- the `phone` half was the only part with live effect, and its effect was the
  damage described above.

That makes the rejection a **rule 10** case as well as a rule 6 one: two copies
of one fact, and the copy that drifted was the untracked one. Had anyone
compared the two filenames — `20260904-user-recovery.sql` and
`20260904-user-recovery-email.sql`, same date, adjacent in a directory listing —
the duplication was visible without reading either.

**How I got it wrong:** I searched `local/postgres/init/` for the file I was
rejecting, read it, and ruled. I never listed the directory for anything else
matching. The claim "recovery email is unstarted" was not checked at all — it
was inferred from the file I had just deleted, which is the same move as
inferring the state of `main` from a working tree.

Found by Core, in a handover, hours after this record was merged.

---

## Consequences

**Easier:** `local/postgres/init/` contains only tracked files again, so
`git status` in the integration checkout is meaningful rather than noisy.

**Nothing lost.** Recovery email was already shipped, properly, in
`20260904-user-recovery-email.sql`. The rejected file added nothing to it.

**Accepted:** the `Migrations / Build twice` gate cannot catch faults that need
existing rows to appear. We are keeping the gate — it catches non-idempotent
DDL, which is what it claims — and not letting its green light mean more than
its header says.

---

## The general lesson

House rule 6 says a check with no failure mode is not a check. This adds the
corollary:

> **A fault description is itself a claim, and it decays like any other.**
> "We know about that one, it breaks the deploy" retired the question for four
> weeks. Being wrong in the *reassuring* direction is what made the error
> durable. Re-read the artefact, not the note about the artefact.

Mail's parting formulation of the same thing, 13 September 2026, and the
cheapest version of it:

> When a session tells you something is verified, ask what they actually ran,
> and what would have made it fail.

---

## Revisit when

Amit rules on whether a phone number is mandatory for every TatvaOS user. That
ruling unblocks a rewritten, split migration; until then there is nothing to
rebuild.

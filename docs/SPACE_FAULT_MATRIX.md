# Space — faults, and whether they have ever actually run

**Purpose.** Every fault whose handling path has never executed, what we
*believe* happens, and what is genuinely unknown. Three entries have since
been closed with real runs; five remain, and this is the list a staging box
would work through.

**Status: the box is deferred, deliberately** (Amit, 23 August 2026). With no
live clients, production breaking costs us time rather than a customer, so the
spend waits. **The agreed trigger to revisit is the first real deployment** —
before a paying customer exists, not after. Nobody owns that date, which is
why it is written here rather than remembered.

**This is a living list.** Add to it on the day you want to exercise something
and can't, while you still remember exactly what you'd have broken and what
you expected to see.

Written 23 August 2026, after `20260819-space-link-loss-logging.sql` broke
every deploy on the platform for a day — a fault nothing exercised because the
failure only appears on the *second* run of a thing we only ever tested once.
Updated 24 August with Core's results on #1, #3 and #4.

---

# Closed — exercised, with evidence

## #4 · Racing `consume_public_link` — **HOLDS**

The most-defended property in the public-link design: consume is an atomic
`UPDATE ... RETURNING` rather than a SELECT-then-UPDATE, so `max_downloads`
cannot be raced past. It had never been raced.

**Now it has.** `infra/scripts/verify-link-race.sh` — 89 raced rounds across
three runs, zero failures. Every round that reached the database produced
exactly one `200`, one `404`, and a count that stopped at the cap. The
second-fired request won roughly half the rounds, so the requests genuinely
interleaved and the UPDATE picked a winner from either direction.

Evidence, not proof — the script says so itself, which is the right posture
for a concurrency test.

**The script lied twice before it told the truth, and both lies matter more
than the result:**

- **It raced the wrong URL.** The first run hit the landing page rather than
  the download route: `200`, some HTML, consumes nothing. Verdict:
  *"10/10 FAIL, the cap is not being enforced"* — against completely correct
  code. The tell was the count sitting at `0`; a real failure leaves `1` or
  `2`. There is now a calibration round: one request must move the count
  `0 → 1` before the script is permitted to conclude anything.
- **It reported a working defence as the bug it was hunting.** At 100 rounds,
  51 came back `429/429` and were printed as "broke the cap". That was the
  rate limiter on the anonymous endpoint correctly refusing 200 requests from
  one IP. Rate-limited rounds are now counted separately and excluded from the
  verdict.

## #1 · Orphaned blobs — **findable, as the pass condition required**

The mirror of the missing-blob case: bytes on the volume with no row. We had
loud detection for *row present, blob missing* and **nothing at all** for the
reverse — an orphan consumed disk forever, was charged to no quota, and
appeared in no query.

**Now:** `SpaceBlobSweepWorker`, every 6 hours in production. It walks the
volume and batches keys through `space.blob_keys_present()` (SECURITY DEFINER;
answers only about keys the caller already holds, so it discloses nothing).
Soft-deleted files count as present, so the trash does not read as a leak.
Orphans are **reported and never deleted** — count, wasted bytes, oldest five
keys, at WARNING. Deletion stays a human act until the report has months of
credibility behind it, which is the right order: earn trust in the detector
before arming it.

A 24-hour grace period means an upload mid-commit never reads as a leak.
Proven with a planted orphan backdated two days: named exactly, flagged
*NOT deleted — a person must confirm*.

## #3 · `.part` debris — **it was a missing feature, and it is now written**

Correctly reclassified. "Nothing sweeps `.part` files on startup" was never a
test; it was absent code, quietly accumulating debris on the disk Mail shares.
The same worker now deletes `.part` files older than 6 hours — unambiguous,
because only the blob store writes them and nothing reads them. Proven with a
planted 7-hour-old file: removed and logged.

---

# Still box-only — five

## #2 · The blob volume fills mid-upload

**Induce:** fill `spaceblobs` to capacity, then upload.

**Believed:** `WriteAsync` throws, the `catch` deletes the `.part`, the caller
gets a 500.

**Unknown:** whether the user is told anything true. The quota gate *passed* —
the tenant has room, the disk does not — so "there is not enough Space storage
left" would be a lie. Also unknown whether deleting the partial file succeeds
on a full disk.

## #5 · Concurrent overwrite of the same file

**Induce:** two `PUT /files/{id}/content` at once.

**Believed:** both write new blobs, both repoint the row, the loser's blob is
orphaned — which #1's sweep would now *find*, though nothing prevents it.

**Unknown:** whether `size_bytes` ends up matching the blob the row actually
points at. If it doesn't, the quota figure is wrong until the next reconcile.

## #6 · The purge worker killed mid-subtree

**Induce:** kill the API during a folder purge with many files.

**Believed:** blobs go before rows, so an interrupted pass leaves rows whose
blobs are gone — detected, but only when someone tries to download one.

**Unknown:** whether the next pass completes the job or skips the partly-done
subtree.

## #7 · A real decompression bomb through the thumbnail path

**Induce:** upload a genuine bomb (a few hundred KB decompressing to
gigabytes) and request its thumbnail.

**Believed:** the header-read pixel caps reject it before any pixel is
decoded; the timeout is the backstop.

**Unknown:** whether `SKCodec.Create` itself allocates before we ever read
`Info`. The defence assumes header parsing is cheap. Nobody has fed it a real
bomb — and this one stays box-only precisely because a failed defence eats the
memory of the process serving everyone.

## #8 · Isolation, exercised rather than reasoned

**Induce:** two real users in two real tenants; attempt every Space endpoint
against the other's ids.

**Believed:** RLS refuses everything; invisible items 404.

**Unknown:** nothing is *suspected* — but this is the property the entire
schema exists to provide, and it has been verified by reading policies rather
than by attempting the access.

---

# Exercised routinely

- **`verify-migrations.sh`** — all 54 migration files against a scratch
  database from empty, then the whole set again against the same database.
  Both of this week's ordering bugs die in it: the `consume_public_link`
  return-type conflict that blocked every deploy for a day, and the
  future-dated Connect files that would have failed on any fresh install.
  Refuses to run unless the target name begins with `scratch_`.
- **`verify-loss-refund.sh`** — the deleted-blob path: ordinary 404, a warning
  naming `fileId`/`linkId`/`blobKey`, and `download_count` unchanged. Guards
  the `rm`: name must match `delete-me-test-*`, exactly one row, under 1 MiB,
  and the operator types `DELETE` having been shown what will be destroyed.
- **`verify-link-race.sh`** — #4 above, with its calibration round.
- **The 40 MB end-to-end** — a real file, a real Gmail address, opened with no
  session. The only test that has ever caught the seam bugs.

---

# The pattern

**Invisible failure is the house style of this codebase.** The `/info` route
that made every valid link look dead; the `jsonb` column Connect never mapped,
failing every insert for weeks; the migration that broke deploys only on its
second run; blobs charged to nobody; recordings charged to nobody. In each
case the system carried on and told no one.

The single fault we had built detection for — missing blob — was the only one
that announced itself. That was not judgement. It was the one someone asked
about.

**And the newer lesson, which cost three drafts of one script: a test whose
failure mode is indistinguishable from its success will confidently report
either.** Three separate instances now:

- a deleted-blob recipe where "count unchanged" was satisfied both by *refunded*
  and by *never consumed*;
- a race script that hit the landing page and declared correct code broken;
- the same script reporting the rate limiter — a defence, working — as the
  breach it was hunting.

The fix is the same each time and it is cheap: **make the test prove it can
observe the thing before letting it report the thing's absence.** A calibration
round, a positive control, one known-good pass first. Without it, a green run
and a broken instrument look identical — which is the same failure as a checker
that crashes instead of reporting, and as an error handler that hides our bugs
as effectively as it hides an attacker's.

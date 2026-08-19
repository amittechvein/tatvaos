# Schema files — naming and ordering

Every `.sql` file in this directory is applied **in filename order, on every
deploy**, by `infra/scripts/deploy.sh`, and on first initialisation of an empty
database by Postgres itself (this directory is mounted as
`/docker-entrypoint-initdb.d`).

Two consequences follow, and both have bitten us.

## 1. Every file must be idempotent

`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS` before
`CREATE POLICY`, guarded `ALTER TABLE ... ADD COLUMN`. These files re-run in
full on every single deploy. A migration that only works once will fail the
deploy the second time — `deploy.sh` stops on the first error and refuses to
recreate the app containers, which is the correct behaviour and also a very
confusing outage if you did not expect it.

Because they re-run every time, **the database does not record which files have
been applied**. That in turn means renaming a file here is safe: nothing tracks
the old name.

## 2. Filename order is dependency order — and it is a plain string sort

New files are **date-prefixed**: `YYYYMMDD-name.sql`, e.g.
`20260904-connect-minutes.sql`. Dates cannot collide the way sequence numbers
did (we had three collisions in two days: `13-`, `14-`, `15-` and `29-` each
exist twice, which is why they look odd).

**The legacy files are padded to four digits (`0000-` … `0031-`) for exactly
one reason: so that they sort before the dated ones.** A plain string sort puts
`20260816-` *before* `21-`, because the second character `0` is less than `1`.
That meant `20260816-space-public-links.sql` ran before
`0025-space-schema.sql` had created `space.files`, and any fresh database —
a rebuild, a restore from backup, or a new developer's first local setup —
failed on the foreign key. Production never noticed, because the objects
already existed there.

So:

- **Legacy numbered files stay four digits.** Do not un-pad them, and do not
  add new numbered files.
- **New files are `YYYYMMDD-name.sql`.** They will sort after everything
  numbered, and among themselves in chronological order.
- **If two files land on the same date**, order them by name
  (`20260904-a-...`, `20260904-b-...`) and make the dependency explicit in a
  comment at the top of the later one.
- **Anything a file depends on must appear earlier in this sort.** Check it by
  eye with `ls` — that is exactly what the loop in `deploy.sh` sees.

## 3. `*seed*` files are skipped on cloud deploys

`deploy.sh` skips any filename containing `seed`. They exist so the local stack
and CI have two tenants to prove isolation against; on production they would be
fictional customers with development passwords, visible in the console.

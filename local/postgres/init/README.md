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
`20260819-connect-minutes.sql`. Dates cannot collide the way sequence numbers
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
  (`20260819-a-...`, `20260819-b-...`) and make the dependency explicit in a
  comment at the top of the later one.
- **Anything a file depends on must appear earlier in this sort.** Check it by
  eye with `ls` — that is exactly what the loop in `deploy.sh` sees.

## 3. `*seed*` files are skipped on cloud deploys

`deploy.sh` skips any filename containing `seed`. They exist so the local stack
and CI have two tenants to prove isolation against; on production they would be
fictional customers with development passwords, visible in the console.

## The 2026-08-29 rename — reading older documents

Thirteen Connect migrations, one Core migration and one Mail migration wore
September dates in August: `20260901-connect.sql` was written on the 17th, and
every later file inherited the fiction to sort after it. With five lanes
deploying independently that fiction became a shared trap — a migration dated
TODAY sorted before work shipped two weeks ago — so the set was renamed to real
dates.

Historical records (session logs, `verify-migrations.sh`'s incident note) still
use the old names, correctly: they describe what things were called at the
time. This table decodes them.

| Old (false) name                          | Current name                              |
|-------------------------------------------|-------------------------------------------|
| `20260901-connect.sql`                     | `20260817-connect.sql`                     |
| `20260902-connect-recording.sql`           | `20260818-connect-recording.sql`           |
| `20260903-connect-notes-attendance.sql`    | `20260819-connect-notes-attendance.sql`    |
| `20260904-connect-minutes.sql`             | `20260819-connect-minutes.sql`             |
| `20260905-connect-host-controls.sql`       | `20260819-connect-host-controls.sql`       |
| `20260906-connect-notes-wait-recording.sql`| `20260819-connect-notes-wait-recording.sql`|
| `20260907-connect-retention.sql`           | `20260819-connect-retention.sql`           |
| `20260908-connect-meeting-mode.sql`        | `20260820-connect-meeting-mode.sql`        |
| `20260909-connect-chat-policy.sql`         | `20260823-connect-chat-policy.sql`         |
| `20260910-connect-live-minutes.sql`        | `20260823-connect-live-minutes.sql`        |
| `20260911-connect-captions.sql`            | `20260823-connect-captions.sql`            |
| `20260911-connect-retention-default-30.sql`| `20260823-connect-retention-default-30.sql`|
| `20260911-connect-storage-charge.sql`      | `20260823-connect-storage-charge.sql`      |
| `20260911-core-ai-per-org.sql`             | `20260826-core-ai-per-org.sql`             |
| `20260912-mail-app-passwords-unique.sql`   | `20260829-mail-app-passwords-unique.sql`   |

Three dates are declared approximations, chosen so no file sorts before its own
dependency:

- `…connect-notes-attendance` was authored on the 18th and carries the 19th.
  Real dates alone were not enough here: it only ALTERs `connect.meeting_notes`,
  which `20260818-connect-recording.sql` creates, and within one date
  alphabetical order put `notes-attendance` BEFORE `recording`. The old numeric
  scheme (`02-recording`, `03-notes-attendance`) had encoded that dependency by
  accident; real dates lost it. `verify-migrations.sh` caught it on the first
  run of this branch — `relation "connect.meeting_notes" does not exist` — which
  is the entire argument for running it rather than reading the listing.
- `…retention-default-30` was authored on the 22nd but keeps its place after the
  23rd's files.
- `…mail-app-passwords-unique` was authored on the 27th but ALTERs tables
  `20260828-mail-app-passwords.sql` creates, so it carries the date it landed
  on main.

**A date alone does not encode a dependency.** Same-day files sort
alphabetically, so two migrations dated together are ordered by their suffixes —
which nobody chose for that purpose. When a new migration depends on one landing
the same day, give it the NEXT day and say why, or confirm the alphabetical
order happens to be right. `verify-migrations.sh` is what settles it. A file's name is its position in the build order
first and its birthday second — that ordering is what `verify-migrations.sh`
proves, and it is the property that broke twice in August.

# TatvaOS Space — backend brief

**Product:** file storage and sharing at `space.tatvaos.com`, in the shape people
already know from Google Drive.
**Backend:** you. **Frontend:** Core dev (me).
**Written against `main` as of `23-storage-warnings.sql`.**

Read this before writing code. Most of it is not about Space — it is about the
five traps this codebase has already sprung on people, and the one architectural
rule that makes Space a TatvaOS product rather than a file server with our logo.

---

## 1. The rule that matters most: storage is bought ONCE

This is the product's central promise and Space is the first thing to test it.

A customer buys **one** number. `core.storage_pools` holds it. They divide it
across products themselves in `core.storage_allocations` (one row per
`tenant_id` + `product_code`) — 1.5 TB to Mail, 500 GB to Space, rebalanced
whenever they like, no new purchase and no support ticket.

**Space must not invent its own quota system.** No `space_quota_bytes` column,
no per-user gigabyte setting that only Space knows about. If you find yourself
writing one, stop and talk to me — it means the pool abstraction is missing
something, and the fix belongs in `StorageAllocator`, not beside it.

What you inherit for free by using it: the storage page, the 80%/95% warning
emails, and the add-user gate all already read those tables. Space appears in
them the moment it writes a `storage_allocations` row.

### The one piece of plumbing you must extend

`core.reconcile_storage_usage(uuid)` in `17-storage-usage.sql` derives
`used_bytes` by summing `mail.mailboxes`. It is **mail-only today**. Space needs
the same treatment: sum your file table into the `('space')` allocation row in
the same function.

Do it the same way — **derived, not incremented**. An incremental counter drifts
the moment a crash lands between writing a file and bumping the total, and
nothing ever notices. That exact bug shipped here: `used_bytes` was read in four
places and written by none, so every organisation reported zero usage for
months. A derivation cannot drift.

---

## 2. Product code — a decision I need from you and Amit

`core.products` already seeds `('drive', 'TatvaOS Drive', ..., false, 20)`. The
nav, the app launcher and the entitlement checks all key off product codes.

Two options:

- **Reuse `drive`** and rename the display text to Space. No new row, the
  launcher tile already exists, `is_available` flips to true.
- **Add `space`** as its own row and retire `drive`.

I lean to reusing `drive` as the code with "TatvaOS Space" as the name — the code
is an internal key and renaming it means touching the seed, the launcher, and any
`product_access` rows already granted. But it is mildly confusing forever, so it
is worth five minutes of agreement rather than a silent choice.

Whichever we pick: **Family shipped without its row in `core.products` and was
invisible to entitlement for weeks.** Do not repeat that. Add or flip the row in
your first migration.

---

## 3. Where the bytes live — decide before you write the schema

Not in Postgres. `core.user_avatars` stores images as `bytea` because they are
capped at 2 MB; a Drive-shaped product cannot use that pattern.

Two realistic options:

- **A filesystem volume**, the way Mail stores maildirs. Simple, no new
  dependency, and the DPDP residency question answers itself. Needs a docker
  volume, a `blob_key` column, and care around the API container's UID (see §5).
- **S3-compatible object storage** in an Indian region. Better long term for
  large files and signed URLs; adds a dependency and a credential to manage.

I would start with the volume and keep a `blob_key` indirection so a move to
object storage later is a migration of bytes rather than a rewrite of the model.
Say which you pick and why — it is the hardest thing to change afterwards.

**Do not stream file bytes through API process memory.** A 2 GB upload buffered
in the request pipeline will take the container down for every other tenant.

---

## 4. Isolation — RLS, and the per-user setting Family added

New schema (`space`). Follow `19-family-schema.sql`, which is the best model in
the repo because Family needed exactly what you need: **per-user** visibility,
not merely per-tenant.

- Content tables: `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, with a
  `tenant_isolation` policy on both `USING` and `WITH CHECK`.
- `TenantConnectionInterceptor` sets **`app.tenant_id` and `app.user_id`** on
  every connection. Family added the second one; you get it for free.
- Read it as
  `nullif(current_setting('app.user_id', true), '')::uuid`. A null user id is
  sent as an **empty string**, and a bare `::uuid` on `''` raises. The `true`
  handles unset; the `nullif` handles set-but-empty. Both are needed — the
  Family dev broke their own tests learning this.
- Grant to `tatvaos_app`. **Do not grant to `tatvaos_mailedge`** — the mail edge
  has no business reading files.

Ownership model: copy Family's `ownership_type` ('personal' | 'organisational')
rather than inventing one. It already means the right thing, the console already
speaks it, and users will meet it in two products instead of learning two ideas.

**Departure:** Family's foreign key was `ON DELETE CASCADE` and hard-deleting a
user destroyed their entire address book while their mail was retained. We fixed
it to retain-with-null-owner. Use `ON DELETE SET NULL` from the start and make
sure your `CHECK` constraints permit an owner-less retained row, or user deletion
will fail outright.

---

## 5. Deployment traps that have already cost us days

**`space.caddy` needs `SPACE_DOMAIN` set in `infra/docker/.env`.** If the file is
mounted and the variable is unset, **Caddy rejects the entire config and
crash-loops** — that is a full site outage, not a broken subdomain. It has
happened here. Model the file on `infra/docker/conf.d/mail.caddy`, which proxies
`/api/*` same-origin deliberately so the browser never makes a cross-origin call
and the refresh cookie stays first-party.

**Auth is already done for you.** One JWT across products, and the refresh cookie
is scoped `Domain=.tatvaos.com`, so `space.tatvaos.com` is inside the session
with no work. Do not add a login.

**Migration numbering.** Next free is **24**. Numbers have collided across lanes
before (13, 14 and 15 all have two files). `deploy.sh` applies every
`local/postgres/init/*.sql` in sorted order on each deploy, so files must be
idempotent — `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `CREATE OR REPLACE`.
Check `ls local/postgres/init/` before you pick a number.

**Container UID.** The API runs as `5000:5000` (vmail) so the mail ingest worker
can read Dovecot's maildirs. Any volume Space writes to must be writable by that
UID, or you will get permission errors that look like application bugs.

**Service passwords: hex or alphanumeric only.** A `#` in a database password
silently truncated Dovecot's config and cost a day. `openssl rand -hex 32`.

---

## 6. Branch discipline — please read this one

Commits have landed on the wrong branch **five times** in the last week, costing
three consolidations and one production outage. The checkout is shared.

- `git rev-parse --abbrev-ref HEAD` before every commit.
- Do Space work on `feature/space-*` and rebase onto current `main` before
  handing it over.
- Production deploys now refuse to run from anything but `main` — that guard
  exists because a server sat on a feature branch and a week of deploys silently
  became no-ops.

---

## 7. What I need from you, in order

1. **The two decisions above** — product code, and where bytes live.
2. **Schema + migration 24**: files, folders, shares, versions if you want them
   early. Plus the `core.products` row.
3. **`reconcile_storage_usage` extended** to sum Space into its allocation.
4. **The endpoints**, roughly: list a folder, upload, download, move, rename,
   trash/restore, permanent delete, share (personal ↔ organisational), and a
   usage summary. Same shapes as Mail's — `authedFetch`, JSON, errors as
   `{ error: "sentence" }` because the console prints them verbatim.
5. **A quota check before accepting an upload**, using `StorageAllocator`. Note
   what `EvaluateAcceptAsync` learned the hard way: return a *reason*, not a
   bool. "Full", "suspended" and "no such folder" need different answers, and a
   caller given only `false` will guess wrong.

Tell me the endpoint shapes as soon as they are firm — even before they work. I
can build the frontend against a contract and we find the disagreements early,
which is how the storage page went smoothly.

---

## 8. What I am building

`space.tatvaos.com` — file browser, upload with progress, folder tree, sharing
UI, trash, and the storage meter reading from the same pool. Bootstrap/YZEN, same
console shell as Mail and Family. MUI is gone from this codebase; do not
reintroduce it.

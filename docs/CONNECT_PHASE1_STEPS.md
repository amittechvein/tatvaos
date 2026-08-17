# Connect Phase 1 — steps to complete

**Where this picks up:** the backend is written and in the working tree,
uncommitted. The migration is verified against a real PostgreSQL and every C#
file compiles. What remains is your machine, the frontend, and two review
gates that are not mine to clear.

**Route: straight to production, no local stack.** You asked for that
explicitly, so this document is written for it. Section 0 is the honest
accounting of what that costs and what replaces it — read it before section A,
because one step in it is not optional.

---

## 0. What skipping local costs, and what covers it

The local stack was never the only safety net. Most of what it would have
caught, CI already catches on push — against a **real PostgreSQL 17**, not an
in-memory fake. `.github/workflows/ci.yml` runs four jobs, three of which
matter here:

| What could go wrong | What catches it now |
|---|---|
| The migration does not apply | **CI `isolation`** applies every file in `local/postgres/init/*.sql` to a real Postgres 17. Also `deploy.sh`, which runs psql with `ON_ERROR_STOP=1` and **exits before recreating containers** if any file fails — the old code keeps serving. |
| A C# compile error | **CI `backend`** — `dotnet build -c Release`, warnings-as-errors. |
| An ESLint or type error | **CI `frontend`** — `pnpm typecheck`, `pnpm lint`, `pnpm build`. `no-explicit-any` is a build-failing error here; that cost a deploy cycle on 2026-08-17. |
| RLS not actually holding on real rows | **CI `isolation`**, plus the six new Connect assertions from patch 0003 — cross-tenant read, own-tenant read, child-table scoping, no-context, the empty-string trap, and a forged INSERT. |
| **The migration is not idempotent** — fine on a fresh database, fails on the *second* deploy | **Nothing in CI.** CI always starts from an empty database, so it can only ever prove the first run. I closed this by hand: applied the file **twice** against a real PostgreSQL, second run exit 0, and afterwards still 4 policies, 4 forced tables, 3 definer functions. |
| **An EF LINQ query EF cannot translate to SQL** | **Nothing, until the endpoint is first called.** This is the one real residual risk. |

That last row is the whole cost of skipping local, and it is confined to
`GET /api/connect/meetings` — the `mineIds.Contains(m.Id)` and the `switch`
over `range`. Both are ordinary shapes Npgsql handles, but "ordinary" is not
"observed".

**Why that is acceptable here and would not be later:** Connect is not
exposed. `RAIL_PRODUCTS.connect` is still `live: false` and `/connect` is a
coming-soon page, so nothing customer-facing calls these routes. If that
endpoint 500s, it 500s for you, at a URL only you know. The moment the
launcher tile flips to `live: true`, this reasoning expires.

**The one step that is not optional:** push and let CI go green **before** you
deploy. That is what replaces the local rehearsal. Deploying a red commit to
production skips every net at once.

---

## A. On Windows — `C:\Users\amitd\Downloads\tatvaOS`

### A1. Apply patch 0004 — the build is broken until you do

Three files already call `tenant.EnterAnonymousScope(...)`
(`ConnectGuestEndpoints.cs` twice, `ConnectWebhookEndpoints.cs` once) and the
method does not exist yet. That is the `CS1503` you hit, properly fixed:
`TenantContext.Set` takes a non-nullable `Guid` userId, so an anonymous
request cannot use it, and that file's own documentation rejects `Guid.Empty`
as a stand-in. `EnterAnonymousScope` is the honest name for what the guest and
webhook paths actually do — a tenant, no user.

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git apply connect-phase1-0004-anonymous-scope.patch
```

**Confirm** — this must print 1 or more, and printed 0 before the patch:

```powershell
git diff --stat apps/api/Shared/Tenancy/TenantContext.cs
```

Patches `0001`, `0002` and `0003` are already applied — `git status` shows
`Program.cs`, `AppDbContext.cs`, `docker-compose.base.yml`, `livekit.yaml` and
`tests/isolation/test-isolation.sh` modified. Do not apply them twice.

`0001` touches **Core's files**; it arrives as a patch rather than an edit
because they are not our lane's files. Send it to Core with the contract.

`0002` is the wiring nobody would notice until a token failed to mint: the
**API container had no LiveKit credentials**, only the media server did. It
also points LiveKit's webhook at `http://api:8080/api/connect/webhooks/livekit`
inside the compose network.

### A2. Build

```powershell
dotnet build apps/api
pnpm typecheck
```

**Confirm:** both succeed. `dotnet build` is the one that matters — it is the
same check CI's `backend` job runs, so a failure here is a red CI run you can
see thirty seconds earlier.

### A3. Do **not** run the isolation suite locally, and never on production

`tests/isolation/test-isolation.sh` INSERTS rows — its own fixtures plus a
deliberate forged write — and asserts against the two demo tenants from
`02-seed.sql`, which `deploy.sh` **skips on production** precisely so demo data
never reaches a real database. Running it against production would both fail
and litter.

The six new assertions still ship in the commit. **CI runs them**, on a
throwaway Postgres where inserting is free. That is where that proof belongs.

For production there is a different script — read-only, no fixtures — added
below in D2.

### A4. Commit — explicit paths, never `-A`

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git add local/postgres/init/20260901-connect.sql apps/api/Modules/Connect apps/api/Program.cs apps/api/Shared/Data/AppDbContext.cs apps/api/Shared/Tenancy/TenantContext.cs infra/docker/docker-compose.base.yml infra/docker/livekit.yaml infra/scripts/connect-phase1-verify.sh tests/isolation/test-isolation.sh docs/CONNECT_PHASE1_STEPS.md docs/CONNECT_API.md connect-phase1-0001-shared-registration.patch connect-phase1-0002-wire-api-to-livekit.patch connect-phase1-0003-isolation-tests.patch connect-phase1-0004-anonymous-scope.patch
git commit -m "Connect Phase 1: schema, module, token service, endpoints, guest path, webhook"
git push
```

`_to_delete\` is mine, not yours — it holds stale `.git\index.lock` files the
bridge cannot unlink. It is not in the `git add` list. **Delete that folder in
Explorer** whenever you like; nothing depends on it.

If `git add` says `Unable to create '.git/index.lock': File exists`, that is
the same stale-lock problem. Delete `.git\index.lock` in Explorer and re-run.

### A5. Wait for CI — this is the rehearsal

Open the Actions tab. Three jobs must be green before you touch the server:

- **Backend** — the code compiles under Release with warnings-as-errors
- **Frontend** — typecheck, lint, build
- **Tenant isolation** — the migration applies to a real Postgres 17, and all
  assertions including the six new Connect ones pass

`Mail stack` is unrelated to this change; if it is flaky, it is not yours.

**If `Tenant isolation` is red, stop.** That job failing means either the
migration does not apply or a tenant can see another tenant's meetings. Neither
is something to find out on a box holding customer data.

---

## B. On the server — `/srv/tatvaos-production`

SSH in, then:

```bash
cd /srv/tatvaos-production
git pull
bash infra/scripts/connect-phase0-preflight.sh
```

Preflight is read-only and answers the questions that are expensive to answer
after the fact — ports, the `.env` keys, DNS.

### B1. Deploy

```bash
cd /srv/tatvaos-production
./infra/scripts/deploy.sh production
```

Watch for three things in the output:

1. **`Backing up the database`** → `backups/pre-deploy-<stamp>.sql`. If the
   backup fails, `deploy.sh` stops rather than deploying over unbacked data.
2. **`Applying schema`** → a line `OK 20260901-connect.sql`. It runs after
   `20260816-calendar.sql` in the same pass, which is why the
   `calendar_event_id` foreign key resolves even on a database that had never
   seen the calendar schema.
3. **`Starting services`** → LiveKit must be listed as **Recreated**, not
   `Running`. `docker compose up -d` only recreates a container when its
   *definition* changes; the webhook block lives in the mounted
   `livekit.yaml`, and patch 0002 also changed the api service's environment,
   so both should recreate. If LiveKit says `Running`, force it:

   ```bash
   cd /srv/tatvaos-production
   docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env up -d --force-recreate livekit
   ```

**If the schema step fails**, the deploy has already stopped and the old
containers are still serving the old, still-valid schema. Read the psql error
it printed, fix the migration on Windows, push, and run again. Nothing is
half-deployed — that ordering is the point of the script.

---

## C. Verify on the server

```bash
cd /srv/tatvaos-production
bash infra/scripts/connect-phase0-smoke.sh
bash infra/scripts/connect-phase1-verify.sh
```

`connect-phase1-verify.sh` is new and **read-only** — it writes nothing,
creates no fixtures, deletes nothing. It proves the same properties the
isolation suite proves, from the other side: by reading the catalogue for the
policies themselves rather than by inserting rows to bounce off them.

It checks twelve things:

- 4 tables, 3 `SECURITY DEFINER` functions, and both added columns
  (`core.tenants.allow_connect_guests`, `connect.meetings.calendar_event_id`)
- RLS **ENABLE *and* FORCE** on all four tables — a table with ENABLE but not
  FORCE is still fully readable by its owner, which looks identical in every
  other check
- 4 `tenant_isolation` policies, and **all four contain `nullif`** — without it
  an unset tenant sends `''`, a bare `::uuid` cast throws, and the request dies
- the app role sees **zero** meetings with no tenant context, and **zero, not
  an error**, with `app.tenant_id = ''`
- `tatvaos_app` is still `NOBYPASSRLS`
- the api container actually has `LiveKit__ApiKey`
- `livekit.yaml` inside the running container carries the webhook URL
- an unknown code and a malformed code get a **byte-identical** answer from
  `/api/connect/g/...`, and that answer is *ours* — identical-but-generic would
  mean the guest routes never registered

Expected: `12 ok, 0 failed`.

---

## D. Prove it by hand — needs a signed-in session

The verify script cannot fake a JWT, so these are yours:

1. `POST /api/connect/meetings` `{"title":"Test"}` → **201**, a 22-character
   `code`, a `joinUrl`.
2. `POST /api/connect/meetings/{id}/join` → **200** with `token` and `wsUrl`.
   Paste that token at `https://connect.tatvaos.com/connect/dev` — if it joins,
   the API's minting is equivalent to the CLI's, which is the entire purpose of
   `LiveKitTokenService`.
3. `GET /api/connect/meetings?range=upcoming` → **200**. **Run this one
   deliberately.** It is the only query no automated check has exercised, and
   an EF translation failure would surface here as a 500.
4. `GET /api/connect/g/{code}` → **200** with title and state.
5. Guest join with the waiting room on → `{"status":"waiting"}` and a wait
   token; admit from the host side; the wait poll returns a LiveKit token
   **once** and nothing on the second call.
6. Join the room, then:

   ```bash
   cd /srv/tatvaos-production
   docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env exec -T postgres psql -U postgres -d tatvaos_mail -c "SELECT kind, count(*) FROM connect.meeting_events GROUP BY 1 ORDER BY 1"
   ```

   Rows must appear, and **exactly one per event** however many times LiveKit
   retries. If this stays empty the meeting still works, but attendance
   silently does not exist — which is exactly the failure Phase 3 would
   otherwise inherit.

**The check that matters most:** two accounts in two different tenants must not
see each other's meetings anywhere in the API.

### If something is wrong after deploy

The schema is additive-only — new tables, two new nullable columns — so old
code ignores it completely. That makes rolling back the *code* safe on its own;
leave the schema in place.

```bash
cd /srv/tatvaos-production
git log --oneline -5
git checkout <the commit before Phase 1>
./infra/scripts/deploy.sh production
```

---

## E. Frontend — the remaining bulk of Phase 1

### E1. Register the scope — four files, or it breaks quietly

Per brief §6: the `scope` union in `components/shell/AppShell.tsx`,
`Sidebar.tsx` (**and the `logo` ternary just below it** — miss it and Connect
silently wears the Core logo), `Topbar.tsx`, then `lib/nav.tsx` for
`connectNav()` and flipping `RAIL_PRODUCTS.connect` to `live: true`.

These are shared shell files: patch, and tell Core.

### E2. Two things only you can decide

- The **logo pair**: `apps/web/public/brand/connect-logo.png` (mark, 32px) and
  `connect-name.png` (wordmark, dark artwork on transparent, 30px, sits on
  white).
- A **distinct launcher tile colour** — the current `#00b8d9` is the same cyan
  as Family, and tile colour is how people find an app in a grid without
  reading it. Agree it in the same commit that flips `live: true`.

### E3. Build the screens

| Route | Shell | Notes |
|---|---|---|
| `/connect` | AppShell | today + upcoming, join-by-code box, new meeting |
| `/connect/new` | AppShell | schedule form |
| `/connect/meetings/[id]` | AppShell | participants, code, host controls, cancel |
| `/connect/room/[code]` | **none** | full-bleed, own dark surface, **renders with no session** |

Carry the Phase 0 lessons in: video tiles are **flex + aspect-ratio** (YZEN's
`.grid` silently flattens `grid-cols-*`), overlays need `z-[1200]`, a join link
carrying `?code=` needs a `<Suspense>` boundary or the production build fails
while dev passes, and `useSearchParams` is the usual culprit.

Two states Phase 0 proved you need and that silence would ruin:

- **Camera blocked** — a browser denied once stays denied. Say so, and say how
  to fix it. Do not show an empty tile.
- **Someone left** — remove their tile by identity on `ParticipantDisconnected`,
  or a black rectangle reads as "their video broke".

Before committing any frontend file:

```powershell
pnpm --filter @tatvaos/web exec eslint <file>
pnpm typecheck
```

`typecheck` does **not** run lint, and `no-explicit-any` is a build-failing
error here.

### E4. Replace the coming-soon page

`apps/web/app/connect/page.tsx` **is** the launch switch. Delete `/connect/dev`
in the same commit that lands the real room screen — and note that the moment
that commit deploys, section 0's argument for skipping local no longer holds.

---

## F. Two gates that are not mine to clear

1. **Core must review the guest path line by line before it is deployed** —
   brief §8, the same rule Space's public links followed. The files are
   `ConnectGuestEndpoints.cs`, the three `SECURITY DEFINER` functions in the
   migration, and the `connect-guest` limiter in the Program.cs patch.

   The routes ship in this deploy and are reachable, which is deliberate — the
   verify script needs them to prove the no-oracle property, and nothing links
   to them. **They must not be advertised to anyone until Core has read them.**

2. **Six open questions in `docs/CONNECT_API.md` are still open.** You settled
   two (plaintext codes; both Core-table columns in our migration). The rest
   that still bite: what a code-holder learns at the doorstep, whether a wrong
   password may answer 403, polling vs SignalR for the lobby, `meeting_events`
   retention, and the `/rtc` path vs a subdomain.

Also still owed, from the brief: **the capacity estimate before Phase 1 ends.**
The numbers are in `docs/CONNECT_PHASE0.md` — 5 concurrent meetings of 8 people
is roughly 280 Mbps outbound, and monthly transfer, not port speed, is what
becomes a bill.

---

## What "Phase 1 done" means

Not the endpoint count. This, from the brief:

> two people in different cities, on ordinary office wifi, can join a meeting
> from a link, see and hear each other for an hour without a reconnect, and the
> host can mute and remove someone.

Phase 0 proved the media path can carry it. Phase 1 is done when a person who
has never seen a token can do it from `/connect`.

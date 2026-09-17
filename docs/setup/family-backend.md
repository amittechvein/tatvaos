# Bringing up TatvaOS Family

Family is the third product on Core. It adds contacts: the people an
organisation corresponds with, as distinct from the people who work there.
It ships inside the existing API container — there is no new service, no new
database and no new deployment target.

This page is the whole procedure, in order.

---

## What actually changed

Seven files were edited and six added. Nothing outside these paths was touched.

**Added**

| Path | What it is |
|---|---|
| `local/postgres/init/19-family-schema.sql` | Ten tables, ten RLS policies, the search trigger, grants |
| `apps/api/Shared/Data/FamilyEntities.cs` | The ten EF entities |
| `apps/api/Modules/Family/ContactMatching.cs` | Email and phone normalisation — the duplicate rule |
| `apps/api/Modules/Family/ContactAutoSave.cs` | Turns delivered and sent mail into contacts |
| `apps/api/Modules/Family/Endpoints/ContactEndpoints.cs` | The 23 routes under `/api/family` |
| `infra/docker/caddy/conf.d/family.caddy` | The `family.tatvaos.com` front door |
| `tests/isolation/family/family-rls.sql` | Proves a colleague cannot read a personal contact |

**Edited**

| Path | Why |
|---|---|
| `apps/api/Shared/Data/AppDbContext.cs` | DbSets, table mapping, query filters, relationships |
| `apps/api/Shared/Tenancy/TenantConnectionInterceptor.cs` | Now sets `app.user_id` as well as `app.tenant_id` |
| `apps/api/Program.cs` | Registers `ContactAutoSave`, maps the endpoints |
| `apps/api/Workers/MaildirIngestWorker.cs` | Calls auto-save after each ingest batch commits |
| `apps/api/Modules/Mail/Endpoints/MailEndpoints.cs` | Calls auto-save after a Sent copy is filed |
| `infra/docker/docker-compose.base.yml` | Passes `FAMILY_DOMAIN` to Caddy |

### The one change that reaches outside Family

`TenantConnectionInterceptor` previously set `app.tenant_id` on every database
connection. It now sets `app.user_id` too.

This is additive — Core and Mail policies do not read the new setting, so
their behaviour is identical. Family needs it because its boundary is the
**person**, not the organisation: a personal contact has to stay invisible to
a colleague in the same tenant, and tenant id alone cannot express that.

Read that file before you review anything else. It is the one edit that could
affect Mail if it were wrong.

---

## Step 1 — Get the branch

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git status                      # should be on feature/tatvaos-family-backend
git log --oneline -1
```

Everything below runs from that repository root unless stated otherwise.

## Step 2 — Build

```powershell
cd apps\api
dotnet build
```

Expect `Build succeeded`.

## Step 3 — Apply the schema

The local stack runs the `init` directory automatically on a **fresh** volume:

```bash
cd local
docker compose down -v          # -v drops the volume; the init scripts only run on an empty one
docker compose up -d --build    # --build matters — see the troubleshooting section
```

On a database you want to keep, apply the one file instead. It is idempotent —
`IF NOT EXISTS` throughout, `DROP POLICY` before each `CREATE` — so running it
twice is safe:

```bash
docker compose exec -T postgres \
  psql -U postgres -d tatvaos -v ON_ERROR_STOP=1 \
  < ../local/postgres/init/19-family-schema.sql
```

Check what landed:

```bash
docker compose exec postgres psql -U postgres -d tatvaos \
  -c "\dt family.*" -c "SELECT count(*) FROM pg_policies WHERE schemaname='family';"
```

Ten tables, ten policies.

## Step 4 — Run the isolation test

Project rule 3: every endpoint gets an isolation test. This is Family's.

```bash
docker compose exec -T postgres \
  psql -U postgres -d tatvaos -v ON_ERROR_STOP=1 \
  < ../tests/isolation/family/family-rls.sql
```

Expect `NOTICE: family isolation: 7/7 passed`. Anything else is a failure —
the script raises rather than printing, so a non-zero exit is the signal.

It checks seven things: the owner sees her own contacts; a colleague in the
same tenant sees the shared ones and not the personal ones; child rows
(addresses, phones) follow the parent; another tenant sees nothing; a
connection with no context set reads nothing at all; nobody can write a
contact under another person's ownership; and the audit log refuses UPDATE
and DELETE.

All seven pass against PostgreSQL 16 today.

## Step 5 — Smoke the API

```bash
# Sign in as any existing user, then:
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/family/bootstrap
```

Expect counts of zero, an empty group list, and the default settings.

Then create one:

```bash
curl -X POST http://localhost:8080/api/family/contacts \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"displayName":"Test Person","email":"test@example.com"}'
```

## Step 6 — Watch auto-save work

Send a message to a local mailbox and wait for the ingest worker's next pass.
A contact should appear with `source: "auto_received"`.

If it does not, check in this order: the mailbox has a `user_id` (shared
mailboxes are skipped by design — nobody owns their address book); the
person's `auto_save_received` setting is on; and the API log for a warning
from `ContactAutoSave`, which swallows its own errors so that a failure to
save a contact can never bounce a message.

## Step 7 — Production only: the front door

`family.tatvaos.com` needs two things.

DNS: an A record for `family` pointing at the same host as `mail`. No MX
record — Family does not receive mail, which is also why there is no
`FAMILY_HOSTNAME` to match Mail's.

Environment: add one line to `infra/docker/.env`, next to the two it mirrors.

```
SITE_DOMAIN=tatvaos.com            # already there
MAIL_HOSTNAME=mx.tatvaos.com       # already there — Postfix's identity, the MX
MAIL_DOMAIN=mail.tatvaos.com       # already there — the webmail front door
FAMILY_DOMAIN=family.tatvaos.com   # add this
```

Note which of those two Family follows. `MAIL_HOSTNAME` is what Postfix calls
itself in HELO; `MAIL_DOMAIN` is a Caddy site address and nothing else.
`FAMILY_DOMAIN` is the second kind.

`infra/docker/caddy/conf.d/family.caddy` is mounted by the production overlay and
proxies `/api/*` to the API container on that host, so the frontend calls its
own origin and no CORS entry is needed.

**Do not mount that file with `FAMILY_DOMAIN` unset.** Caddy reads an empty
site address, refuses the whole config and exits — every service healthy, the
proxy in a restart loop. This is the failure `mail.caddy` warns about, and it
is the same trap.

Then:

```bash
./infra/scripts/deploy.sh
```

---

## What is not done

Being explicit, because the gap matters more than the list of what works.

**Auto-save from received mail IS verified**, including idempotency across a
restart — see the last section of this page for how, since it needs a
workaround when the API runs natively on Windows.

**No API-level tests.** `tests/isolation/family/family-rls.sql` proves the
database enforces the boundary. It does not prove the endpoints ask the
database the right questions. Every route should get a case that calls it as
one user and asserts a 404 as another.

**Contact merge is not implemented.** The audit log accepts a `merge`
operation and nothing writes one. Duplicates are prevented at creation — the
API refuses a second contact with the same normalised address and tells you
which contact already holds it — but two contacts that turn out to be the same
person cannot be joined yet.

**Demoting an organisational contact back to personal is refused**, with a 409
explaining why. It would have to name an inheriting owner and there is no
right answer to pick.

**Normalisation is Gmail-only.** Dots are folded for gmail.com and
googlemail.com; `+tags` are stripped everywhere. Other providers that ignore
dots will still produce two rows. That is the conservative direction: merging
two real people is worse than keeping two rows for one.

**No rate limiting**, consistent with the rest of the API.

---

## When it does not work on Windows

Three environment problems cost an afternoon on the first run-through, and
none of them were code. All three present as something else, which is why they
are written down.

### `28P01 password authentication failed for user "tatvaos_app"`

**A second PostgreSQL is installed on Windows and holds port 5432.**

The API connects to `localhost:5432` and reaches *that* server, not the
container. Every `ALTER ROLE` you run through `docker exec` goes to the
container and changes nothing the API can see, so the password looks wrong no
matter how many times you reset it.

The confirming detail is two listeners on one port:

```powershell
Get-NetTCPConnection -LocalPort 5432 -State Listen |
    ForEach-Object { Get-Process -Id $_.OwningProcess } |
    Select-Object Id, ProcessName
```

Anything other than a single `com.docker.backend` row is the problem. Stop the
native service from an ELEVATED PowerShell — the version number varies:

```powershell
Get-Service | Where-Object Name -like "postgres*" | Select-Object Name, Status
Stop-Service postgresql-x64-18
Set-Service postgresql-x64-18 -StartupType Manual
```

`Manual` stops it returning after a reboot without uninstalling anything.

Do NOT test the password with `psql -h 127.0.0.1` inside the container to rule
this out. The image's `pg_hba.conf` trusts loopback, so a deliberately wrong
password succeeds and the test proves nothing. Go over the bridge network
instead, which uses the same `scram-sha-256` path the API does:

```powershell
docker run --rm --network tatvaos-mail-local_mailnet -e PGPASSWORD=dev_app_pw `
    postgres:17-alpine psql -U tatvaos_app -h tv-postgres -d tatvaos_mail -c "SELECT current_user;"
```

### `column "department_id" of relation "users" does not exist`

**The volume predates the init script that added it.**

`local/postgres/init/*.sql` runs ONCE, on an empty data directory. A container
created before a script existed never runs it, and stays behind for good.
Adding a file to that directory does nothing to a database that already exists.

```powershell
cd C:\Users\amitd\Downloads\tatvaOS\local
docker compose down -v
docker compose up -d --build
```

`down -v` drops the volume — all local mail and any tenants you created go with
it. The seed data comes back. To keep the data, apply the missing scripts by
hand with `docker compose cp` and `psql -f` instead.

`docker compose` only works from the `local` folder. Run it anywhere else and
you get "no configuration file provided: not found", which is easy to skim past
and leaves you believing a rebuild happened when it did not.

### `Relay access denied`, and `virtual_mailbox_maps` is empty

**The image is stale.** `entrypoint.sh` is COPIED into the image at build time —
only `main.cf`, `master.cf` and `sql/` are bind-mounted. So an entrypoint change
needs a rebuild, and `docker compose up -d` does not rebuild.

The symptom is a Postfix that starts cleanly and rejects every recipient. It is
running Postfix's stock `main.cf` because the render step in the newer
entrypoint never executed, which leaves no virtual domains configured, so every
address looks foreign.

Read the START of the log, not the tail — the render lines are the first thing
printed and their absence is the whole diagnosis:

```powershell
docker logs tv-postfix 2>&1 | Select-Object -First 20
```

Healthy startup says `[postfix] CONTAINED …`, `[postfix] myhostname = …` and
`[postfix] rendered 5 SQL lookup files`. Missing means stale image:

```powershell
cd C:\Users\amitd\Downloads\tatvaOS\local
docker compose up -d --build
docker exec tv-postfix postconf virtual_mailbox_maps
```

That last line must print a `pgsql:` path, not nothing.

**Always `up -d --build`.** The README says so; plain `up -d` is how a
four-day-old image survives a rebuild you thought you did.

---

## Verifying auto-save without a containerised API

The local stack has no `api` service, so the API runs natively on Windows —
where `/var/mail/vhosts` does not exist and the maildir worker sits idle,
logging `Vmail root /var/mail/vhosts does not exist; ingest idle`.

The worker only reads files, and its root is configurable, so point it at a
copy:

```powershell
# 1. deliver a message from an OUTSIDE address to a seeded mailbox
Send-MailMessage -SmtpServer localhost -Port 2525 `
    -From "priya.raman@example.com" -To "amit@techvein.local" `
    -Subject "Auto-save test" -Body "testing"

# 2. confirm Dovecot wrote it
docker exec tv-dovecot find /var/mail/vhosts -type f -path "*new*"

# 3. copy the tree out
docker cp tv-dovecot:/var/mail/vhosts C:\temp\vhosts

# 4. restart the API with the worker pointed at it
$env:Mail__VmailRoot = "C:\temp\vhosts"
dotnet run
```

Seeded mailboxes are `amit@` and `hr@` on techvein.local, and `principal@` on
abcschool.local. Anything else bounces.

Check the result as `postgres`, not through the API — the contact belongs to
Amit personally and RLS correctly hides it from everyone else:

```powershell
docker exec tv-postgres psql -U postgres -d tatvaos_mail -c "SELECT display_name, source, interaction_count FROM family.contacts;"
```

`Priya Raman | auto_received | 1`. The name is derived from the address by
`ContactMatching.DisplayNameFromEmail`.

**Then restart the API and check again.** The count must still be 1. The worker
re-reads the same maildir on every start, so this is the case that matters, and
`family.contact_sources` is what prevents the double count. Verified working —
but re-check it after any change to `ContactAutoSave`.

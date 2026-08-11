# Family — going live

The backend is ALREADY on production, deployed 10 August and verified there.
"Going live" means shipping the UI and turning Family on for real users.

Companion documents: `docs/setup/family-backend.md` (setup and the environment
traps), `docs/FAMILY_API.md` (the API), `docs/FAMILY_BACKLOG.md` (what is left).

---

## What is in v1

Contacts list with search, filters and paging. Directory, Frequent, Other
contacts, Bin. Create, edit, delete, restore. Emails and phones. Labels.
Interaction history. Audit trail. Auto-save from mail with no-reply filtering.
Per-person auto-save settings.

## What is NOT, and should not be forced in

Merge. Import and export. Contact photos. The dates UI. The Mail composer
wiring. Every one of these is either unstarted or written-but-uncompiled, and
each is a way for the deploy to fail at something that is not the point.

Ship the tested thing. `FAMILY_BACKLOG.md` has the order for the rest.

---

## Gate 1 — it compiles

```powershell
cd C:\Users\amitd\Downloads\tatvaOS\apps\web
npx tsc --noEmit

cd ..\api
dotnet build
```

**Pass:** both silent / `Build succeeded`.

The frontend has never been typechecked — `next dev --turbopack` does not do it,
so "Compiled" in the dev server is not this. The API has not been built since
the no-reply filter, the list filters and the restore endpoint were written.

**This gate decides whether today is the day.** If the frontend errors run deep,
slip. Production is serving fine and nothing is forcing the date.

## Gate 2 — the database still isolates

```powershell
cd ..\..\local
docker compose up -d --build
docker compose cp ..\local\postgres\init\19-family-schema.sql postgres:/tmp/19.sql
docker compose cp ..\local\postgres\init\20-family-dates.sql  postgres:/tmp/20.sql
docker compose exec postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1 -f /tmp/19.sql
docker compose exec postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1 -f /tmp/20.sql

docker compose cp ..\tests\isolation\family\family-rls.sql postgres:/tmp/rls.sql
docker compose exec postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1 -f /tmp/rls.sql
```

**Pass:** `NOTICE: family isolation: 8/8 passed`.

`--build` is not optional. A stale image is what silently broke Postfix for
days — see the troubleshooting section of `family-backend.md`.

## Gate 3 — the API answers

Start the API (four env vars, see `family-backend.md` step 7), then:

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
.\tests\isolation\family\smoke-family.ps1 -Email admin@techvein.in -Password "SmokeTestPassword123"
```

**Pass:** 26/26.

## Gate 4 — a human clicks it

`npm run dev` in `apps/web`, then walk every rail item:

| Route | Expect |
|---|---|
| `/family/contacts` | Family lockup in the rail, list renders, count in sidebar |
| `/family/directory` | Organisational only |
| `/family/frequent` | Ordered by exchanges, not name |
| `/family/other` | Auto-saved only |
| `/family/bin` | Deleted rows, each with Restore, and Restore works |
| `/family/labels` | Create a label, see it appear in the rail |
| `/family/settings` | Three switches, save sticks |
| Create contact | Dialog opens, URL tidies |
| Duplicate address | 409 offering to open the existing contact |

Then the no-reply filter, which has never been exercised:

```powershell
Send-MailMessage -SmtpServer localhost -Port 2525 -From "noreply@example.com" -To "amit@techvein.local" -Subject "Robot" -Body "x"
Send-MailMessage -SmtpServer localhost -Port 2525 -From "accounts@supplier.com" -To "amit@techvein.local" -Subject "Human" -Body "x"
```

Copy the maildir to `C:\temp\vhosts`, restart the API with `Mail__VmailRoot`,
then check `family.contacts`. **Pass:** Accounts saved, noreply absent.

---

## Deploy

Only with all four gates green.

```powershell
git add -A
git commit -m "Family: contacts UI, no-reply filtering, dates schema"
git push
git checkout main
git merge --ff-only feature/tatvaos-family-backend
git push
```

On the server:

```bash
cd /srv/tatvaos-production
git checkout main && git pull
./infra/scripts/deploy.sh production
```

`FAMILY_DOMAIN=family.tatvaos.com` is already in `infra/docker/.env` and DNS
already resolves. `deploy.sh` backs the database up before it touches anything.

## Verify live

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://family.tatvaos.com/api/family/contacts   # 401
curl -s -o /dev/null -w "%{http_code}\n" https://core.tatvaos.com/api/family/contacts     # 401
curl -s https://core.tatvaos.com/health                                                   # ok
curl -s -o /dev/null -w "%{http_code}\n" https://mail.tatvaos.com                         # 200
```

Check Mail and Core too, not just Family. The Caddy config is shared — a bad
`family.caddy` takes all three down, which you want to learn from curl and not
from a customer.

Then sign in at `family.tatvaos.com` and repeat the Gate 4 walk against
production.

## Rollback

```bash
cd /srv/tatvaos-production
git checkout <previous-sha>
./infra/scripts/deploy.sh production
```

The Family schema can stay. It is additive, in its own namespace, and nothing
in Core or Mail reads it — leaving the tables in place while the code is rolled
back is harmless and saves a restore.

Database backups are in `backups/pre-deploy-*.sql`.

---

## First 48 hours

Watch three things.

**Auto-save quality.** The one that will decide whether people keep the
feature on:

```sql
SELECT source, count(*) FROM family.contacts GROUP BY source;
SELECT display_name, c.created_at FROM family.contacts c
 WHERE source LIKE 'auto_%' ORDER BY created_at DESC LIMIT 30;
```

If robots are still getting through, extend `ContactMatching.IsNoReply` — and
consider the `is_bulk` column described in `FAMILY_BACKLOG.md`, which catches
mailing lists sending from ordinary-looking addresses.

**Duplicates.** They will accumulate and there is still no merge:

```sql
SELECT email_normalised, count(*) FROM family.contact_emails
 GROUP BY 1 HAVING count(*) > 1;
```

**Errors:**

```bash
docker compose -f infra/docker/docker-compose.base.yml \
  -f infra/docker/docker-compose.production.yml \
  --env-file infra/docker/.env logs api --tail 200 | grep -i "family\|contact"
```

`ContactAutoSave` swallows its own exceptions by design — a failed contact save
must never bounce a message — so its failures appear only as warnings. Grep for
them deliberately; they will not announce themselves.

---

## v1.1, in order

From `FAMILY_BACKLOG.md`, unchanged: the departure bug (a hard-deleted user
currently takes their whole address book with them), merge, the Mail wiring,
address endpoints, the dates UI, import and export.

The departure bug is first because it is a data-loss defect, not a feature.

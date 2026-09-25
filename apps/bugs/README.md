# TatvaOS Bugs — bug.tatvaos.com

Techvein's internal tracker for TatvaOS bugs and feature requests
(requirement document v1.1, 25 Sept 2026). **Not part of the product**: its own
container, its own SQLite file, no npm dependencies, sign-in through
"Sign in with TatvaOS" (a *public* OIDC client with PKCE, so no secret exists).

## What it does

- One TatvaOS account, any mix of **Admin / Developer / Tester**; "Working as"
  switches mode, and every history entry records the mode it was done in.
- Modules → sub-modules (admin). Delete only when no report uses it; otherwise
  deactivate. Reports keep their module.
- Report: module → its active sub-modules → Bug/Feature → title, details,
  priority, attachments (up to 100 MB; type taken from the file's bytes).
- Status flow: Pending → Under Review → More Information Required → Under
  Development → Fixed → Closed, and Fixed → Reopened → Under Development.
  Developers move issues assigned to them; the reporting tester closes or
  reopens; admins can do both, and can close without a fix *with a reason*.
- History is append-only **in the database** (triggers refuse UPDATE/DELETE).
- Dashboards per mode, filters, CSV export, reports by type, developer, tester,
  module/sub-module and priority.
- Email through the TatvaOS send API (key pasted in Settings by an admin):
  immediate mails to reporter + assignee (+ admins for new/reopened), daily
  summaries at 09:00 IST.

## Run and test locally

    node apps/bugs/test/flow.mjs          # 72 checks, throwaway database

    set PORT=3190& set DEV_LOGIN=1& set PUBLIC_URL=http://localhost:3190& set BOOTSTRAP_ADMIN_EMAILS=you@techvein.com& set OIDC_CLIENT_ID=local& node apps/bugs/src/server.mjs
    # then open http://localhost:3190/auth/dev?email=you@techvein.com

`DEV_LOGIN` works only with a loopback `PUBLIC_URL` **and** a loopback caller.

## Production

`~/tatvaos-bugs` (deploy user) on the server, its own compose project
(`deploy/docker-compose.yml`), joined to the product's Caddy network. Caddy
fragment: `infra/docker/caddy/conf.d/bug.caddy` (tracked, so deploy.sh keeps it).
Data: docker volume `tatvaos-bugs_bugsdata` (`bugs.db` + `files/`). **Backed up every 6 h**
by `deploy/backup-bugs.sh` (encrypted, read back, uploaded to the product bucket under `bugs/`, 7 days); restore proof: `deploy/restore-drill.sh`.

## Deploying (Mr. Singh, PR 301 condition 4)

A second route by which code reaches the production server, so it shares the
product's deploy lock. **Every run needs Amit's go.**

1. From the laptop, folder `tatvaos-bugs`, upload to a staging folder (nothing
   live changes):

       (cd apps/bugs && tar --exclude=.data -czf - .) | ssh deploy@<server> 'rm -rf ~/tatvaos-bugs-incoming && mkdir ~/tatvaos-bugs-incoming && tar -xzf - -C ~/tatvaos-bugs-incoming'

2. Run the deploy from the staging folder:

       ssh deploy@<server> 'bash ~/tatvaos-bugs-incoming/deploy/deploy-bugs.sh < /dev/null'

   It takes `/tmp/tatvaos-deploy-production.lock` (the same `flock` as
   `infra/scripts/deploy.sh`) and holds it through build and restart, so the two
   can never overlap; it refuses if the lock is held or a `deploy.sh` is running.
   It keeps `deploy/.env` and the data volume, tags the running image
   `:previous`, waits for healthy, and fails if any row count goes down.

Rollback: `docker tag tatvaos-bugs-bugs:previous tatvaos-bugs-bugs:latest`, then
`docker compose up -d --no-build` in `~/tatvaos-bugs/deploy`.

## Storage and privacy (condition 2)

All uploads together are capped by `BUGS_STORAGE_LIMIT_MB` (default 2048); a
full budget refuses new files with a message, reports still work. Usage shows in
Settings, and `deploy.sh` prints the volume size on every product deploy. The
report and comment forms say: do not upload screenshots or recordings that show
real customers' mail or personal data.

## Mail key (condition 3)

The key in Settings must be the tracker's own, allowed to send only as the
tracker's address — never a key another system uses.

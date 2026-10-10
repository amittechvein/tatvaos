# Google migration: from merged to switched on

**For the session that holds production deploys, after Amit's explicit go.**
Nothing here is done by the developer who built it, and nothing here starts
before Mr. Singh has ruled on decision 0019 and reviewed PRs 417-431 (and
the completions PR). House rules 2, 3, 5, 6, 11 and 11b apply to every step.

Every part of the migration ships **off**. Merging and deploying changes
nothing a customer can see except one new console page that says the server
has no Google key yet. Switching on is three separate, reversible steps
below, each proved before the next.

---

## 0. Before merging

1. Mr. Singh's rulings on decision 0019 §1-§4 recorded in
   `docs/decisions/0019-google-migration-switch-on.md` (status → accepted).
2. Reviews in stack order: **417, 418 → 420 → 421 → 423 → 424 → 426 → 427 →
   428 → 431 → completions**. Each merged with `gh pr merge --merge` once its
   CI is green on the exact commit, rebased onto `origin/main` first
   (rule 11: "if main moved while you waited, rebase again").
3. The new CI steps run on every PR: `tests/tenant-filters`,
   `tests/google-client`, `tests/migration-fit`.

## 1. Deploy (the migration still off)

Through the **Deploy production** workflow only (rule 11). Before it:

```bash
infra/scripts/verify-migrations.sh
```

The deploy applies `20261009-migration-jobs.sql` and
`20261009-z-migration-grants.sql` (additive; re-runnable). It recreates the
Dovecot container with the new master passdb, whose file `entrypoint.sh`
creates **empty** - off. Paste the deploy's `DEPLOY VERDICT` line.

**Prove it is off** (from the server):

```bash
infra/scripts/migration-master.sh status
```

Expect `migration master login: off`. And in the console, `/org/migration`
says "Not available on this server yet".

## 2. TatvaOS's Google key (decision 0019 §1)

1. In Google Cloud, a service account for TatvaOS (one, for all customers).
   A JSON key for it. Never pasted into any chat or terminal output.
2. On the server, written straight to its place (rule 5):
   `/srv/tatvaos-secrets/google/key.json`, owner the API's uid (5000),
   mode 600. **Not** in `infra/docker/.env`, which `backup.sh` copies.
3. In `infra/docker/.env`: `MIGRATION_GOOGLE_KEY_FILE=/run/google/key.json`
   (a path, not a secret). Recreate the API container (rule 4: a variable
   added after a container is created is invisible inside it).
4. **Prove it**: `/org/migration` now shows TatvaOS's client ID and six
   read-only scopes. The API log says `Google service account loaded: <address>`.

## 3. The mailbox sign-in (decision 0019 §2)

Only for an organisation that is about to migrate mail; off again after.
The names below assume compose project `tatvaos` (as `tatvaos-web-1` in
HOUSE_RULES); confirm with `docker ps` and `docker network ls` first.

```bash
docker network inspect tatvaos_mailnet -f '{{(index .IPAM.Config 0).Subnet}}'
```

```bash
DOVECOT_CONTAINER=tatvaos-dovecot-1 MIGRATION_MASTER_NETS=<that subnet> infra/scripts/migration-master.sh on
```

**Prove the fence from OUTSIDE the server** (a laptop): an IMAP login as
`anyone@theirdomain*migration` with any password must be refused. If it is
refused only for a wrong password and not for the network, Docker's proxy is
presenting outside connections from inside the allowed range - see the
script's header - and only the password is protecting it: stop and fix the
range before going on.

## 4. The runner

`Migration__Runner=on` for the API (in `infra/docker/.env`, recreate the
container). Its log says `Migration job runner on, as <owner>`.

## 5. The first customer: Techvein, one person

In `/org/migration`, as Techvein's owner:
1. Google admin console: authorise the client ID with the six scopes shown.
2. "I've authorised it - check" (it lists the directory before recording).
3. **Measure.** The verdict must be "It fits" on the production disk; if it
   refuses, the shortfall is the Block Storage to add (decision 0019 §4).
4. "Add everyone from Google". Read the not-matched list.
5. Select **one** person. Start. Watch their row reach `completed`.
6. Check with that person: mail in the right folders, contacts, calendar,
   Drive under "Google Drive". Then the next few, then everyone.
7. Before the MX switch, and once after: **Bring new mail**.

## Switching off, at any step

```bash
infra/scripts/migration-master.sh off
```

Also: `Migration__Runner=off` (recreate the API), and "Remove access" in
`/org/migration`, which cancels unfinished jobs and tells the admin to delete
the delegation entry in Google's Admin console. Deleting the key file stops
all Google access for every organisation at once.

## What this does not do

Google Docs, Sheets and Slides are skipped and counted (phase 5, a separate
decision). Rollback restores code, not schema: the migration tables stay,
empty or not, which is harmless (rule 2).

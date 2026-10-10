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

**Prove the size estimate sees one disk, not two** (Mr. Singh on #450).
The estimate decides whether the mail store and Space share a filesystem by
the **device id** of the mount holding each path, read inside the API
container - not by mount point, because inside the container every Docker
volume is its own mount point, and one disk judged as two would permit a
migration that overfills it. From the server:

```bash
docker exec tatvaos-api-1 sh -c 'cat /proc/self/mountinfo' | awk '$5=="/var/mail/vhosts"||$5=="/var/lib/space/blobs"{print $3, $5}'
```

Expect two lines with the **same** `major:minor`. On 10 Oct 2026 (one disk,
`/dev/sda`) it printed:

```
8:0 /var/mail/vhosts
8:0 /var/lib/space/blobs
```

If the ids differ while `df` on the host shows one disk, **stop**: that is
the exact condition under which the estimate would permit a migration that
does not fit. (When Block Storage is attached later, a different id for one
of them is the correct answer, and the estimate then checks each disk on
its own.)

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
5. **Prove it is in no backup** (decision 0019 §1: the key must never travel
   with the data). `backup.sh` dumps Postgres, archives exactly the volumes
   `spaceblobs`, `vmail` and `dkimkeys` (and `connectrec` off-box), and
   copies `infra/docker/.env` as `env.txt`. It never reads
   `/srv/tatvaos-secrets`, and the new `tatvaos_migration-master` volume is
   not on its list either. Show it on the newest backup, from the server:

   ```bash
   B=/srv/backups/tatvaos; N=$(ls -1t "$B" | grep -E '^[0-9]' | head -1); echo "$N"; ls "$B/$N"
   for t in "$B/$N"/*.tar.gz; do echo "$(basename "$t"): $(tar tzf "$t" | grep -c tatvaos-secrets) member(s) under tatvaos-secrets"; done
   echo "env.txt: $(grep -c tatvaos-secrets "$B/$N/env.txt") line(s) naming tatvaos-secrets"
   ```

   Expect the listing to show only `dkimkeys.tar.gz`, `env.txt`,
   `postgres.sql.gz`, `spaceblobs.tar.gz`, `vmail.tar.gz`, and every count
   to be `0`. On 10 Oct 2026 (backup `20261010-103001`, 35,196 archive
   members) every count was 0. Run it again after the key is in place; a
   non-zero count means the key is in a backup and the switch stops.

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

The password itself lives in the `tatvaos_migration-master` volume
(`/etc/dovecot/migration/` in Dovecot, `/run/migration/` read-only in the
API). `backup.sh` does not archive that volume, so the password is in no
backup; and `migration-master.sh off` empties it.

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

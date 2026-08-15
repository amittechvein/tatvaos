# Backup and restore

A backup nobody has restored is a rumour. This is the whole of it: what is
taken, how to put it back, and what is deliberately not covered.

## What is backed up

`infra/scripts/backup.sh`, nightly at 02:30 once installed:

| artefact | why losing it hurts |
|---|---|
| `postgres.sql.gz` | every tenant, user, message header, file row, grant |
| `spaceblobs.tar.gz` | **the actual file bytes** — the database only holds opaque blob keys |
| `vmail.tar.gz` | the actual mail |
| `dkimkeys.tar.gz` | small; losing them means re-publishing DNS for every customer domain |
| `env.txt` | the uncommitted secrets, without which none of the above starts |

Kept 14 days locally (`BACKUP_KEEP_DAYS`), plus an off-box copy when
`BACKUP_REMOTE` is set.

## Install

```bash
cd /srv/tatvaos-production
./infra/scripts/backup.sh              # run once by hand, read the output
./infra/scripts/backup.sh --install    # nightly cron at 02:30
```

The cron logs to `$BACKUP_DIR/backup.log`, deliberately not `/var/log` — the
deploy user cannot create a file there, and cron would fail on the redirect
before the script ever ran. Check it the morning after installing: an empty
or missing log means the job never fired.

Set the off-box target before trusting any of it:

```bash
# in the crontab line, or /etc/environment
BACKUP_REMOTE=user@backup-host:/backups/tatvaos
```

Without it the script warns on every run, and correctly: a backup living on
the machine it protects does not survive losing that machine.

## Restore

Stop the app first — restoring underneath a running API produces rows that
disagree with the bytes.

```bash
cd /srv/tatvaos-production
COMPOSE="docker compose -f infra/docker/docker-compose.base.yml \
  -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env"
SET=/srv/backups/tatvaos/20260815-023000     # the set you are restoring

$COMPOSE stop api web postfix dovecot
```

**Database**

```bash
gunzip -c "$SET/postgres.sql.gz" | \
  $COMPOSE exec -T postgres psql -U postgres -d postgres
```

`pg_dumpall` output includes the `DROP`/`CREATE` for each database, so this
replaces what is there. Restoring into a *fresh* box instead: bring up only
postgres, restore, then deploy normally — `deploy.sh` applies schema before
starting the app, so migrations land on the restored data in the right order.

**Volumes** — one at a time, and only the one you need:

```bash
restore_volume() {   # restore_volume <tarball> <volume>
  docker run --rm -v "$2:/dst" -v "$SET:/in:ro" alpine \
    sh -c "rm -rf /dst/* /dst/..?* /dst/.[!.]* 2>/dev/null; tar xzf /in/$1 -C /dst"
}
restore_volume spaceblobs.tar.gz tatvaos_spaceblobs
restore_volume vmail.tar.gz      tatvaos_vmail
restore_volume dkimkeys.tar.gz   tatvaos_dkimkeys

# ownership matters: both containers run as 5000
docker run --rm -v tatvaos_spaceblobs:/b alpine chown -R 5000:5000 /b
docker run --rm -v tatvaos_vmail:/b      alpine chown -R 5000:5000 /b
```

Then bring it back:

```bash
$COMPOSE up -d
```

**Restore the database and the blobs from the SAME set.** A newer database
with older blobs means file rows pointing at blob keys that do not exist —
Space will 404 files it swears exist.

## Verifying a restore

1. Sign in.
2. Open a mail with an attachment — proves maildir and the database agree.
3. Download a file in Space — proves `spaceblobs` and the file rows agree.
4. `dig +short tv2026a._domainkey.<domain> TXT` still matches the key on disk
   (see `01-mail-edge-config-errors.md` for the comparison command).

## Not covered

- **Point-in-time recovery.** These are nightly snapshots; up to 24 hours can
  be lost. WAL archiving is the upgrade when that stops being acceptable.
- **Off-site by default.** `BACKUP_REMOTE` is opt-in and unset means local
  only.
- **Restore drills.** Nobody has practised this on a spare box yet. Until
  somebody has, treat every step above as untested.

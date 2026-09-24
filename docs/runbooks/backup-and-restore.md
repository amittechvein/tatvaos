# Backup and restore

A backup nobody has restored is a rumour.

**This one has been restored.** On 9 September 2026 the newest off-box object
was downloaded, decrypted with the passphrase *from the paper copy*, and
replayed into a clean PostgreSQL 17 container. Every row count matched
production and every file came back. What that drill did and did not prove is
at the bottom of this document — read it before you rely on this in anger.

## The passphrase — read this first

The off-box backup is encrypted. Without the passphrase it is 600 MB of noise.

It lives in **two** places:

1. `/srv/backups/tatvaos/.backup-env` on the production server, as
   `BACKUP_ENC_PASSPHRASE`.
2. **On paper, with Amit.**

In the disaster this backup exists for — the server is gone — copy 1 is gone
with it. **Copy 2 is the one that matters, and phoning Amit is step zero of any
real restore.** The paper copy was verified against a live object on 9 Sept
2026; it works.

## What is backed up

`infra/scripts/backup.sh`, **every six hours** (02:30, 08:30, 14:30, 20:30):

| artefact | why losing it hurts |
|---|---|
| `postgres.sql.gz` | every tenant, user, message header, file row, grant |
| `spaceblobs.tar.gz` | **the actual file bytes** — the database only holds opaque blob keys |
| `vmail.tar.gz` | the actual mail |
| `dkimkeys.tar.gz` | small; losing them means re-publishing DNS for every customer domain |
| `env.txt` | the uncommitted secrets, without which none of the above starts |

So up to **six hours** can be lost, not twenty-four.

## Where the copies live

**Local** — `/srv/backups/tatvaos/<stamp>/`, kept `BACKUP_KEEP_DAYS` days:
the script's default is 14, and **production sets 3** (measured 24 Sept
2026). Unencrypted. Fine for "someone deleted a mailbox", useless for "the server is
gone". The directory is mode 700: the sets contain the whole database and
everyone's mail in the clear.

**Off-box** — object storage via rclone, AES-256, one object per set:
`${BACKUP_S3_REMOTE}/<stamp>.tar.gz.enc`. **This is the real off-box path.**
Configured in `/srv/backups/tatvaos/.backup-env`:

```bash
BACKUP_S3_REMOTE='linode:tatvaos-backups'
BACKUP_ENC_PASSPHRASE='...'                # also on paper, offline
BACKUP_S3_KEEP_DAYS=7                      # production's real value
BACKUP_KEEP_DAYS=3                         # local sets AND pre-deploy copies
```

**Off-box copies are kept 7 days, not 30.** This page said 30 until 24 Sept
2026; the server's own config says 7, and the server is what happens. Measure
it (`BACKUP_S3_KEEP_DAYS` only — never print the file) before quoting a
number to anyone.

**Pre-deploy copies** — `/srv/tatvaos-production/backups/pre-deploy-<stamp>.sql.gz.enc`,
one per deploy, written by `deploy.sh` before it touches anything (PR 254,
Mr. Singh's ruling of 25 Sept 2026):

- **Encrypted** with the same scheme and the same `BACKUP_ENC_PASSPHRASE` as
  the off-box objects. On production a missing passphrase **stops the
  deploy** — it will not write a plain copy.
- **Locked down**: directory 700, each file 600, created that way.
- **Kept by days, the same `BACKUP_KEEP_DAYS` as the local sets** — one
  number. With production's 3, a pre-deploy copy older than 3 days is gone;
  anything older comes from the off-box objects (7 days).
- **Checked whole** before the deploy carries on: decrypted, gunzipped, and
  checked for `pg_dumpall`'s end-of-dump marker.

Restore one (it is a whole-cluster `pg_dumpall`; restore into a scratch
container first unless the live database is already lost):

```bash
set -a; . /srv/backups/tatvaos/.backup-env; set +a
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE \
    -in backups/pre-deploy-<stamp>.sql.gz.enc | gunzip | psql -U postgres
```

**The old plain copies** (`pre-deploy-*.sql`, `pre-deploy-*.sql.gz`, 323 of
them, 31 GB, 4 Aug to 24 Sept 2026) are **never deleted by a deploy**; each
deploy counts them aloud. They were chmod-ed 700/600 by hand on 25 Sept. Mr.
Singh's order for removing them: (a) prove a restore into a scratch database;
(b) PR 254 live; (c) one explicit deletion run by a person, logged with the
count, the date range and who authorised it.

**`BACKUP_REMOTE` is the legacy rsync hook and is deprecated.** The script
labels it `Off-box copy — rsync (legacy hook)` and it copies *unencrypted*.
Do not configure it. When it is unset the script prints, correctly:

```
BACKUP_REMOTE not set — fine, the object-storage copy above is the off-box path.
```

That is a note, not a warning. Nothing is wrong.

## Install

```bash
cd /srv/tatvaos-production
./infra/scripts/backup.sh              # run once by hand, read the output
./infra/scripts/backup.sh --install    # cron
```

The cron logs to `$BACKUP_DIR/backup.log`, deliberately not `/var/log` — the
deploy user cannot create a file there, and cron would fail on the redirect
before the script ever ran. Check it the morning after installing: an empty or
missing log means the job never fired.

## The monthly check — two minutes

```bash
bash infra/scripts/verify-backup-restore.sh
```

Downloads the newest object, decrypts it, reads the tar's table of contents,
and confirms all five artefacts are present. Nothing is extracted; the running
system is not touched.

**Once a quarter, run it after typing the passphrase from the PAPER copy**
rather than letting it read the config file. The paper is the copy that matters
on the day the machine is gone, and a paper copy nobody has tested is a rumour
in exactly the way this document's first line means.

## Restore

Two starting points. Pick the one that matches your disaster.

### A — the box is fine, you need an older set

The local sets are already on disk and already decrypted.

```bash
SET=/srv/backups/tatvaos/20260909-083001    # the set you are restoring
```

Skip to **Putting it back**.

### B — the box is gone, you have the object

```bash
export PATH="$HOME/bin:$PATH"              # rclone lives in ~/bin
set -a; . /srv/backups/tatvaos/.backup-env; set +a

# Use the PAPER passphrase, typed — not echoed, not in shell history.
unset BACKUP_ENC_PASSPHRASE
read -rsp 'Passphrase from the PAPER copy: ' PAPER_PASS; echo
export PAPER_PASS

# Somewhere you can write. NOT /srv/backups — that is root-owned and the
# deploy user cannot create directories in it.
WORK="$HOME/restore-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"

LATEST=$(rclone lsf --files-only "$BACKUP_S3_REMOTE" | sort | tail -1)
rclone cat "$BACKUP_S3_REMOTE/$LATEST" \
  | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:PAPER_PASS \
  | tar xzf - -C "$WORK"
echo "want 0 0 0: ${PIPESTATUS[@]}"

SET="$WORK/$(basename "$LATEST" .tar.gz.enc)"
ls -la "$SET"
```

`0 0 0` means rclone, openssl and tar all succeeded. Anything else: a non-zero
in the **second** position is the passphrase or a corrupted object — try the
config-file passphrase to tell those apart. Non-zero in the **first** is
credentials or network, which is a different problem.

**`-pbkdf2 -iter 200000` must match what wrote the object.** They are not
openssl's defaults. Omit them and the decrypt fails with `bad decrypt`.

### Putting it back

Stop the app first — restoring underneath a running API produces rows that
disagree with the bytes.

```bash
cd /srv/tatvaos-production
COMPOSE="docker compose -f infra/docker/docker-compose.base.yml \
  -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env"

$COMPOSE stop api web postfix dovecot
```

**Database**

```bash
gunzip -c "$SET/postgres.sql.gz" | \
  $COMPOSE exec -T postgres psql -U postgres -d postgres
```

`ERROR: role "postgres" already exists` is expected and harmless — `pg_dumpall`
recreates the superuser the server already has. Any other `ERROR` is not.

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

**Restore the database and the blobs from the SAME set.** A newer database with
older blobs means file rows pointing at blob keys that do not exist — Space
will 404 files it swears exist.

## Clean up — this is a numbered step, not housekeeping

**The restore wrote every production secret to disk in plaintext.** `env.txt`
is in the extracted set. On a rebuilt box that file will sit there
indefinitely, and nobody who follows the steps above is told they created it.

```bash
find "$WORK" -name env.txt -exec shred -u {} \;
rm -rf "$WORK"
unset PAPER_PASS

# The sweep, not the memory. Deleting "the directory I created" misses the one
# from the attempt that failed — which is exactly what happened during the
# 9 Sept drill, twenty minutes after this risk was written down.
find "$HOME" /tmp -name env.txt 2>/dev/null | grep . && echo "STILL THERE" || echo "clean"
```

Hits under `/srv/backups/tatvaos/` are the backup sets themselves and are meant
to be there; they are mode 600 inside a 700 directory.

## Verifying a restore

1. Sign in.
2. Open a mail with an attachment — proves maildir and the database agree.
3. Download a file in Space — proves `spaceblobs` and the file rows agree.
4. `dig +short tv2026a._domainkey.<domain> TXT` still matches the key on disk
   (see `01-mail-edge-config-errors.md` for the comparison command).

## What the 9 September 2026 drill proved

Object `20260909-083001.tar.gz.enc`, 595.868 MiB, restored into a throwaway
`postgres:17-alpine` container and a throwaway volume. Production untouched.

| | |
|---|---|
| paper passphrase decrypts the object | yes — `0 0 0` |
| all five artefacts present | yes |
| dump replays into a clean Postgres 17 | `psql exit: 0`; one benign `role "postgres" already exists` |
| tenants / users / domains / products / mailboxes | 4 / 20 / 5 / 7 / 22 — identical to production |
| spaceblobs | 17 files restored, 17 in production |

**What it did not prove.** The drill ran on the production host, so it does not
cover a bare machine: installing Docker, restoring DNS, obtaining certificates,
or bringing the mail edge up cold. It did not restore `vmail` or `dkimkeys`
into live volumes, and it did not test `deploy.sh` against a restored database.
Those remain untested, and this section is where to record it when somebody
tests them.

## Not covered

- **Point-in-time recovery.** These are six-hourly snapshots; up to six hours
  can be lost. WAL archiving is the upgrade when that stops being acceptable.
- **Rotation and old secrets.** A rotated credential survives in local sets and
  pre-deploy copies for `BACKUP_KEEP_DAYS` and in off-box objects for
  `BACKUP_S3_KEEP_DAYS`. **Changing `BACKUP_ENC_PASSPHRASE` does not re-encrypt
  anything already written** — keep the old one until the last copy made with
  it has aged out of every window. Rotation is not
  finished when the new secret is live; it is finished when the old one is out
  of reach.
- **Restoring onto a bare machine.** See the drill section above.

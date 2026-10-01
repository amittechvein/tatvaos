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

## Keys that must never change

Some keys in `infra/docker/.env` are not just secrets. **The data depends on
their exact value**, so a restore with a *new* value does not fail loudly; it
quietly breaks a rule. Restore these from `env.txt` in the backup set (or the
paper copy); **never generate a fresh one on a server that has data.**

| key | what it decides | if it changes |
|---|---|---|
| `PERSONAL_PHONE_HASH_KEY` | the fingerprint of every personal account's phone number: one personal account and one AI trial per number, ever (PR 311) | **every phone can sign up again**, with a second account and a second free trial; nothing errors |
| `JWT_SIGNING_KEY` (the sign-in key) | signs sign-in tokens **and**, until the keys are separated, is the key stored MFA secrets and sealed secret settings are encrypted with: the Razorpay key secret and webhook secret (billing, PR 320/322), the Infobip password, the MSG91 auth key, the Google OAuth client secret | everyone is signed out, which is expected - **and every stored MFA secret and every sealed secret setting becomes unreadable at once**: people with MFA cannot sign in, and SMS sign-in, Google sign-in and Razorpay payments stop |

**`JWT_SIGNING_KEY` is on this list until the keys are separated** (Mr. Singh,
29 Sept 2026, reviewing PR 346). It is not only a signing key. Two things
fall back to it when their own key is unset - MFA (`Mfa:EncryptionKey`) and
secret platform settings (`Settings:EncryptionKey`, then `Mfa:EncryptionKey`)
- and neither compose file passes either key to the API (checked on `main`,
29 Sept 2026). **Confirmed on the live API container 29 Sept 2026 17:38Z,
on Amit's approval: `Mfa__EncryptionKey` not set, `Settings__EncryptionKey`
not set** (a yes/no read; no value printed). So a rotation of the sign-in key is **not** a routine
rotation: it silently turns every stored MFA secret and sealed setting into
data nobody can read. Restore it from `env.txt` like the key below, never
generate a fresh one on a server that has data, and never print it.

Separating them is its own PR, designed and brought to Mr. Singh before it is
built: new keys, the existing secrets re-encrypted in one transaction, and
the sign-in key kept as the old key until the re-encryption is verified. When
that lands, this row changes to name the new keys instead.

## Provider settings that are part of what customers are told

Some settings live in a provider's web console, not in `.env`, and what the
privacy page promises depends on them. A discount offer can switch one with
two clicks. **Any change to these goes to Mr. Singh first, the same as a
change to a privacy sentence** (Mr. Singh, 1 Oct 2026, after the OpenAI
account was found sharing every AI request for training in exchange for free
daily tokens).

| provider, where | setting | must be | last checked |
|---|---|---|---|
| OpenAI, platform.openai.com → organisation "Techvein" → Data controls → **Sharing** | Share inputs and outputs with OpenAI; Share evaluation and fine-tuning data; Playground feedback sharing | **Disabled, all three** | 1 Oct 2026: they were ENABLED for all projects (with "complimentary daily tokens") and were switched off that day on Amit's go; read again after a reload, all three Disabled |
| OpenAI, the same → **Data retention** | API call logging; zero data retention | "Enabled per call" (our gateway never asks OpenAI to store a request); no zero data retention, so **OpenAI's default 30-day abuse-monitoring retention** applies ([OpenAI: your data](https://developers.openai.com/api/docs/guides/your-data)) | 1 Oct 2026 |
| Google (live captions in Chrome) | - | **not yet known**: Mr. Singh's five questions and a check of any Google project setting are open | - |

The sentence these support is `AiDisclosure.Retention` (PR 366). If a check
finds a setting different from this table, do not "fix" the table: tell Amit
and Mr. Singh, because the privacy page is then wrong.

Every deploy that carries an AI change says in its note that these were
checked, and on what date: see `docs/DEPLOY_RUNBOOK.md`, section 4.

`PERSONAL_PHONE_HASH_KEY` is generated once (`openssl rand -hex 32`), at the
switch-on of personal accounts. Compose refuses to run without it, and the API
refuses to start outside Development if it is missing or shorter than 32
characters. It travels in every backup's `env.txt`. **Never print it**, and
never paste it into a chat or a transcript.

**Generating one (once, on the server, from the repo root):**

1. Confirm it is not already there:
   `grep -c '^PERSONAL_PHONE_HASH_KEY=' infra/docker/.env` must print `0`.
   If it prints `1`, **stop**: the key exists, and must not be replaced.
2. Append it without printing it:
   `printf 'PERSONAL_PHONE_HASH_KEY=%s\n' "$(openssl rand -hex 32)" >> infra/docker/.env`
3. **Run a backup now, not at the next scheduled time**:
   `./infra/scripts/backup.sh`. A key that exists only in this `.env` until
   the next backup can be lost with this disk (Mr. Singh, PR 311).
4. Confirm the backup carries it:
   `bash infra/scripts/check-key-in-backup.sh PERSONAL_PHONE_HASH_KEY`.
   It must print **SAME** twice: for the newest local set, and for the
   newest off-box object, which is decrypted as a stream to check. It never
   prints the key. Anything else, whether MISSING, DIFFERENT, or a note that
   the off-box object is older, means the key is not safe yet. Find out why
   before deploying.
5. Only then deploy anything that needs it.

The same five steps apply to every key in the table above.

## What is backed up

`infra/scripts/backup.sh`, **every six hours** (02:30, 08:30, 14:30, 20:30) —
or **every two hours** once the tiered schedule below is switched on:

| artefact | why losing it hurts |
|---|---|
| `postgres.sql.gz` | every tenant, user, message header, file row, grant |
| `spaceblobs.tar.gz` | **the actual file bytes** — the database only holds opaque blob keys |
| `vmail.tar.gz` | the actual mail |
| `dkimkeys.tar.gz` | small; losing them means re-publishing DNS for every customer domain |
| `env.txt` | the uncommitted secrets, without which none of the above starts |

So up to **six hours** can be lost (two, on the tiered schedule), not
twenty-four.

## Where the copies live

**Local** — `/srv/backups/tatvaos/<stamp>/`, kept `BACKUP_KEEP_DAYS` days:
the script's default is 14, and **production sets 3** (measured 24 Sept
2026) — or, when `BACKUP_LOCAL_KEEP` is set (the tiered schedule below), only
the newest that many sets, and only after the run's own set is proven in the
bucket. Unencrypted. Fine for "someone deleted a mailbox", useless for "the server is
gone". The directory is mode 700: the sets contain the whole database and
everyone's mail in the clear.

**Off-box** — object storage via rclone, AES-256, one object per set:
`${BACKUP_S3_REMOTE}/<stamp>.tar.gz.enc`. **This is the real off-box path.**
Configured in `/srv/backups/tatvaos/.backup-env`:

```bash
BACKUP_S3_REMOTE='linode:tatvaos-backups'
BACKUP_ENC_PASSPHRASE='...'                # also on paper, offline
BACKUP_S3_KEEP_DAYS=7                      # production's real value; ignored when BACKUP_S3_TIERED=1
BACKUP_KEEP_DAYS=3                         # pre-deploy copies; local sets too ONLY when not tiered
```

**Off-box copies reach back at least 7 days, never 30.** This page said 30
until 24 Sept 2026; the server's own config says 7, and the server is what
happens. With the tiered schedule on (production, since 25 Sept) the bucket
keeps one set a day for EIGHT days, so the oldest restore point is always
between 7 and 8 days old — see the table below. Measure
it (`BACKUP_S3_KEEP_DAYS` only — never print the file) before quoting a
number to anyone.

**Pre-deploy copies** — `/srv/tatvaos-production/backups/pre-deploy-<stamp>.sql.gz.enc`,
one per deploy, written by `deploy.sh` before it touches anything (PR 254,
Mr. Singh's ruling of 25 Sept 2026):

- **Encrypted** with the same scheme and the same `BACKUP_ENC_PASSPHRASE` as
  the off-box objects. On production a missing passphrase **stops the
  deploy** — it will not write a plain copy.
- **Locked down**: directory 700, each file 600, created that way.
- **Kept by days: `BACKUP_KEEP_DAYS`.** With production's 3, a pre-deploy
  copy older than 3 days is gone; anything older comes from the off-box
  objects (at least 7 days). **With tiering on, this is NOT the setting for
  the scheduled local sets** — those follow `BACKUP_LOCAL_KEEP` (a count).
  Lowering `BACKUP_KEEP_DAYS` to save space shrinks only the pre-deploy
  copies (Mr. Singh's 26 Sept instruction assumed otherwise; the alert's
  numbers could not show the difference, and now does).
- **Checked whole** before the deploy carries on: decrypted, gunzipped, and
  checked for `pg_dumpall`'s end-of-dump marker.

Restore one (it is a whole-cluster `pg_dumpall`; restore into a scratch
container first unless the live database is already lost):

```bash
set -a; . /srv/backups/tatvaos/.backup-env; set +a
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE \
    -in backups/pre-deploy-<stamp>.sql.gz.enc | gunzip | psql -U postgres
```

**Read this during an incident, not after it: a pre-deploy copy lives only
3 days.** A bad deploy noticed on day four has no pre-deploy copy to go back
to. Use the newest off-box object from before that deploy instead (kept 7
days; six-hourly, or two-hourly for the last day on the tiered schedule). Check `ls -l backups/` for
the dates before you plan the restore.

**Rotating `BACKUP_ENC_PASSPHRASE`: keep the old one until everything written
with it has aged out.** That is 3 days for local and pre-deploy copies and 7
days for off-box objects. Rotate and throw away the old passphrase on the same
day, and a week of backups can no longer be opened.

**The old plain copies** (`pre-deploy-*.sql`, `pre-deploy-*.sql.gz`, 323 of
them, 31 GB, 4 Aug to 24 Sept 2026) are **never deleted by a deploy**; each
deploy counts them aloud. They were chmod-ed 700/600 by hand on 25 Sept. Mr.
Singh's order for removing them: (a) prove a restore into a scratch database;
(b) PR 254 live; (c) one explicit deletion run by a person, logged with the
count, the date range and who authorised it.

### The tiered schedule (Amit, 24 Sept 2026)

Off until these two lines are added to `.backup-env` **and** `--install` is
re-run (it rewrites the cron line to match):

```bash
BACKUP_S3_TIERED=1
BACKUP_LOCAL_KEEP=4                          # production since 26 Sept: 8 hours at two-hourly
```

| age | kept in the bucket |
|---|---|
| under 24 hours | every set (one every 2 hours — 12) |
| 24 to 48 hours | one per 6-hour slot (about 4) |
| 2 to 8 days | one per day, that day's last (about 6) |
| over 8 days | none |

About 22 sets. **Why eight days for a seven-day promise:** the set kept for
a day is its last one, so when a 7-day cut-off dropped it, the next oldest
was only 6 days old — measured in the bucket on 26 Sept 2026, 156 h and
falling to 144 h. At 8 days the next oldest is 7 days when one drops, so the
backups always reach back at least a week (Amit, 26 Sept; checked on every
simulated run by `backup-tiers-test.sh`). Which to delete is decided by `infra/scripts/backup-tiers.sh`
from the **names** of the objects, and each is deleted by name — never a
recursive delete, so anything else in the bucket is left alone. It deletes
nothing on a run whose own upload failed or whose bucket listing does not show
the set just uploaded, and it never deletes the newest three sets
(`BACKUP_S3_MIN_KEEP`), so a week-long outage followed by one good run does not
empty the bucket.

`BACKUP_LOCAL_KEEP` is not optional here: twelve full sets a day would fill the
server's disk within days. `--install` refuses the two-hourly cron line without
it. A run takes a lock (`.backup.lock`), so a slow run and the next one never
overlap — the second says so in the log and does nothing.

Tests, no server needed: `bash infra/scripts/backup-tiers-test.sh` (the rule —
fourteen simulated days) and `bash infra/scripts/backup-sh-test.sh` (the
deleting, end to end with fakes; Linux or WSL, it needs `flock`).

**Restoring from more than four hours ago means a download first.** With
`BACKUP_LOCAL_KEEP=2` the server holds only the last two sets — about four
hours. Anything older is a 4 GB object in the bucket (`rclone copy`) that
has to come down before the restore command above can start. **The download
has not been timed.** What is known: a whole backup run — dump, tars, encrypt
and the 4 GB upload — finishes in about 9 minutes (log, 25 Sept 2026), so a
download within the same datacentre should be of that order; the 9 Sept drill
pulled a 0.6 GB object. Time it in the next drill and write the number here.
Budget for it in the incident, not during it.

The pre-deploy copies are not touched by this prune: they are **files** in a
**different directory** (`/srv/tatvaos-production/backups/`), and the prune
removes only **directories** named `YYYYmmdd-HHMMSS` inside
`/srv/backups/tatvaos/`. `backup-sh-test.sh` puts a pre-deploy copy in the
sets directory anyway and checks it survives.

`linode:tatvaos-backups-hold` is a **separate** bucket holding one set set
aside by hand on 24 Sept 2026 (the last set before the mail import). Nothing
in `backup.sh` touches it.

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

The local sets are already on disk and already decrypted — **but on the tiered
schedule only the newest two are here, about four hours' worth.** `ls
/srv/backups/tatvaos/` first. If the set you want is not there, it is a 4 GB
download from the bucket before anything else can happen (untimed as of 25
Sept 2026; a full backup run including the 4 GB upload takes ~9 minutes, so
expect that order — see *The tiered schedule* above). Then follow **B** with
the object you fetched.

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

## What the 24 September 2026 test proved

`~deploy/restore-test.sh`, run on the production host on 24 Sept 2026 (log
`~deploy/restore-test.log`, 06:22 UTC). Accepted by Mr. Singh on 26 Sept as
the most important result of that week. Three parts, each proving a
different thing; `FAIL` lines in the whole log: **0**.

**A. The newest pre-deploy dump restores.** `pre-deploy-20260924-061346.sql`
(961 MB) into a throwaway `postgres:17-alpine` — created by the script with a
random name, `--network none`, no volume; its `system_identifier` checked
DIFFERENT from production's and the cluster checked EMPTY before a byte went
in, so the dump's role and database statements could not reach live. One
error, the benign `role "postgres" already exists`; nothing else.

| table | restored | live |
|---|---|---|
| core.tenants | 5 | 5 |
| core.users | 186 | 186 |
| core.audit_logs | 1077 | 1077 |
| mail.mailboxes | 193 | 193 |
| mail.folders | 1158 | 1158 |
| mail.messages | 40413 | 40415 — two arrived after the dump |
| connect.meetings | 151 | 151 |

**B. The newest off-box object opens.** `20260924-023001.tar.gz.enc`
streamed download → decrypt → `tar -t` in one pipe (nothing plaintext on
disk). Stage exit codes `0 0 0`, all members present. Every stage's code is
checked, not just the last: before it ran, the same block was fed objects
cut off at 60%, 16 bytes and **1 byte** short, a dropped download and a
wrong passphrase, and all went red — the 1- and 16-byte cuts still LISTED
every member, so a "members present" check alone would have passed a
truncated backup.

**C. The newest local mail archive is readable.** Set `20260924-023001`:
30,743 files in `vmail.tar.gz` against 30,811 in the live maildir; the 68
extra are mail that arrived after the backup.

Clean-up ran on every exit path (tested beforehand: success, failure and
interrupt, which exits 130 — not 0) and verified the throwaway container and
temporary folder gone.

**What it did not prove.** It decrypted with the **server's** copy of the
passphrase, not the paper one, and ran on the production host — so, like the
9 September drill, it does not cover losing the server. It LISTED the mail
archive and the off-box object; it did not restore `vmail`, `spaceblobs` or
`dkimkeys` into live volumes. **The disaster drill — Amit's paper copy, on a
machine that is not this server — is still to do.**

**Since then (26 Sept):** the tiered settings are in force —
`BACKUP_S3_TIERED=1`, `BACKUP_LOCAL_KEEP` sets kept here — while cron still
runs every **six** hours, because `backup.sh --install` has not been re-run.
`BACKUP_KEEP_DAYS` now governs only the pre-deploy copies (deploy.sh), not
the scheduled sets.

## Not covered

- **Point-in-time recovery.** These are six-hourly (two-hourly, tiered) snapshots;
  up to that much can be lost. WAL archiving is the upgrade when that stops being acceptable.
- **Rotation and old secrets.** A rotated credential survives in local sets and
  pre-deploy copies for `BACKUP_KEEP_DAYS` (local sets: the newest
  `BACKUP_LOCAL_KEEP` when tiered) and in off-box objects for
  `BACKUP_S3_KEEP_DAYS` (when tiered: one set a day for eight days, so never less than seven — see `backup-tiers.sh`). **Changing `BACKUP_ENC_PASSPHRASE` does not re-encrypt
  anything already written** — keep the old one until the last copy made with
  it has aged out of every window. Rotation is not
  finished when the new secret is live; it is finished when the old one is out
  of reach.
- **Restoring onto a bare machine.** See the drill section above.

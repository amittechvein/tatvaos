# 0019 — Switching the Google migration on: the key, the mailbox sign-in, calendar ownership, the disk

**Status:** proposed. Recommendations by the migration session, 9 Oct 2026,
for Mr. Singh's ruling. Built **switched off** in the PR that adds this file,
so a ruling changes configuration, not code, wherever it can.
**Date:** 2026-10-09
**Lane:** Google Workspace migration (`GOOGLE-WORKSPACE-MIGRATION-SPEC.md`)
**Needs:** Mr. Singh on §1-§4; Amit on §4's last paragraph.

Four things stand between the built migration (PRs 417-428) and a first real
run. Each is below with the options, a recommendation, and what was built.

---

## §1 Where the Google key is held

### Context
Design section 9 assumes each customer gives us a service-account key with
domain-wide delegation, stored encrypted with `SettingsCrypto`. Measured on
9 Oct: `SettingsCrypto`'s key is derived from `Settings:EncryptionKey` →
`Mfa:EncryptionKey` → `Jwt:SigningKey` → `JWT_SIGNING_KEY`, which live in
`infra/docker/.env` - and `backup.sh` copies `.env` verbatim beside the
database dump. **A backup would hold the encrypted keys and the key that
decrypts them.**

### Options
1. **Customer's key, encrypted in the database** (the design as written).
   Per-customer blast radius. But a key-upload screen, per-tenant secret
   storage, deletion on completion, and the backup problem above.
2. **One TatvaOS-owned service account.** The customer's admin authorises
   OUR client ID, with read-only scopes, in their own Admin console, and
   removes it when done. No customer key is ever handled. Our key is one
   file on the server: mounted read-only into the API container, not in the
   database, not in `.env`, not in any backup.

### Recommendation: option 2
Nothing secret per customer exists to store, leak or forget to delete. The
cost is named honestly: **if our one key leaks, every customer with an
active grant is exposed.** Bounded by read-only scopes, by the final screen
telling the admin to remove the grant (design section 9 already requires
it), and by `migration.grants` recording, per organisation, when access was
granted and when the admin says it was removed - a job is never claimed for
an organisation with no active grant.

Section 9's other rules carry over unchanged: never logged, never in an error
(`GoogleApiException`/`GoogleAuthException` blank token-shaped text), every
use audited (each token request is logged with organisation and person, never
the token).

### Built
`FileGoogleCredentialProvider` (reads `Migration:Google:KeyFile`; refuses a
file other accounts can read), `migration.grants`, and the grant endpoints.
**Off** until `Migration:Google:KeyFile` is set.

---

## §2 How the migration signs in to each mailbox

### Options
1. **Dovecot master user.** Sign in as `person*migration` with a master
   password; everything else is the IMAP path already built and tested
   against the real local Dovecot (`tests/migration-mail`). Dovecot stays the
   only writer to the maildir.
2. **doveadm HTTP API** (`doveadm save` into a mailbox). No sign-in per
   person, but a different write path to build and test, and a larger
   change to the mail server.

### Recommendation: option 1, fenced
- a master passdb that is **only consulted on a separate listener** bound to
  the internal network, never 143/993/587;
- the master password **generated on the server straight into its file**
  (house rule 5), read by the API from a file, never from `.env`;
- every master login logged by Dovecot under the master name;
- **off** when no migration is running (the passdb file absent = no master
  login possible).

doveadm is the better tool for design 7.1 (webmail state written back to the
maildir), where Mr. Singh already leans; it is not needed for this.

### Built
`local/dovecot` and `infra/` master passdb (absent-file = off), and
`MasterMailboxLogin`. **Off** until the master password file exists.

---

### The system notices when it is left on (Mr. Singh's addition, built 10 Oct 2026)
A master login left on is the worst thing on the server to leave on, and
switching it off lives in a person's memory. So:
- **The API logs CRITICAL at every start** while its copy of the password
  file is non-empty, naming since when (the file's mtime) and the command
  that switches it off (`MasterMailboxLogin.ReportAtStartup`). Off or not
  configured: one Information line, so the state is always in the log.
- **`infra/scripts/migration-master-alert.sh`, from cron hourly**, reads one
  fact from the Dovecot container - whether `master.passwd` is non-empty,
  and its mtime; never the content. First seen on: one mail at once. On for
  more than three days: a daily reminder until it is off. Off: nothing, and
  the next on is a new crossing. Fails loudly, like `memory-alert.sh`.
  Install once on the server: `MIGRATION_ALERT_TO=<off-server address>
  ./infra/scripts/migration-master-alert.sh --install`.
- The "prove from outside that it refuses" step stays mandatory at switch-on.

## §3 Calendar: whose calendar a meeting lands in

Built in PR 426 as option A: a meeting lives in its ORGANISER's calendar;
attendees are linked rows. Its one cost: a meeting organised by someone in
the organisation who is never migrated does not arrive.

### Recommendation: A, plus a final sweep
After every enrolled person's calendar job has completed, a sweep creates
any in-organisation meeting that is still missing in its first migrated
attendee's calendar. That removes A's only cost without B's (a meeting owned
by an attendee while its organiser is also being migrated).

### Built
The sweep as `GoogleCalendarSource`'s third pass, which runs only once no
calendar job in the organisation is still pending or running.

---

## §4 Which disk, and the reserve

### Context
Mail lands twice (design 7.2): the `vmail` volume (maildir) and the
`pgdata` volume (`mail.messages`). On the one Linode both are on its disk;
`MigrationFit` adds the two needs together when the paths share a
filesystem, and checks each disk separately when they do not.

### Recommendation
- **The disk that matters is the Linode server's**, measured from the API
  container at `Mail:VmailRoot` and `Space:BlobRoot`.
- **Reserve: the larger of 10% of each disk or 5 GiB**, kept free after the
  migration lands. A full disk stops mail for every customer, not the one
  migrating.
- **When the estimate refuses, it names the shortfall** ("short by 37 GiB"),
  which is the size of Linode Block Storage volume to attach.

### Built, and why the single-disk case matters (10 Oct 2026)
- **Today there is one data disk.** The Core session measured the server on
  9 Oct: `/dev/sda`, 157 GB, 72 GB free, and Postgres (`pgdata`), the mail
  store (`vmail`) and Space (`spaceblobs`) are all on it. So checking the
  mail store's path covers the database too. **That is a fact about today's
  hardware, not about the logic**: the moment Block Storage is attached for
  a large customer, mail and Space may land on different filesystems, and
  that is when the comparison below starts doing real work rather than
  agreeing with itself. Re-check `df` before trusting it.
- **The double count is in `MigrationFit`** (`mailOnDisk = MailBytes * 2`),
  confirmed, not a thing to do.
- **Which filesystem a path is on is decided by identity, not by size.**
  `DiskFigures.Volume` is the device id ("major:minor" from
  `/proc/self/mountinfo`) of the mount holding the path. Not the mount
  point: inside the API container every Docker volume is its own mount
  point, so by mount point the two volumes on the one disk would read as
  two filesystems - and judging one disk as two permits a migration whose
  mail fits and whose Drive files fit but which together do not. Two disks
  judged as one is the opposite error. Bind mounts of one device share its
  id, so the identity is exact either way. The old size comparison remains
  only as a last resort when no id could be read.

**For Amit:** the design treated the disk as a hard limit because Amit did
not want another server. Additional storage (Block Storage) changes
"refuse" into "refuse and say how much to add". That is a change to the
design's premise and Mr. Singh should hear it from Amit.

---

## Consequences
- Switching on is three configuration values (`Migration:Google:KeyFile`,
  the Dovecot master password file, `Migration:Runner=on`) once ruled, plus
  the infra change in §2 being deployed.
- Every recommendation is reversible by configuration except §1's choice of
  model; changing that later means building the key-upload path option 1
  describes.

## Revisit when
- A customer's IT refuses to authorise a third party's client ID (§1 → offer
  option 1 for that customer, or the Thunderbird path).
- 7.1 is ruled with doveadm (§2 → move the write path onto it).

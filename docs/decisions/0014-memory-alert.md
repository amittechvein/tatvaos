# 0011 — Tell someone when the production server runs short of memory

**Status:** proposed, for Mr. Singh. **Nothing is built and nothing on the server
is changed until this is approved.**
**Date:** 2026-09-27
**Asked for by** Mr. Singh on 25 Sept, reading the 0010 measurements: "swap in use
on production. The server has been memory-short and nothing announced it. That's
a monitoring gap. Put a memory alert on the list next to the disk one." And on
27 Sept: "a check that prints only during a deploy isn't an alert, and the
shortage happens during recordings between deploys. A periodic check that emails
someone is the right shape."

## A correction first

On 25 Sept the lane told Amit and Mr. Singh that "the disk one" was only a
warning `deploy.sh` prints during a deploy. **That was wrong.**
`infra/scripts/disk-alert.sh` has been on `main` since 26 Sept (971631b, 8a4d672)
and runs on the server from `deploy`'s crontab every 30 minutes. It is a real,
periodic, emailing alert, and it is the model for this one.

## What we know about memory on production (read-only, 25 and 27 Sept)

| | Reading | What it means |
|---|---|---|
| Memory | 7.9 GB; about 6.0 GB available | Quiet when read. Both readings were idle moments |
| Swap | 2.5 GB (a 2 GB file and a 496 MB partition); **683 MB in use** | Something was pushed out to disk at some point. **A lagging sign:** pages swapped out long ago stay counted after the pressure has passed. It says "it happened", not "it is happening" |
| Memory pressure (PSI, `/proc/pressure/memory`) since boot, 37 days | **some: 437 s, full: 371 s** | The kernel's own measure of time lost to memory shortage. "full" = every runnable task stalled waiting for memory: **about six minutes in total over five weeks.** Modest, but real, and nobody was told. Averages over 10 s, 60 s and 300 s were all 0.00 when read |
| Container memory caps that can all be reached at once | api 1 G, postgres 2 G, egress 2 G, livekit 1 G, redis 512 M = **6.5 GB** | On a 7.9 GB box, with a recording running (egress) and a deploy building images on the same box, that leaves little |
| Containers killed for memory | none: `OOMKilled=false`, 0 restarts, all twelve | Docker's own record, per container |
| Kernel memory kills (host) | **unknown.** The `deploy` user cannot read the kernel log (`journalctl -k` → "No entries"; not in `adm` or `systemd-journal`) | Today a host-level kill would be **invisible** to us |

## What is proposed

`infra/scripts/memory-alert.sh`, built the same way as `disk-alert.sh` in every
respect that has been reviewed there:
- read-only;
- sent through the box's own Postfix to an address **off** the server (`DISK_ALERT_TO`, reused);
- once per crossing plus a daily reminder while it stays above, remembered in a state file;
- `FORCE` and `DRYRUN` modes;
- **fails loudly:** if it cannot read what it reads, it mails that;
- one log line per run, so the log proves it ran and shows what it read.

### What it watches, and why each

1. **Memory pressure (PSI), the main signal.** It is the direct symptom:
   processes waiting for memory, which is what a person in a meeting feels.
   - **Warn** when `some avg300` ≥ 10%: over the last five minutes, something
     was waiting on memory for 30 s or more.
   - **Critical** when `full avg300` ≥ 5%: everything was stalled for 15 s or
     more of the last five minutes.
2. **Memory available below a floor**, which catches the approach before the stall:
   - **warn** under 15% of total (about 1.2 GB);
   - **critical** under 7% (about 550 MB).
3. **A container killed for memory, or a new restart.** Each run compares
   `OOMKilled` and `RestartCount` for every container with the last run's
   values, and mails **at once** on any change, naming the container. This is
   the event itself, not a symptom.
4. **Swap is shown, not alerted on.** It lags (see above), and an alert on it
   would fire for weeks after a single episode. It goes in the breakdown with
   that sentence beside it.

### What the email says

- The figures above.
- Each container's memory use against its cap (`docker stats --no-stream`).
- **Whether egress (a recording) or a Docker build was running**: the two known
  causes. A build is seen as a `docker build` / `buildkit` process.
- **What to do, cheapest first:**
  1. If a recording is on and a deploy is building, that is the known collision.
     The deploy hold (0008) is the rule for it; don't deploy during a recording.
  2. If one container sits at its cap, that container's cap or its workload is
     the question, not the server.
  3. Only if it keeps happening with nothing unusual running: a bigger Linode
     plan (price from Linode at the time; not quoted here). That is Amit's decision.

### How often

**Every 5 minutes**, not every 30 like the disk. Disk fills over days; memory
runs out in the length of a recording. At 5 minutes, one run is: two small file
reads and one `docker inspect` across twelve containers, a fraction of a second.
The breakdown (`docker stats`) runs only when a message is being sent.

### The thresholds are a first guess, and the plan says so

There is no history to calibrate against. PSI's "since boot" total cannot say
*when* the 371 seconds happened. So for the first **two weeks** the one-line log
records `some`/`full` avg300 and available memory on every run. After that the
thresholds are set from what the log shows. Until then they are deliberately a
little loose rather than noisy.

## Options

1. **A separate `memory-alert.sh`** (proposed). It has a different cadence
   (5 minutes, not 30) and a different failure domain: a bug in one doesn't
   silence the other.
2. **Grow `disk-alert.sh` into one server alert.** One file and one cron line,
   but it would run the disk check twelve times as often, or the memory check
   six times too rarely. And one broken script silences both.
3. **An outside monitoring service** (a hosted agent). Better graphs and
   history; another third party with access to the box; a cost. Not for now.

## Questions for Mr. Singh

1. **Option 1**, and the thresholds as a two-week first guess?
2. **The kernel log.** Should the `deploy` user join the `systemd-journal`
   group, so a host-level memory kill is visible to this alert (and to us)?
   That is a change to a server account: read-only access to system logs,
   Amit's go on the box. Without it, a kill outside a container's own cap
   stays invisible.
3. **The recipient.** `DISK_ALERT_TO`, the same off-server address as the disk
   alert, or a different one?
4. **Scope:** this also closes the "backup job fails silently" gap only if it
   is asked to. `backup.sh` emails no one when it fails; the disk and memory
   alerts would not notice. Put that on the list separately?

## Consequences

- One cron line (`*/5`) and one script in `deploy`'s home, installed like the
  disk alert: copied from the repository, and **never edited on the server**.
- An email only when something crosses, plus a daily reminder. A `[TEST]`
  rehearsal on install, the same as the disk alert's.
- The first two weeks' log is the calibration record, kept with the script.

## Revisit when

- The box is resized, or a container's cap changes: the floors are fractions,
  but the caps table above goes stale.
- A second production server exists.
- An outside monitoring service is adopted (option 3).

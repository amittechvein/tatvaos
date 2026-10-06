# Capacity — what the one server can carry, measured

Written 24–25 September 2026 from `sysstat` on the production box, the
database (counts and sizes only), and the Akamai Asia-Pacific price list.
Every number here was measured; the two that are estimates say so.

**Symptom → diagnosis → fix → confirm** applies here as: *a number on the
watch-list crosses its trigger → read this page → do the cheapest thing that
answers it → measure again.*

## The box

Linode 8 GB, Mumbai: **4 vCPU, 7.9 GB RAM, 160 GB disk, 5 TB transfer,
$48/month.** Next size up: 16 GB / 6 vCPU / 320 GB, $96. A block-storage
volume is $0.10/GB/month; object storage $0.02/GB/month.

## What it carried on 24 September 2026

| | |
|---|---|
| Organisations | 5 (4 active, 1 trial) |
| People | 42 active, 34 signed in that week |
| Mailboxes | 193 · 40,416 messages · 638 MB as the app counts it, 5.3 GB on disk |
| Meetings held | 130 · largest 203 participants (19 Sept) |
| Recordings | 51 · 9.8 GB · 30-day age-off proven working |
| Typical day | CPU 10–16% average, RAM 5–6 GB available, load 0.4–0.9 |

## The 19 September meeting — the number to trust

203 participant rows, 08:27–11:46 UTC, two recordings (09:57 and 11:07).

| | Inside the meeting | The hour after it ended |
|---|---|---|
| CPU busy (10-min average) | **average 19%, peak 49%** | **peak 77%** at 11:50, five samples above 70% until 13:00 |
| Outbound | peak 8.6 Mbps | peak 62.9 Mbps at 12:40 |
| RAM available | never below 3.59 GB | — |

**The lesson, and it corrected two people's assumptions:** turning the
recordings into files after the meeting cost more CPU than the meeting did.
A 200-person, listener-heavy meeting is half of one core's worth of headroom
away from nothing. **What to watch is how many recordings are being
processed at once, not how many people are in a room.** Two such meetings at
the same time would not saturate the box; two meetings *ending* at the same
time, both recorded, might.

The one thing this does not measure is a camera-heavy meeting. From the
Connect Phase-0 estimate (an estimate, not a measurement): every camera is
sent out once per viewer, so 5 meetings of 8 with cameras on is ≈ 280 Mbps
outbound. That, not CPU, is the ceiling for camera meetings — roughly 50–80
people with cameras on at once across the whole box.

## Triggers — when to spend money, in order of cheapness

Do the first thing that applies. Measure again before doing the next.

1. **Disk above 70%** → look at backups and build cache before anything
   else. On 24 Sept the disk was at 81% with customer data at 16 GB: 74 GB
   was our own backups. The pre-deploy copies now have retention
   (`deploy.sh`), the build cache is pruned each deploy, and the off-box
   set keeps 7 days. The disk alert (`disk-alert.sh`, 70% and 85%) says
   this in the email.
2. **Disk still above 70% after that** → a Linode volume for recordings
   and backups. Recordings grow with usage, mail barely does
   (≈35 MB/week).
3. **CPU** → watch for recording processing overlapping: `sar -u` peaks
   above 70% that line up with `connect.recordings.created_at`, not with
   meetings. If it happens weekly, the answer is a second box for Connect,
   not a bigger single box — meetings are bandwidth-bound, mail is
   disk-bound, and they do not want the same machine.
4. **RAM** → `available` under 1.5 GB during working hours. Never seen.
   Postgres is capped at 2 GB and would need lifting past ~2,000 mailboxes.
5. **Bandwidth** → the Linode plan's 5 TB/month. 4 backup uploads a day
   is ≈ 0.5 TB/month of that. Camera meetings are the other consumer.

## How to measure it again

All read-only, on the box as `deploy@`:

```bash
sar -u | tail -3                       # today's CPU so far
sar -u -f /var/log/sysstat/sa19        # any day this month, by file number
sar -n DEV -f /var/log/sysstat/sa19 | awk '$3=="eth0"'   # network, KB/s
sar -r -f /var/log/sysstat/sa19        # memory
df -B1 /                               # the one disk
```

`sar` prints `HH:MM:SS AM|PM` on this box, so the CPU columns start at `$3`,
not `$2` — a script that assumes otherwise prints nothing and looks like an
empty day.

Counts in the database need Amit's go (production reads). Ask with the query
written out; report counts, never addresses.

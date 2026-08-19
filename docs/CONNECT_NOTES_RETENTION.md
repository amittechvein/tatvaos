# Connect — notes timing, retention, spoken notice. 19 August 2026, evening.

The batch that followed the first proven end-to-end run. Read with
docs/CONNECT_DECISIONS.md, whose two rulings it implements.

## 1. Notes no longer lie about the recording (20260906)

The proven run exposed it: minutes said *"this meeting was not recorded"*
beside a recording marked Ready. Two holes, both closed.

**Timing.** `pending_notes` deferred for a transcript in flight and nothing
else — with transcription off there is no transcript coming, so notes fired
while the egress was still finalising. It now also defers while any recording
for the meeting is `starting`, `recording` or `processing`. The repair pass
guarantees those states settle, so this is minutes of delay, never a
deadlock. Both the webhook and the repair pass also RE-QUEUE ready notes
whose `had_recording` is false the moment a recording lands — the mirror of
the existing transcript re-queue, as a race guard.

**Honesty.** "No transcript" has two causes and the notes could only name
one. `meeting_notes.had_recording` now records whether a Ready recording
existed at composition, and the provenance line says one of three true
things: recorded and transcribed; *recorded, but no transcript was made*;
not recorded. Three new assertions in tests/connect-minutes pin the third
sentence.

**Today's meeting still carries the wrong sentence** — its notes were
written before this fix. One click on Regenerate notes (or
`POST /api/connect/meetings/{id}/notes/regenerate`) after deploy rewrites
them with the recording acknowledged.

## 2. Retention (20260907) — the 90-day promise, made true

Per the decision: `core.tenants.connect_recording_retention_days`, one of
7/30/90/180/365, default 90, CHECK-constrained. The sweep lives in
`ConnectNotesWorker` (which already owns the recording lifecycle), runs
after the repair pass, and does at most ten deletions per tick so a first
run against a backlog drains over hours rather than saturating the disk on
a box that also delivers mail. Deletion mirrors the host's Delete button:
file first, row to `deleted` only if the file actually went, storage
reconciled, and an audit row (`connect.recording.expired`) so "where did my
recording go" is answered with a row, not a shrug.

**"Keep this one" ships from day one:** `recordings.keep_until_at`, set by
the host via `PUT .../recordings/{id}/keep {days: 30|90|180|365}` (null
clears). The spec's own prediction is that the first support ticket is a
board meeting that got swept.

**One ruling made here, flagged for Amit.** The spec says "the transcript
and notes follow the same rule." Implemented as: the recording's
**transcript rows are deleted with it** — they are the words verbatim, and
keeping them defeats why an organisation shortens retention — but the
**notes stay**: summary, decisions, attendance are the meeting's record and
were already emailed to the room. If "notes too" is what was meant,
`SweepExpiredRecordingsAsync` is the one place to change.

**Setting the retention is still SQL**, like `allow_connect_recording`
before it — there is no org-settings API for Connect flags yet. When that
UI is built (Core's org pages), the decision's warn-on-shorten rule applies:
say how many recordings the change destroys, ask twice.

## 3. The spoken notice — wired, awaiting its 20 KB

Stage.tsx now plays `/connect-recording-notice.mp3` when recording becomes
active FOR THIS CLIENT — covering both joining an already-recorded meeting
and a recording started twenty minutes in — locally, once per activation,
never into the room or the recording. A refusal or missing clip is
swallowed: the written, non-dismissible, `role="status"` banner remains the
guaranteed channel.

**The clip itself is NOT in this commit and must be added before the
feature is called done:** record the exact sentence *"This meeting is being
recorded."*, export as a small mp3 (~20 KB), save as
`apps/web/public/connect-recording-notice.mp3`. Deliberately a recorded
file, not the Web Speech API — browser voices vary and are absent on some
Android builds. Verify autoplay on Safari specifically; iPhone guests are
the strict case.

## 4. Also in this batch

- `/connect/dev` is deleted from the bundle.
- `connect-recording-verify.sh` gained its 20260906/20260907 section the
  day the migrations shipped, including a WARN naming any organisation set
  below the 90-day default.
- Core's `core-connect-0001-roomcreate-for-deleteroom.patch` reviewed:
  correct — roomAdmin governs people, roomCreate governs lifecycle, and the
  containment matches MintRecordToken. One nit: `MintRoomLifecycleToken`
  hardcodes 10 minutes where `MintRecordToken` reads
  `_options.TokenMinutes`; harmless, worth aligning next touch.

## Still pending from this list

Transcription switch-on (handover §7.2) is box-side, not code: run
`python3 infra/apply-whisper.py .` at the repo root, commit what it
changes, then on the box set in `infra/docker/.env`:

    COMPOSE_PROFILES=whisper
    CONNECT_TRANSCRIPTION_URL=http://whisper:8000/v1/audio/transcriptions
    CONNECT_TRANSCRIPTION_MODEL=small
    CONNECT_TRANSCRIPTION_LANGUAGE=en

and deploy. The first transcription downloads the model and is slow once.
If `docker compose build whisper` fails on the FROM line, that is the
python:3.12-slim tag the handover could not verify.

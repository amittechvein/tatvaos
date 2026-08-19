# Connect — what needs other people, 19 August 2026

The requirements list of 19 August is roughly two-thirds built (see
CONNECT_HOST_CONTROLS.md for today's additions and CONNECT_HANDOVER.md §1
for what already worked). What remains either needs a decision from Amit, a
purchase, or another team's lane. Nothing below should be started without
its answer, because each one changes the design.

## For Amit — decisions

**Speaker attribution ("Speaker 1 → Rahul") is a CPU purchase, not a
feature.** A room-composite egress records ONE mixed audio stream; no AI
recovers who-was-who from a mix reliably. The real fix is per-track egress —
each participant recorded separately, attribution exact, no inference —
at roughly 0.5 CPU per participant against 1 for the whole room, on the box
that also runs the SFU. A ten-person meeting goes from 1 CPU to 5. Either
that capacity is bought, or the transcript stays unattributed and says so.
Until this is decided, the "Speaker name + timestamp" transcript format and
voice-to-account mapping from the requirements cannot honestly ship.

**AI notes with owners, deadlines, priorities and topic timelines need a
real model.** The plumbing already exists — set
`Connect__Recording__NotesUrl`, `NotesKey`, `NotesModel` and the composer
switches from `digest` to `model` with no code change, and the minutes
already label which kind they are. Self-hosting an LLM on the SFU box is not
on. So: a vendor API (cost question AND a data-policy question — meeting
audio/transcripts leaving the box matters more for schools than the money),
or a second machine. Decide, and the decision is one .env edit.

**Transcription can be switched on today** (half a day, handover §7.2):
`python3 infra/apply-whisper.py .`, four .env lines, deploy. On-box, no
audio leaves the server. This unlocks the "what was said" half of notes and
minutes with no third party involved. Set the language explicitly.

**E2EE and recording are mutually exclusive** — with E2EE on, the server
cannot decode media, so no recording, no transcript, no notes. Per meeting,
one or the other. The requirements list asks for both; settle which wins
before it is promised to a customer.

**Pause/resume recording**: LiveKit Egress does not support it (verified,
open upstream issue #195). The honest option is stop-and-start producing
multiple files — already possible today. Decide whether a "Pause" control
that visibly produces segments is wanted, or no button at all.

**One sharer at a time**: the requirements ask for it; the module ships
multiple simultaneous sharers as a deliberate feature. Pick one.

**Consent versus notice** (recording): participants are told, non-dismissibly.
Whether they must AGREE is a legal/product decision still open — relevant in
several jurisdictions Connect will run in.

**Retention**: nothing expires a recording, and Mail shares the filesystem.
Needs a policy (e.g. per-org days-to-keep) before disk pressure decides it
for you.

## For the Core developer

1. **Patch to apply**: `infra/patches/connect-host-0001-dbcontext.patch` —
   two lines in AppDbContext (DbSet + ToTable for `connect.meeting_blocks`),
   same shape as connect-minutes-0004. Already applied in the working tree;
   the patch file is the lane-crossing record for your review.
2. **Still awaiting your review** (from before this session): the anonymous
   guest join path (`ConnectGuestEndpoints.cs`), and the chat-relay rule —
   the chat endpoint accepts "here is a line from a GUEST who is not me"
   (your own line always, a guest's line in a meeting you were in, never
   another signed-in person's line). Both are documented in handover §8.5
   and §6.5. Note one change in the guest file since: the admitted-claim
   lookup now reads the lobby row's user_id so an admitted COLLEAGUE
   (waiting_room='everyone') resolves — previously every one of them was
   answered with the guest failure sentence.
3. **Participant authentication / OTP-verified join** (requirements §8) is
   identity-lane work — Connect would consume whatever Core exposes. Not
   started.

## For the Space developer

**Recordings into TatvaOS Space** (requirements' "recommended" flow —
Meeting → Recording → Transcript → Summary in Space). Today recordings live
in a Docker volume, charged to the org pool, downloaded via a signed ticket.
Moving them into Space needs `IBlobStore` / `SpaceContentGateway` answers:
can Space take a streamed ~500 MB write; can it hand back a shareable link
with range-request support (a two-hour recording must seek, not download);
and does its quota accounting handle a file no individual user owns? Until
then the current shape stands and works.

## For the Mail developer

Nothing blocking. Minutes email rides Postfix and is off per organisation
(`core.tenants.connect_email_minutes`, default false; enable per org when
Amit says so). Two heads-ups: minutes mail is sent with a
record-before-attempt, three-strike ceiling (the calendar.reminder_sends
lesson), and if the future AI-notes email grows attachments or larger
recipient lists it will show up in Postfix volume. The attendance report
email to the host (requirements §7) would reuse the same mailer pattern —
half a day in Connect's lane once wanted; the data (join/leave/duration/
rejoins/late/early) is already in the minutes' attendance table.

## Already covered, for the record

Cloud recording with org gates and quota; audio-only recording (the
default); recording indicator driven by the SFU's own flag; download via
signed ticket; screen share with system audio, tab/window/screen choice
(browser picker), multiple sharers; attendance with paired join/leave
spans and rejoin counts, shown in minutes; chat kept as part of the record;
waiting room, lock, meeting password, host-only start (scheduled meetings),
remove participant — and, as of today: host leave dialog with end/transfer,
co-host management, removed-cannot-rejoin, auto-record, share policy with
live enforcement, stop-one-share, and the pre-join device screen.

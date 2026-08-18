# Connect — recording and automatic meeting notes

Written 2026-08-18. Everything below has been built and verified as far as it
can be from outside the box; the section **What is still unproven** says
exactly where that line falls.

---

## The short version

A host can record a meeting. When the recording finishes it is transcribed,
and the transcript becomes a set of notes on the meeting page.

Three things are switched **off** by default and each has a reason:

| | Default | Why |
|---|---|---|
| Recording, per server | off | needs a container that may not be deployed |
| Recording, per organisation | off | `core.tenants.allow_connect_recording` — recording a room full of people is a decision, not something that appears because you deployed on a Tuesday |
| Transcription | off | **with nothing set, no audio leaves the server**. Your market is schools and clinics in India; "the audio of every lesson went to a company abroad" is not a footnote, and not something you can take back |

Notes work with nothing configured at all: with no language model they are a
**digest** assembled on the box from the transcript, and the screen says so in
those words.

---

## The decisions worth arguing with

### 1. Audio is the default, everywhere

Not a shortcut — a measured choice, from LiveKit's own source:

```
egress/pkg/config/service.go
    roomCompositeCpuCost      = 4
    audioRoomCompositeCpuCost = 1

egress/pkg/config/pipeline.go
    func ShouldUseSDKSource(req) bool {
        return req.GetAudioOnly() && req.GetLayout() == "" && req.GetCustomBaseUrl() == ""
    }
```

An audio-only room composite with no layout takes the SDK path and **never
launches Chrome**. Video composites a browser page and re-encodes it, and
LiveKit's own admission controller prices that at four CPU.

Connect runs on one box that is already carrying the SFU. Phase 0's capacity
work put five concurrent meetings at roughly 280 Mbps outbound; adding a
four-CPU recorder to that box is the difference between recording a meeting
and degrading it for everyone in it.

So: the **Record** button in the room records audio and does not ask. Video is
available through the API and is honest about what it costs.

A consequence worth knowing: **an hour of meeting audio is about 30 MB** as
Opus. An hour of 720p video is roughly 500 MB. For a school recording six
lessons a day, that is 180 MB a day against 3 GB.

### 2. Recordings charge the organisation, not the person who pressed record

Brief §5. They draw on `core.storage_pools` through `core.storage_allocations`
with `product_code = 'connect'` — the route Space's *organisational* files
already take — and are deliberately **not** added to `core.user_storage_usage`.

Charging the host would move a colleague's remaining space when somebody else
records, and would orphan a term's worth of lessons the day that teacher
leaves.

The figure is **derived, never incremented**, for the reason written out in
`17-storage-usage.sql`: a crash between deleting a file and decrementing a
counter loses a delta forever and nothing ever notices. `connect.reconcile_recording_storage()`
recomputes from the rows.

### 3. Everyone is told, by LiveKit — not by us

The notice in the room is driven by `room.isRecording` and
`RoomEvent.RecordingStatusChanged`, which come from the SFU on the same
signalling channel as the media. A notice this API sent could be dropped by a
client that would rather not show it; this one cannot be.

It is read on `Connected` as well as on the event, because the event only
fires on a *change* — somebody joining a meeting that was already being
recorded would otherwise never be told, which is the case where being told
matters most.

**A notice is not consent.** Several of the places Connect will run require
the latter, and India's DPDP Act treats a recording of identifiable people as
personal data with a purpose limitation. What is built is a notice. If you
need consent — a click-through before joining a recorded meeting, or a
per-organisation setting that requires it — say so and it is a day's work on
top of this. It is called out here rather than quietly assumed because getting
it wrong is not the sort of thing you fix afterwards.

### 4. Transcription and notes speak OpenAI's shape, on purpose

Two endpoints, `/v1/audio/transcriptions` and `/v1/chat/completions`. That is
the shape every self-hosted Whisper server, every Indian STT vendor and every
large provider already speaks — so the choice between *on this box*, *on a
second box of ours*, and *somebody else's API* is three environment variables
and no code. It stays a decision that can be revisited rather than one baked
into a build.

`response_format=verbose_json` is requested because it carries the **timeline**.
A wall of text is a poor transcript: you cannot jump to the part you want, and
the notes step cannot tell a two-minute answer from a passing remark. A
service that ignores the request still works — the whole transcript becomes
one segment.

### 5. Notes say how they were written

`connect.meeting_notes.kind` is `'digest'` or `'model'`, and the screen says
which. A summary that might have been written by a model and might have been
assembled by a regular expression, with no way to tell, is worse than either
one honestly labelled.

The digest is: how long each identified speaker talked, every line matching a
decision cue (`we agreed`, `it was decided`, `approved`…), every line matching
a commitment cue (`I'll`, `will send`, `by Friday`, `deadline`…), and the
longest remaining sentences. Mechanical, and useful — "who spoke, and every
line where somebody said they would do something" is most of what people take
from a meeting. It is not a summary and is not called one.

---

## Switching it on

### 1. Deploy

```bash
cd /srv/tatvaos-production
git pull
./infra/scripts/deploy.sh production
```

### 2. The one-time ownership step

Egress writes as uid **1001**; the API reads and deletes as **5000**. The
directory must be owned by egress, group-owned by the API, and **setgid** so
files egress creates inherit the API's group:

```bash
docker run --rm -v tatvaos_connectrec:/r alpine \
  sh -c 'chown 1001:5000 /r && chmod 2775 /r'
```

Same shape as the `spaceblobs` step in the compose file, and invisible until
the first recording fails to appear. The verify script checks it.

### 3. Switch it on for the server

In `infra/docker/.env`:

```
CONNECT_RECORDING_ENABLED=true
```

Then `./infra/scripts/deploy.sh production` again, or recreate `api` and
`egress`.

### 4. Switch it on for the organisation

```sql
UPDATE core.tenants SET allow_connect_recording = true WHERE id = '<tenant>';
```

Deliberately not a screen yet — see **What is not built**.

### 5. Verify

```bash
bash infra/scripts/connect-recording-verify.sh
```

It will FAIL on one thing on purpose: the egress image is not pinned by
digest. Pin it after the first successful recording:

```bash
docker inspect --format='{{index .RepoDigests 0}}' livekit/egress:latest
# put the result in infra/docker/docker-compose.base.yml
```

`livekit` and `coturn` are pinned so a later `compose pull` cannot swap them
under a deployment that works. The egress digest could not be resolved from
the machine this was written on, so it ships as a tag and the verify script
refuses to be quiet about it.

### 6. Transcription — pick one

**All three are the same three variables. None of them is a code change.**

| | Where the audio goes | Cost | Speed |
|---|---|---|---|
| **A. On this box** | nowhere | a container, and CPU you are already short of | roughly real time on CPU: an hour of audio, an hour of one core |
| **B. A second small box** | your own hardware | another VPS | same, but not competing with the SFU |
| **C. A vendor's API** | off the box, possibly out of India | per minute | minutes |

```
CONNECT_TRANSCRIPTION_URL=http://whisper:8000/v1/audio/transcriptions
CONNECT_TRANSCRIPTION_KEY=
CONNECT_TRANSCRIPTION_MODEL=Systran/faster-whisper-small
CONNECT_TRANSCRIPTION_LANGUAGE=hi          # or en, or blank to detect
```

Two notes from reading the implementations rather than the marketing:

- **Set the language** if the organisation teaches in one. Automatic detection
  is the main source of nonsense on short or noisy recordings.
- Whisper.cpp's *bare* server wants 16 kHz mono WAV and egress writes Opus in
  an OGG container. Choose an image that bundles ffmpeg — the
  `faster-whisper-server` / `speaches` family and the
  `openai-whisper-asr-webservice` family both do. The API sends the file with
  its real name and content type, which is what those servers key on.

For an Indian market, vendors with Indian data residency and much better Hindi
and regional-language accuracy than base Whisper exist and speak the same
endpoint shape. That is a decision about where a school's audio may go, so it
is yours, not one to bake in.

### 7. Notes by a model — optional

```
CONNECT_NOTES_URL=http://ollama:11434/v1/chat/completions
CONNECT_NOTES_KEY=
CONNECT_NOTES_MODEL=qwen2.5:7b-instruct
```

Leave unset and notes are the digest. A model that answers badly **falls back
to the digest** rather than failing — notes are not a transaction, and
something honest and mechanical beats an error message.

Long transcripts are cut in the **middle**, not the tail, and the notes say
they were truncated. Meetings put their agenda at the start and their
decisions at the end; truncating the tail throws away exactly what the notes
are for.

---

## What was built

### Schema — `local/postgres/init/20260902-connect-recording.sql`

| | |
|---|---|
| `connect.recordings` | one row per egress, written only once LiveKit hands back an id |
| `connect.transcripts` | status, language, flat text, and a segment timeline |
| `connect.meeting_notes` | one row per meeting, replaced in place |
| `core.tenants.allow_connect_recording` | the organisation's switch, default false |

RLS **enabled and forced** on all three, scoped through `connect.meetings` on
`meeting_id` — byte-identical to the loop in `20260901-connect.sql`, on
purpose. Eight `SECURITY DEFINER` functions, every one with a pinned
`search_path`, every one returning **ids or a single number and never content**.

`connect.meeting_events.kind` had a CHECK constraint that did not include
egress events. Widened here. Without that the first egress webhook would fail
its constraint, the handler would answer 500, and LiveKit would retry a
request that could never succeed — for ever.

### API

| | |
|---|---|
| `LiveKitEgressClient.cs` | Twirp to `livekit.Egress`; reads protojson defensively — camelCase *and* snake_case, int64-as-string, nanosecond timestamps |
| `ConnectRecordingEndpoints.cs` | start / stop / list / delete / download / notes / regenerate |
| `ConnectTranscriber.cs` | multipart to an OpenAI-compatible endpoint; streams the file rather than reading it into memory |
| `ConnectNotesComposer.cs` | the model path and the digest path |
| `ConnectNotesWorker.cs` | the queue, and the repair pass |
| `ConnectWebhookEndpoints.cs` | egress events, and the room name now also read from `egressInfo.roomName` |
| `LiveKitTokenService.cs` | `MintRecordToken()` — see below |

**The record token is the one token in this system that is not room-scoped**,
because LiveKit's `roomRecord` permission has no room field. It is contained
rather than justified: minted per HTTP call, ten minutes, carries `roomRecord`
and nothing else — no `roomJoin`, no room, no publish, no subscribe — and used
only on the hop to `livekit:7880` inside the compose network. There is no code
path that returns it to a caller. If a future change hands it to a browser,
that browser can record any meeting on the platform, and there is no second
control.

**The worker follows the two-step tenancy rule at every site.** Every
`EnterAnonymousScope` is followed on the next line by `await db.SyncTenantAsync(ct)`,
including after each network call, because minutes may have passed and the
pooled connection is not necessarily the one it held before. This module got
that wrong once and the cost was a day.

### Web

| | |
|---|---|
| `lib/connect.ts` | `recordingApi`, and the types |
| `room/[code]/Stage.tsx` | the notice everyone sees, and the host's Record button |
| `room/[code]/RoomChrome.tsx` | the red banner and the pulsing dot |
| `meetings/[id]/Recordings.tsx` | recordings, transcript, notes |

The room grew **0.7 kB**: 6.87 → 7.58 kB, first load 113 → 114 kB.

### Cross-lane

`Program.cs` and `AppDbContext.cs` are shared, so they arrive as patches:

```bash
git apply infra/patches/connect-recording-0001-program.patch
git apply infra/patches/connect-recording-0002-dbcontext.patch
```

Both verified with `git apply --check` against the current files.

The DbContext patch also maps six columns as `jsonb`. Npgsql maps a string
property to `text` by default and `text` does not implicitly cast to `jsonb`
on INSERT — the write fails with 42804.

---

## What was verified, and how

| | |
|---|---|
| The migration applies, twice, cleanly | real PostgreSQL 16, from an empty database through `20260901` and `20260902` |
| Tenant A cannot see tenant B's recordings | as `tatvaos_app`, which is `NOBYPASSRLS` |
| An INSERT with no tenant is refused | `ERROR: new row violates row-level security policy` |
| An INSERT into another tenant's meeting is refused | same |
| A file name containing a path is refused | `recordings_file_name_is_flat` |
| `ready` without a file is refused | `recordings_ready_has_file` |
| A duplicated egress id is refused | `ux_recordings_egress` |
| The worker's queries work with **no tenant set** | `pending_transcription`, `stuck_recordings`, `recording_tenant` all return rows |
| Storage reaches the **org** pool and zeroes itself when recordings are deleted | `core.storage_allocations` moved 5 MiB → 6 MiB → 5 MiB across the test |
| `egress_ended` is now a legal event kind, and `egress_nonsense` still is not | the widened CHECK |
| Every assertion in the verify script returns what it expects | run against that same database |
| The API compiles | `dotnet build`, 0 warnings, 0 errors |
| The web builds | real `npx next build` with your `tsconfig` and `eslint.config.mjs`; 0 errors, 0 warnings from any Connect file |
| The compose stack renders | `docker compose config` with the full production overlay; `EGRESS_CONFIG_BODY` re-parsed as YAML to confirm the secrets interpolate and the structure is right |
| The applier is idempotent | run twice; second run is a no-op |
| Both Core patches apply | `git apply --check` against the current files |

The `REDIS_HOST` / `REDIS_PASSWORD` route into livekit-server was read out of
`cmd/server/main.go` and `pkg/config/config.go` rather than assumed — and it
is the **same** mechanism `LIVEKIT_KEYS` already uses on your box, which is
what makes it safe to rely on. That matters because `livekit.yaml` does not
expand `${VAR}` — the trap that caused the 15-restart crash loop — so putting
the Redis password in that file would have committed a secret to the repo.

## What is still unproven

Everything that needs the containers actually running:

1. That egress registers with LiveKit over Redis.
2. That a recording produces a file.
3. That the ownership step is sufficient — that the API can read what egress
   wrote, and delete it.
4. That the egress webhook arrives, verifies, and moves the row to `ready`.
5. That a transcript comes back from whatever you point it at.

The verify script checks the preconditions for all five. **T8 in the test plan
is the test.**

---

## T8 — the test

Run after `connect-recording-verify.sh` passes.

| | Step | Expected | Proves |
|---|---|---|---|
| 8.1 | `bash infra/scripts/connect-recording-verify.sh` | everything OK except the unpinned image | schema, RLS, volume, services |
| 8.2 | Start a meeting, press **Record** | the button turns red; a red banner appears | start, and the notice |
| 8.3 | A **second person** joins mid-recording | they see the banner without doing anything | `isRecording` read on Connected |
| 8.4 | Talk for a minute, press **Stop rec** | the button returns; the banner clears | stop |
| 8.5 | `SELECT status, size_bytes, file_name FROM connect.recordings` | `ready`, non-zero, a bare file name | the egress webhook landed |
| 8.6 | Meeting page → Recordings | one row, a duration, a size, **Download** | the list |
| 8.7 | Press **Download** | the audio plays | the API can read what egress wrote |
| 8.8 | With transcription configured, wait | the row says Transcribing, then Transcribed | the worker |
| 8.9 | Meeting page → Meeting notes | the digest, or a written summary | the notes step |
| 8.10 | Press **Delete** (host) | the row goes; `SELECT SUM(used_bytes) … 'connect'` drops | the API can delete, and the figure is derived |
| 8.11 | Sign in as somebody who was **not** in the meeting, open its page | 404 | `SeenMeetingAsync` |

8.5 and 8.7 are the two that matter. 8.5 is the whole webhook path; 8.7 is the
whole volume-ownership question.

If 8.5 stays `starting`, wait five minutes: the repair pass asks LiveKit
directly and will move it. If it moves after five minutes but not before, the
webhook is not arriving and that is a different bug from recording not working.

---

## What is not built

Named, so none of it is a surprise later.

**Speaker attribution.** `transcripts.segments` reserves a `speaker` key and it
is null. A room-composite recording is one mixed stream and there is nothing
in it to attribute. The right fix is not diarisation — it is LiveKit's
per-track egress, one file per participant, where attribution is exact and
free because LiveKit already knows whose track it is. That costs 0.5 CPU per
participant against 1 for the whole room, so it is a real trade. The column
shape does not change either way.

**Retention.** Nothing expires a recording. An organisation recording every
lesson will fill its pool and the only remedy is a person deleting recordings
by hand. A retention policy needs a per-tenant setting, a purge worker, and
somebody to decide the default — which is a product decision about a
customer's data, not something to slip into a migration.

**An admin screen for the organisation switch.** `allow_connect_recording` is
a SQL UPDATE today. It belongs next to `allow_connect_guests` in the admin
console, which is Core's screen.

**Consent, as opposed to notice.** See decision 3.

**Video from the room UI.** The API takes `mode: 'video'`; no button sends it.
Adding one means putting the cost in front of the person pressing it.

**Recording a meeting nobody has joined.** Refused with "Start the meeting
before recording it." LiveKit can only record a room that exists.

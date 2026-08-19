# Connect — overnight session, 19 August 2026

Everything below is built and proven. Nothing is committed.

**748 assertions pass** (`bash infra/scripts/connect-test.sh`), the API and web
builds are clean, and the migration is proven against a real PostgreSQL 16 with
20 behavioural checks including the cross-tenant read *and* write refusal from
the `NOBYPASSRLS` role.

---

## The short version

Two things you asked for are done — **Picture-in-Picture now shows everyone**,
and **recording downloads work**. The download was broken for a reason worth
knowing: a plain `<a href>` is a navigation, navigations send cookies and not
headers, and this app deliberately keeps the access token out of anywhere a
script can read it. It could never have worked. It goes through a signed ticket
now, the same shape as any object store's pre-signed URL.

Beyond that: the bug that emptied `connect.meeting_events` has been turned into
a class of bug that cannot recur, three more instances of it were found and
fixed, **Minutes of Meeting** is built — a real document, downloadable and
emailed to the people who attended — and **transcription now runs on your own
box**, so the "transcribe, summarise" half of what you described works without
a single second of audio leaving the server.

---

## 1. Unpack

From the repo root:

```bash
tar xzf connect-minutes.tgz
```

Nothing is overwritten that you have changed since your last commit — every
file in the archive was diffed against your working tree first.

## 2. One patch

```bash
git apply infra/patches/connect-minutes-0004-dbcontext.patch
```

Two lines: the `ConnectMeetingChat` DbSet and its table mapping. Verified
against your current `AppDbContext.cs` — it applies clean.

There is no Program.cs patch this time. The new endpoints register themselves
from `MapConnectRecordingEndpoints`, and the mailer is static and takes what it
needs as arguments, so nothing new goes in the container.

## 3. Build and test

```bash
cd apps/api && dotnet build && cd ../..
cd apps/web && npm run build && cd ../..

bash infra/scripts/connect-test.sh
```

That last one is new and it is the one to run before every commit that touches
Connect. It reports anything it could not run on this machine as SKIPPED rather
than passing quietly. On Windows the four underneath it work directly:

```powershell
dotnet run --project tests\connect-wire
dotnet run --project tests\connect-minutes

cd apps\web
node_modules\.bin\tsc lib\pip.ts --outDir ..\..\tests\connect-pip\build --target es2022 --module es2022 --moduleResolution bundler --lib es2022,dom --strict --skipLibCheck
node ..\..\tests\connect-pip\run.mjs
cd ..\..

pip install fastapi "uvicorn[standard]" python-multipart httpx pyyaml
python tests\connect-whisper\test.py
```

## 4. Commit

```bash
git add apps/api/Modules/Connect apps/api/Workers/ConnectNotesWorker.cs \
        apps/api/Shared/Data/AppDbContext.cs \
        apps/web/lib/pip.ts apps/web/lib/connect.ts \
        "apps/web/app/connect/room/[code]/Stage.tsx" \
        "apps/web/app/connect/(shell)/meetings/[id]/Recordings.tsx" \
        local/postgres/init/20260904-connect-minutes.sql \
        infra/patches infra/scripts infra/whisper infra/apply-whisper.py \
        infra/docker tests docs

git commit -m "Connect: minutes of meeting, chat kept, PiP shows the room, and one JSON reader

The webhook handler read LiveKit's createdAt with TryGetInt64. protojson
sends int64 as a string and TryGetInt64 throws on one rather than returning
false, so every event 500'd, LiveKit gave up after five retries, and
connect.meeting_events was empty from the day the module shipped.

ConnectWire now holds every rule about LiveKit's wire format in one file, and
tests/connect-wire feeds it real payloads. A sweep for the same shape found
three more: the notes composer walking choices[].message.content, the notes
worker reading offsets back out of jsonb, and webhook signature verification
reading a JWT's exp one line after the signature check.

Minutes of meeting: one renderer behind the page, the download and an email to
everyone who attended. Chat is kept so it can be part of the record. Sending
is off per organisation until an administrator turns it on.

Picture-in-Picture shows every participant, laid out for the window.
Recording downloads work — a navigation cannot carry an Authorization header,
so they go through a signed ticket.

Transcription can now run on this box: faster-whisper behind the same
OpenAI-compatible contract, CPU-only, off behind a compose profile, so no
audio has to leave the server for notes to say what was said."

git push
```

## 5. Deploy

```bash
ssh deploy@<box>
cd /srv/tatvaos-production
git pull
./infra/scripts/deploy.sh
bash infra/scripts/connect-recording-verify.sh
```

`20260904-connect-minutes.sql` applies itself the way 20260902 and 20260903
did.

**A note on how the migration was proven, and why that proof is not in this
archive.** It was run against a real PostgreSQL 16 with fixtures: two tenants,
six people, guests, a suspended account, chat in both tenants — 20 checks
covering who gets an email and who does not, the three-attempt ceiling, and
the cross-tenant read *and* write refusal from the `tatvaos_app` role. It
passes. It is deliberately **not shipped**, because it INSERTs those fixtures,
and a proof script sitting in `infra/` is a proof script that eventually gets
run on production — the same rule that keeps `tests/isolation/
test-isolation.sh` off the box. Ask and I will send it separately for a
scratch database.

## 6. Transcription on this box — optional, and a decision

Notes work today without it: attendance, who came, how long, and the chat. A
transcript is what adds what was *said*.

```bash
python3 infra/apply-whisper.py .
```

That adds one service, one volume and a production limit, and **starts
nothing** — the service sits behind a compose profile. It refuses loudly if an
anchor is wrong and running it twice is a no-op, same as `apply-compose.py`.

To actually turn it on, in `infra/docker/.env`:

```
COMPOSE_PROFILES=whisper
CONNECT_TRANSCRIPTION_URL=http://whisper:8000/v1/audio/transcriptions
CONNECT_TRANSCRIPTION_MODEL=small
CONNECT_TRANSCRIPTION_LANGUAGE=en
```

then deploy. The first transcription downloads the model, so it takes several
minutes longer than every one after it.

**What it costs.** `small` in int8 on CPU runs about 4–6× faster than real
time on two threads, so an hour-long meeting is ten to fifteen minutes of
background work. That is why the worker does one at a time and why the thread
count is 2 rather than every core: a recording transcribed ten minutes later
is invisible, a live meeting stuttering is not.

**Set the language.** Automatic detection is the single largest source of
nonsense on short or noisy audio — thirty seconds of a quiet room is regularly
detected as Welsh.

**The one thing I could not verify from here.** Docker Hub is not reachable
from where this was built, so I could not confirm the `python:3.12-slim` base
image tag resolves today. Everything else about the service is checked: the
package versions were verified against PyPI, the contract is tested field for
field against what `ConnectTranscriber` sends, and the rendered compose is
asserted — including that the recordings volume is mounted `:ro`, because a
transcription service that can delete recordings is one that eventually will.

## 7. Turn the minutes email on — deliberately

It is **off for every organisation**, by default, and it stays off until you
say otherwise. This is outbound mail about what was said in a meeting, to
people including guests.

```bash
docker compose ... exec -T postgres psql -U postgres -d tatvaos_mail -c \
  "UPDATE core.tenants SET connect_email_minutes = true WHERE name = 'Techvein';"
```

Download and the on-screen minutes work without it. Only the automatic email
is gated.

---

## What changed, and why

### The bug, made impossible

`ConnectWire.cs` is the only place that reads LiveKit's JSON now. Five rules,
each learned expensively, written down once:

1. **int64 is a string.** protojson quotes 64-bit fields. int32 fields are
   plain numbers — which is why a payload can look entirely reasonable while
   the one field you care about is quoted.
2. **`TryGetInt64` and friends throw on the wrong kind.** A `TryGet` that
   throws is a trap.
3. **Names are lowerCamelCase, and snake_case is accepted too.** Betting on
   one spelling compiles either way.
4. **Egress timestamps are nanoseconds; the envelope's `createdAt` is
   seconds.** Same message, two units, both large numbers.
5. **Every field is optional.**

`LiveKitEgressClient` and `ConnectWebhookEndpoints` both read through it, and a
**fourth** copy of the egress-status mapping — inline in the notes worker's
repair pass — is gone.

`tests/connect-wire` compiles the real `ConnectWire.cs` (linked, not copied)
and feeds it real payloads: **612 assertions, 153 of them run four times over
`th-TH`, `de-DE` and `ar-SA`** so that the day somebody drops `InvariantCulture`
it is caught rather than discovered.

### Three more of the same bug

| Where | What it did |
|---|---|
| `ConnectNotesComposer.ChatContent` | `TryGetProperty` on a `choices` array of strings **throws**, and the catch only handled `JsonException`. It would have killed the notes worker for every meeting queued behind it. Some local llama.cpp front-ends answer exactly that way. |
| `ConnectNotesWorker.ReadSegments` / `ReadAttendance` | `TryGetDouble` / `TryGetInt64` with no kind check, on jsonb we wrote ourselves — and the self-hosted Whisper you asked for quotes its offsets. |
| `LiveKitTokenService.VerifyWebhook` | `exp` read with `TryGetInt64`, one line after the signature check. The same bug, on the security path. |

`LiveKitRoomClient` now deserialises with `NumberHandling.AllowReadingFromString`,
so the day somebody adds a `long` to those typed classes it keeps working.

### Minutes of Meeting

`ConnectMinutes.cs` is **one renderer** feeding three surfaces: the page, the
downloaded file, and the email. Three renderers would drift, and this module
has already paid for two copies of one fact.

It is email-safe by construction — nested tables, inline styles, no `<style>`
block, no flexbox — because Outlook renders through Word and Gmail strips style
blocks. The same markup opens fine in a browser and prints acceptably, which is
what lets it be the download too.

It says what it does not know:

- a mechanical digest says *"nothing here was written by a person"*;
- a model summary names the model and says it can be wrong;
- an unrecorded meeting says so, in those words;
- attendees with no address on this platform — guests — are **counted in the
  document**, so a recipient list never silently omits half the room.

Everything from a person or a model is HTML-encoded. A meeting titled
`<script>` is not an attack anybody planned; it is a Tuesday.

**48 assertions** cover it, including that absent facts produce no empty
headings and that timestamps land in the organisation's clock rather than UTC.

### Chat is kept

`connect.meeting_chat`, RLS enabled *and* forced, scoped through the meeting.
The transport is unchanged — chat still rides LiveKit's data channel, which is
the right place for it — and a copy is stored so it can be part of the record.
Fire-and-forget: a flapping API costs a line in the minutes, never a broken
chat.

Guests cannot post to the API, so a guest's line is stored by exactly one
signed-in client: the one whose identity sorts first. No election, no messages
— every client computes the same answer from the same room. When that is
briefly wrong, a unique index on `(meeting_id, client_id)` makes it harmless.
Proven: five clients storing one line leaves one row.

**One thing for you to decide.** Storing a guest's line means this endpoint
accepts *"here is a line from somebody who is not me"*. The rule is: your own
line always, a **guest's** line in a meeting you were in, and never a line
attributed to another signed-in person. So the worst anyone can do is put words
in a guest's mouth. I think that is the right place for the boundary, but it is
a judgement about your product and it belongs in the same review as the
anonymous guest join path.

### Picture-in-Picture shows the room

Everyone, tiled, re-laid out whenever the window changes size or shape. The
column count is computed for the window rather than fixed, a shared screen
takes a band across the top and is fitted rather than cropped, someone speaking
gets a ring, a camera that is off shows their initial, and when the window is
too small for everyone it says **"+3 more"** rather than drawing three more
smudges.

It reconciles by hand, because React's event system does not survive being
re-parented into another window. That is where the two invisible bugs live —
rebuilding restarts every video, and dropping a tile without detaching leaks a
decoder — so `tests/connect-pip` drives the real compiled `pip.ts` against a
fake DOM and asserts the **order** of attach/detach calls and that nothing is
left attached off-screen. **37 assertions.**

### Transcription on this box

`infra/whisper/` is a small FastAPI service in front of faster-whisper that
speaks the exact `/v1/audio/transcriptions` contract `ConnectTranscriber`
already sends. CPU-only, int8, two threads, one request at a time, and behind
a compose profile so an ordinary deploy neither builds nor starts it.

It is deliberately not a general OpenAI-compatible server. It implements the
one request this platform makes and says so, because a shim that pretends to
be a whole API is a shim somebody points a second client at.

Two details worth knowing:

- **VAD is on.** A recording of a class is mostly silence and room tone, and
  without voice-activity detection Whisper hallucinates confidently into the
  gaps — the classic *"thank you for watching"* at the end of every quiet
  stretch. Those inventions would end up in the minutes as fact.
- **The `model` field is accepted and ignored.** The container has one model
  loaded; honouring the field would mean loading a second on a box that is also
  running the SFU. The caller sends it because the contract requires it, and
  pretending to switch would be worse than plainly not switching.

**51 assertions** cover it: 35 on the contract — built field for field from
`ConnectTranscriber.cs`, with faster-whisper faked because the thing under test
is the contract — and 16 on what compose actually *renders*, which is not the
file on disk.

### The uid-1000 mistake, again

`connect-recording-verify.sh` still hardcoded gid `5000` and the volume name
`tatvaos_connectrec` — the same shape as the uid bug, in the same file, directly
underneath the comment explaining why that shape is wrong. It happened to be
right, which is the only reason it did not cost a second night. Both are now
asked for: the gid from the api container, the volume from the egress
container's mounts.

---

## Facts checked against your schema, so nobody re-guesses

- `core.users` has **no `deleted_at`** — it has `status`
  (`pending|active|suspended|deleted`). The first draft of the recipient
  function used `deleted_at` and would have failed the migration outright.
- `core.tenants` has **no `slug`** — it has `name`.
- `connect.participants` is unique on `(meeting_id, user_id)`, so a signed-in
  person is one row however many times they rejoin.

---

## Still open

- Speaker attribution needs per-track egress (0.5 CPU per participant against
  1 per room).
- Retention: nothing expires a recording.
- Consent versus notice — a product decision, not a technical one.
- Core's review of the anonymous guest path, and deleting `/connect/dev`.

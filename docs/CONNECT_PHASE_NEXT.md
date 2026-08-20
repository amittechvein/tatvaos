# Connect — the next phase, as decided 19 August 2026

Five rulings from Amit, and what each one actually means to build. Written by
Connect; the rulings are Amit's, the implementation notes are mine and are
open to argument on the how, not the what.

Ordered as I would build them: cheapest and most certain first, purchases
last.

---

## 1. Meeting mode — Private (E2EE) or Recorded

**Decided.** One choice at creation, and it decides everything downstream:

| | 🔒 Private | 🎥 Recorded |
|---|---|---|
| End-to-end encryption | ✅ | ❌ |
| Recording / auto-record | ❌ | ✅ |
| Transcription | ❌ | ✅ |
| AI notes | ❌ | ✅ |
| Recording notice | — | ✅ |

Attendance, chat, and minutes-from-attendance still work in a Private
meeting: none of them touch media. A Private meeting gets minutes that say
who came and what was typed, and say plainly that nothing was recorded —
the third provenance sentence added in 20260906 already covers it.

### What this means to build

**`meetings.mode`**, `'recorded' | 'private'`, **default `'recorded'`** so
every existing meeting keeps behaving exactly as it does today. CHECK
constrained, like `share_policy`.

**The mode is enforced server-side, not by hiding buttons.** `mode='private'`
makes `StartAsync` refuse with a sentence, makes the `auto_record` flag
inert in the `room_started` webhook, and stops a transcript ever being
queued. A client that asks anyway gets 409, not a recording.

**The room is created with E2EE on** and the web client enables it through
LiveKit's key provider. Which brings the one thing that has to be decided
before this is promised to anybody:

### ⚠️ Two different things are called "end-to-end encrypted"

**A. The media server cannot see it.** TatvaOS mints the room key and hands
it to each participant with their join token. The SFU forwards packets it
cannot decode; nobody on the media path can listen. This is what almost
every product means by E2EE, and it is genuinely strong — but our API
touched the key, so *in principle* TatvaOS could have kept it.

**B. Nobody outside the room can see it, including us.** The key never
exists on our servers: the host sets a passphrase and shares it out of band
(WhatsApp, in person, the invitation), and each participant types it to
join. We cannot decrypt even if compelled to.

**Recommendation: build A as the default and offer B as an option**, with
the two labelled differently and honestly — "Encrypted (the meeting server
cannot see or hear this meeting)" versus "Private key (nobody but the people
in the room, not even TatvaOS — everyone needs the passphrase)". A is
usable by ordinary people; B is what a lawyer or a hospital will ask for,
and it costs a passphrase field and a sentence.

**What must not happen** is calling A "end-to-end encrypted" in marketing
without the qualifier. A customer who reads that as B and later learns the
key came from our API has been misled, and this platform's whole style is
saying what it does not know.

### Verify before promising, do not assume

- **Browser support.** LiveKit's E2EE relies on browser APIs for inserting
  a transform into the media pipeline; support is good on Chromium and
  recent Safari and less certain elsewhere. **Test the actual browsers our
  customers use, including an older Android phone and Firefox, before
  offering Private meetings.** A guest who cannot join a Private meeting
  must be told why, in words, not left with a black screen.
- **What else breaks.** Anything server-side that reads media is off by
  definition. Confirm on a real call that the SFU's bandwidth adaptation
  and the participant-facing controls still behave with E2EE on.

**Effort:** ~2 days for mode A end to end, plus a day for the passphrase
variant. No purchase.

---

## 2. AI notes on our own server

**Decided.** `TatvaOS Connect → internal API → our own AI server`. The same
shape as `infra/whisper/`, which already proves the pattern: an open model,
self-hosted, speaking a standard API, no audio leaving the building.

### What this means to build

**Nothing in Connect changes.** `ConnectNotesComposer` already speaks
`/v1/chat/completions` and switches from `digest` to `model` the moment
three settings are filled in:

    Connect__Recording__NotesUrl    http://ai:8000/v1/chat/completions
    Connect__Recording__NotesKey    (whatever the server wants, if anything)
    Connect__Recording__NotesModel  the model name

So this is an **infrastructure and hardware task**, not an application one:
`infra/ai/` alongside `infra/whisper/`, behind its own compose profile,
serving an open-weights model through vLLM or llama.cpp.

**It needs its own machine, with a GPU.** Not the SFU box — that is already
carrying media, and a language model will fight it for CPU exactly when a
meeting is live. A single 24 GB GPU runs a 7B–14B model comfortably and
summarises an hour-long meeting in a couple of minutes. CPU-only is
possible but slow enough on a long transcript that it changes the design.

**Expect the first honest disappointment to be structure, not fluency.**
Open models in this class write good summaries and are less reliable at
"decision → owner → deadline" with correct attribution. Mitigations, in
order of value: a strict output schema rather than free prose; one focused
prompt per section instead of one prompt for everything; the largest model
the GPU will hold. **Measure against real transcripts before promising
owners and deadlines to a customer** — and note that the notes already
label themselves `digest` or `model`, so the fallback stays truthful while
we tune.

**Effort:** a day to package the service once the hardware exists. The
hardware is the decision.

---

## 3. Speaker attribution from what the SFU already knows

**Decided,** and this is the design: record who is speaking with timestamps,
then match against the transcript's timings.

    10:01:12  Amit speaking
    10:01:18  Amit stopped
    10:01:19  Rahul speaking
    10:01:24  Rahul stopped

    Whisper: 10:01:13–10:01:17  "Let's approve the project."
    → attributed to Amit

This costs **no extra CPU on the media path** — the SFU already computes
active speakers, and `Stage.tsx` already listens to `ActiveSpeakersChanged`
to draw the speaking ring. We are writing down something we are already
being told.

### What this means to build

**`connect.speaker_spans`** — its own narrow table, not `meeting_events`.
Speaker changes are frequent (a lively ten-person meeting produces
hundreds an hour), and `meeting_events` carries a raw jsonb payload per row
for a different purpose. Columns: meeting, identity, started_at, ended_at.

**One client relays, batched.** The same rule already proven for guests'
chat lines: the signed-in participant whose identity sorts first. It buffers
spans and posts every ~10 seconds rather than per transition — a POST per
speaker change would be a request every couple of seconds per meeting for
no benefit.

**⚠️ The clock problem, which decides whether this works at all.** Whisper's
segments are offsets from the *start of the recording*; the relay's spans
would be *the relaying browser's wall clock*. Network jitter is ~100 ms and
harmless. A browser whose clock is thirty seconds off would mis-attribute
the entire meeting, silently, and produce minutes that put words in the
wrong person's mouth — which is worse than no attribution at all.

So: **the server stamps the time.** The relay sends spans as offsets from a
reference the API returns when the relay starts, and the API converts them
against its own clock — the same clock `recordings.started_at` came from.
The browser's own clock is never trusted for anything that reaches the
minutes.

**Where it will be wrong, and what to do about it.** Two people talking at
once; a Whisper segment that straddles a speaker change; a meeting where
everybody is a guest (nobody can relay). Attribution should therefore be
**per segment and optional** — a segment with no confident speaker stays
unattributed rather than being guessed, and the transcript view says
"unattributed" for those rather than picking whoever was nearest. The notes
should say attribution is automatic and can be wrong, in the same sentence
style everything else here uses.

**Measure it before extending it.** If a real meeting comes out ~85% right,
that is likely enough for a class register and a set of minutes. If it comes
out at 60%, per-track egress is the answer and we will have the numbers to
justify the CPU — roughly 0.5 per participant against 1 for the whole room.

**Effort:** ~3 days including the measurement. No purchase.

---

## 4. Multiple screen sharers — the host chooses

**Decided.** Both behaviours ship; the host picks per meeting.

### What this means to build

**`meetings.share_mode`**, `'multiple' | 'single'`, **default `'multiple'`**
— today's behaviour, which is deliberate and tested (feature 71). It sits
next to `share_policy`, which is a different question: *who may* share
versus *how many at once*.

**Enforcement uses machinery that already exists.** The share-policy work
in 20260905 added `SetPublishSourcesAsync`, which narrows a connected
participant's publishing grant live. In `single` mode: when somebody starts
sharing, remove `screen_share` from everyone else's grant; when they stop,
restore it. The UI follows by saying "Ravi is sharing" rather than offering
a button that will be refused.

**One thing to know before writing it.** This needs the API to notice a
screen share starting — which means handling `track_published` and
`track_unpublished`, and those are the two events
`ConnectWebhookEndpoints` deliberately ignores today. They are also the
events whose healthy `200 OK`s made the webhook log look fine for a day
while everything that mattered was failing (§5.5 of the handover). Handling
them is correct here, but it changes what that log means — and the ignore
list exists for a reason, so filter to screen-share tracks only and leave
camera and microphone churn ignored.

**Effort:** ~2 days.

---

## 5. Recording consent — notice only

**Decided.** Participants are *told*, not asked. That is what ships today:
a non-dismissible on-screen banner driven by the SFU's own room flag, plus
the spoken "This meeting is being recorded." for the joiner.

**Recorded for the future, not as an argument.** I am not a lawyer, and in
some jurisdictions recording without agreement is a legal question rather
than a design one — most sharply where the meeting involves children or
health. If that is ever raised by a customer or by counsel, the technical
work is small: a checkbox on the pre-join screen and refusing to mint the
token without it. The decision is made; this note exists so nobody has to
rediscover the cost of changing it.

---

## Order of work, and what needs money

| | Work | Purchase |
|---|---|---|
| 1 | Meeting mode (Private / Recorded), mode A | none |
| 2 | Multiple-vs-single sharers | none |
| 3 | Speaker attribution + measure it | none |
| 4 | Private-key (passphrase) variant | none |
| 5 | AI notes on our own server | **a GPU machine** |
| 6 | Per-track egress, only if 3 measures badly | **CPU on the SFU box** |

Everything above 5 can start now. The AI box is the one decision with a
price on it, and the speaker-attribution measurement is what tells us
whether a second one is needed.

# Connect — decisions taken, and what they mean to build

Amit's rulings, written down so they do not have to be asked again. Each one
is a product decision that was blocking work; the implementation notes under
each are Core's, and are open to argument on the how, not the what.

---

## 1. Recording retention — 19 August 2026

**Decided.** Recordings are no longer kept forever. An organisation chooses one
of five retention periods:

| Option | Keep for |
|---|---|
| 7 days | a week |
| 30 days | a month |
| 90 days | a quarter |
| 180 days | half a year |
| 365 days | a year |

### What this means to build

**A per-organisation setting**, `core.tenants.connect_recording_retention_days`,
one of `7 | 30 | 90 | 180 | 365`. Not free-form: a text box invites `1` and
`3650`, and both are somebody's bad day.

**Default 90 days.** Long enough that nobody loses a recording they were still
going to watch, short enough that the disk does not fill while nobody is
looking. Amit to overrule if he wants a different starting point — but there
must *be* a default, because a tenant row that predates this setting has to
mean something.

**Deletion is real deletion.** The blob is removed from the volume, the
`connect.recordings` row moves to `deleted` (kept — the row is the record that
a recording existed and was disposed of), the transcript and notes follow the
same rule, and `core.user_storage` is reconciled so the organisation actually
gets its space back. A retention policy that frees no disk is decoration.

**A sweep in `ConnectNotesWorker`**, not a separate service — it already wakes
once a minute and already owns the recording lifecycle. Delete in batches with
a ceiling per pass; a first run against a year of recordings should not be able
to saturate the disk queue on a box that is also delivering mail.

**Audit every deletion** to `core.audit_logs` with `productCode: "connect"`.
When a customer asks where their recording went, the answer must be a row, not
a shrug.

**Warn before the first deletion.** When an organisation shortens its retention
— say from 365 to 30 — the change must say how many existing recordings that
will destroy, and require a second confirmation. Shortening retention is a bulk
delete wearing a dropdown.

**Decided and built — "keep this one" exists.** A per-recording
`connect.recordings.keep_until_at`, honoured by the retention sweep and by the
share-expiry trigger. *This paragraph said "not decided, and needed before this
ships" until 13 September 2026, five days after the column had shipped and
been proven; the Connect welcome flagged it and the correction is house rule 8
inverted — a document behind the code is how a thing gets built twice.*

---

## 2. The recording notice — 19 August 2026

**Decided.** When someone joins a meeting that is being recorded they are told
**both ways**:

- **Written** — the existing non-dismissible on-screen notice stays.
- **Spoken** — they hear the sentence *"This meeting is being recorded."*

**The exact words are "This meeting is being recorded."** Nothing else, no
variation.

### What this means to build

**Only the joiner hears it.** It plays locally on the joining client. It does
not go into the room, so it is not in the recording, it does not interrupt
whoever is talking, and it does not fire again for the eleven people already
there. Every person hears it exactly once, when they arrive.

**Ship an audio file; do not synthesise it.** The Web Speech API's voices vary
by browser and operating system and are absent on some Android builds, which
means the one sentence that has to be heard is the one that silently is not.
A short static clip in `apps/web/public/` is deterministic and about 20 KB.

**Autoplay will not block it, but check.** Browsers refuse audio without user
activation; clicking Join is that activation, and the page already holds a
microphone permission. Verify on Safari specifically — it is the strictest and
it is what iPhone guests will use.

**It must survive recording starting mid-meeting.** If the host starts
recording twenty minutes in, everyone already in the room hears it then. The
trigger is "recording became active for me", not "I joined".

**Accessibility, and it is not optional here:** the written notice must carry
`role="status"` so a screen reader announces it, since a person using one may
not hear an audio cue in a separate channel. Both notices exist because a
person might miss one of them.

### Why it is worded exactly this way

It is a **notice**, not a request for consent. Whether participants must
actively *agree* before joining a recorded meeting is a separate decision,
still open, and it is the one that matters legally for schools and clinics.
Do not let the audio cue be mistaken for having settled it.

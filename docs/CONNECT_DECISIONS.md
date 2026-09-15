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


> **Update, 12 September 2026 — this question is closed.** A per-recording
> exemption exists: `connect.recordings.keep_until_at`. The sweep honours it,
> and so does the expiry trigger on recording shares, which caps a link's life
> at `COALESCE(keep_until_at, created_at + retention)` so a share can never
> outlive the file it points at. The recommendation above was taken; the
> document had not caught up. — Connect

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

---

> **Update, 12 September 2026 — the shipped behaviour contradicts this ruling,
> and the reason it was ruled matters.** The clip was never recorded, and
> `Stage.tsx` falls back to the Web Speech API — the exact thing the paragraph
> above rules out, for the exact reason it gives: voices vary by browser and
> operating system and are absent on some Android builds. So a guest on an
> affected Android build currently hears **nothing**, while the written notice
> states they were told.
>
> This is not a documentation problem. It is a ruling being quietly broken in
> production, and it had been sitting on Connect's board as "needs a voice" —
> filed as a nicety rather than as a decision going unhonoured. It needs 20 KB
> of recorded audio saying "This meeting is being recorded." and nothing else.
> — Connect

---

# Added by the Connect lane, 12 September 2026

Sections 1 and 2 above are Amit's rulings written up by Core. What follows is
the same kind of record for decisions taken between 26 August and 12
September: some are rulings (3 and 6 are the CTO's), some are findings that a
future session would otherwise have to rediscover by breaking something.

Two of the sections above carry an update from this date, marked as such and
placed where a reader of that section will see them. Core's words are
unchanged.


## 3. Recording sharing — the capability is OFF, and this matrix is the condition

Recording sharing is deployed and inert. Tables, RLS, four levels, the
organisation switch and all the routes are live in production as of
`172d83f`. The Share button does not render, because `Recordings.tsx` shows it
only when the recordings list carries a `sharing` capability and **no API code
emits that field**. Emitting it is one line.

**Do not write that line until every case below has been run and the result
shown.** Not reasoned about — run, against a deployed system, with the output
kept. Public links to recordings are the most exposed surface this product
would have; the CTO's standard for entitlements applies here and this is it.

The cases can all be exercised today. The endpoints exist and take ordinary
HTTP; none of this needs the button.

### The matrix

| # | Case | Must happen | Why it is in the list |
|---|---|---|---|
| 1 | Link holder with no session at all | Level `public` resolves only if the org switch is on; `password` requires the password; `organisation` and `named` refuse | The whole point of the feature |
| 2 | Revoked share | Refused. No row returned, not a row with a flag | A caller that forgets to check a flag leaks; one that forgets to check for no rows gets a null reference |
| 3 | Expired share | Refused, same shape as revoked | — |
| 4 | Suspended organisation | Refused | Not implemented in `resolve_share_token` today — see below |
| 5 | Wrong recording | A share for recording A must not authorise recording B, even in the same meeting | `meeting_id` is denormalised onto the share for exactly this check |
| 6 | **Participant with no share at all** | **Still reads the recording** | The baseline never moves. `SeenMeetingAsync` decides it and nothing here may override it. The likeliest invariant for a future change to break |
| 7 | **Named grant across organisations** | Reader in tenant B reads a recording owned by tenant A, and **cannot list who else it was shared with** | The only reason `share_for_user` is SECURITY DEFINER. The second half is enforced by what the RLS policy omits, which makes it invisible |
| 8 | **The switch flipped off while a link is live** | The existing link stops resolving immediately; the row is not deleted; flipping back on resumes it | Read-time enforcement. Verified by me in a sandbox, never against the deployed system |
| 9 | **An anonymous read is logged** | A row appears in `recording_access_log` with the tenant, recording and level taken from the share, `subject_user_id` NULL | Not an authorisation outcome, so nobody thinks to test it — and a public link with no record of who opened it is the failure that matters after the fact |

Cases 1–5 are the CTO's. **6 to 9 are mine, from writing the code**, and they
are the ones the next owner would not derive from the endpoint signatures.

### Case 4 is not implemented, and saying so is the point

`connect.resolve_share_token` checks revocation, expiry and the organisation's
`allow_public_recording_links`. It does **not** check whether the organisation
is suspended. If suspension is meant to stop a public link resolving — and it
probably is — that clause does not exist yet. I did not add it because I could
not find where suspension is represented and would have been guessing at a
column, which is the same mistake that kept this feature blocked for two weeks.

Run case 4 expecting it to fail. A matrix whose every row passes on the first
attempt has usually been written to match the code.

### What enforces what

Two enforcement points and they are not equivalent.

**Share time**, in `CreateAsync`: refuses to create a `public` share when the
switch is off. This is a courtesy — it stops somebody generating a link that
would never work.

**Read time**, inside `connect.resolve_share_token`: refuses to resolve a
`public` token at all. This is the security. It lives in the definer function
rather than the download route because the anonymous path reaches these tables
through that function and nothing else — a condition in a route is one the
next route can forget.

Turning the switch off does not delete anything. Live `public` rows stay,
stop authorising, and resume if it is switched back on, with the gap visible
in `recording_access_log`.

### Where the pieces are

- Migration and every design decision, each recorded beside the code it
  decided: `local/postgres/init/20260908-b-connect-recording-shares.sql`
- Endpoints, the share-time check and the three audit writes:
  `apps/api/Modules/Connect/Endpoints/ConnectShareEndpoints.cs`
- The switch: `connect.tenant_settings.allow_public_recording_links`,
  default **false**, no backfill. A missing row reads as off.
- Client, already shipped and waiting: `Recordings.tsx`, `list.sharing`

---

## 4. Guest removal does not remove a guest

`connect.meeting_blocks` keys on `user_id` and a guest has none — their
identity is minted fresh at every door. A removed guest returns through the
same link, and only the waiting room stops them. The Removed-people list
labels this per row; the Remove button does not, and means two different
things depending on who it is pointed at.

## 5. `DUPLICATE_IDENTITY` is a consequence, not a decision

Connect mints `user:<uuid>` as a participant identity — stable and keyed to the
account, because roles, blocks and the baseline all key on the person rather
than the session. LiveKit disconnects an earlier connection holding the same
identity. So a second device kicks the first, and **nobody decided that**; it
falls out of an identity scheme chosen for other reasons. It cost the Mobile
lane time twice.

Changeable: a per-session suffix would allow two devices, and
`connect.meeting_blocks` keys on `user_id` rather than identity so blocking
would survive. What breaks is anything assuming one participant row per person
per meeting.

## 6. `departureTimeout` stays at 20 seconds — proposed and withdrawn

Proposed at 120 on 8 September, withdrawn on the 12th. The harm being argued
against — a group losing connectivity for over 20 seconds, the room closing,
and the meeting being permanently unreopenable — stopped existing when Reopen
shipped on the 8th. The proposal outlived its reason.

Three reasons not to raise it, each sufficient alone. Egress stops when the
room closes, so every recording would gain up to 100 seconds of empty room and
`ready` would arrive that much later. A meeting already reads as live for
~50 seconds after the host leaves; this makes that guaranteed to be two
minutes. And `empty_timeout` (300s) governs a room nobody ever joined, which
is a different question that should not move with this one.

**The condition for revisiting**: measure how long a real group drop actually
lasts. Not "raise it a bit".

`infra/docker/livekit.yaml` sets neither value — 20 and 300 are LiveKit's own
defaults, confirmed by the CTO on 12 September.

## 7. The chime burst threshold is a measurement, not a code change

`CHIME_BURST_MAX = 4` and `CHIME_BURST_WINDOW_MS = 10_000` in `Stage.tsx` are
provisional, and the comment beside them is a standing review condition:
measure it in a real meeting and report the number rather than defend a guess.
The `console.info` in `chime()` prints how many tones played and how many were
suppressed. Somebody needs to be in a real meeting with the console open at
the moment people arrive.

Listed as available work for two days before it became clear it cannot be done
from a code editor.

## 8. Two layout bugs, diagnosed, unfixed

**Tiles are the wrong shape in the gallery.** `bestColumns` picks the column
count that yields the largest 16:9 tile in a cell; the CSS then sets
`width:100%; height:100%; aspect-ratio:auto`, so the tile takes the cell's
shape instead and `object-fit:cover` crops faces. The algorithm optimises for
a shape nothing enforces. Fix: pass the tile width `bestColumns` already
computed to CSS and size the tile from it.

**The room is taller than the window with the People panel open** — the second
tile and the left toolbar are both clipped. Different cause, undiagnosed. The
question that separates the two possibilities: with the panel open, does the
page scroll, or is it simply clipped?

# Connect — what changed on 18 August, second half

Built on top of `dc7ddf1`. Everything below compiles: `dotnet build` clean, and
a real `npx next build` with your `tsconfig` and `eslint.config.mjs` clean —
zero warnings from any Connect file. Every SQL claim was run against a real
PostgreSQL, not reasoned about.

---

## 1. The notes taker now produces something for every meeting

**The problem with what I shipped this morning.** Notes required a transcript.
A transcript requires a transcription service. Transcription is off by default,
because audio must not leave the box until you decide it may. So "automatic
meeting notes" produced **nothing at all**, for every meeting, on a fresh
deployment — and would have kept producing nothing until you bought or
deployed an STT service.

That is the wrong shape. The platform already knows, with no media involved
whatsoever: who was invited, who actually turned up, when they arrived, when
they left, how long they stayed, and how many times they came back. For a
school checking who attended a class, **that is the meeting record**. A
transcript should make it better, not be what makes it exist.

So notes are now written for **every ended meeting**, transcript or not.

### Where the numbers come from, and why it is two sources

| | |
|---|---|
| **Who** | `connect.participants` — written by the API at join time, so it is certain and does not depend on a webhook arriving |
| **When and how long** | `connect.meeting_events` — the media server's account, accurate but losable |

Names from the certain source, durations from the accurate one. When the event
log is empty the notes still list who attended and say plainly that timings
are unavailable, rather than claiming nobody came. That matters right now,
because your event log has only just started receiving webhooks.

### The duration maths, and why it is not first-to-last

Somebody who joins at 10:05, leaves at 10:15, comes back at 10:35 and leaves
at 10:55 was present for **thirty minutes, not fifty**. An attendance figure
that cannot tell those apart is worse than none, because somebody will use it
to mark a register.

Proven against real Postgres, with the awkward cases deliberately included:

```
 display_name | joined_at | left_at | seconds | joins
 Asha         | 10:00     | 11:00   |    3600 |     1   never left, no leave event
 Ravi         | 10:05     | 10:55   |    1800 |     2   naive first-to-last says 3000
 Guest Meera  | 10:10     | 10:20   |     600 |     2   a MISSED leave, not double counted
 Silent Sam   | 10:30     | 11:00   |       0 |     0   API saw him; not one webhook did
```

Silent Sam is the case that matters most today. He appears.

### What else changed with it

- The worker no longer switches itself off when recording is disabled. The
  recording half needs egress; the notes half needs nothing.
- When a transcript **does** land, attendance-only notes are put back in the
  queue and rewritten with it. The better version arrives on its own.
- `pending_notes` waits while a transcript is queued or running, so you never
  see attendance-only notes replaced ten minutes later — which would read as
  the notes changing their mind.
- The meeting page shows a **Who attended** table above everything else, and
  the card now says "From attendance only — this meeting was not recorded"
  rather than implying something failed.
- The notes card is no longer hidden on servers with no egress. It used to
  return early and take the notes with it.

**This also answers "how do I test the notes half without an STT service":**
you no longer need one. Every ended meeting on your box should grow notes
within a minute or two of ending. That exercises the whole worker — the
cross-tenant queue, the tenancy sync, the writes — with nothing external.

---

## 2. Picture-in-Picture — "auto popup when I switch away"

Your ask, and there is one thing about it worth knowing because it is the
reason most people implement it wrong.

**You cannot open a PiP window on a tab switch by yourself.** `requestWindow()`
needs transient user activation, and switching away from a tab is not a gesture
in that tab. Listening for `visibilitychange` and calling it there fails, every
time, silently.

The supported route is the mediaSession action `enterpictureinpicture`:
**Chrome invokes it for you** when the user leaves a page that is capturing
camera or microphone — which a meeting always is — and inside that handler the
call is permitted. That is the mechanism behind "it pops out on its own" in
every product that does it.

What you get:

- Switch to another window mid-meeting and a small floating window appears,
  showing the shared screen if there is one, the person talking otherwise.
- Two buttons in it: **Mute** and **Back to meeting**.
- A **Mini** button in the control bar for when you want it on demand.
- Coming back to the tab closes it.
- Safari and Firefox get video-element PiP as a fallback; the button hides
  entirely where nothing is supported, rather than being a button that does
  nothing.

Three implementation notes, since they are the traps:

1. **React's DOM is never moved into the PiP window.** It is the obvious
   implementation and it silently breaks every event handler in the moved
   tree, because React attaches listeners to the root container's document.
   Instead the window gets plain elements and LiveKit attaches the track to
   them — a track can be attached to several elements at once.
2. The mute button reads the microphone's state **from the SDK**, not from
   React state. The handler is created once and would otherwise close over the
   first render's value and toggle the wrong way for the rest of the meeting.
3. `documentPictureInPicture` and the `enterpictureinpicture` action are both
   absent from TypeScript's `lib.dom`. `lib/pip.ts` declares the narrowest
   thing that compiles.

---

## 3. Six features from your list of 73

| # | | |
|---|---|---|
| **42** | Speaker selection | The Settings panel had camera and microphone and stopped there — which looks finished. `audiooutput` + `switchActiveDevice`, which moves the whole meeting to the chosen speaker. Firefox does not implement it; the panel says so rather than showing an empty list |
| **69** | Share system audio | `{ audio: true }`. Without it, sharing a video is silent, which everyone reports as broken rather than as missing |
| **71** | Multiple presenters | Was `.find()`, so a **second person sharing was silently invisible** — worse than refusing them, because nobody could tell. Now every sharer gets a tile |
| **49** | Network quality | Appears **only** when a connection is poor or lost. An indicator that is green 99% of the time is furniture, and furniture is not read on the day it matters |
| **62** | Raise hand | Over the existing data channel — no backend, no schema. Badge on the tile, hands sorted to the top of the People list, count on the People button |
| **58** | Disable participant camera | The API has taken `kind: 'audio' \| 'video'` since it was written and the UI only ever sent `audio`. One argument away the whole time |
| **64** | Participant search | Appears once there are more than six people. Trivial, and the only usable way through a class of forty |

One bug found while in there: the People panel said **"Speaking"** for anybody
merely unmuted, so a silent room read as everybody talking at once.

---

## Deploy

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
dotnet build apps/api
pnpm build

git apply infra/patches/connect-recording-0003-attendance-jsonb.patch

git add apps/api/Modules/Connect apps/api/Workers apps/api/Shared/Data/AppDbContext.cs
git add apps/web/lib apps/web/app/connect
git add infra/scripts/connect-recording-verify.sh infra/patches
git add local/postgres/init/20260903-connect-notes-attendance.sql
git add docs/CONNECT_2026-08-18-SESSION.md

git commit -m "Connect: notes that exist without a transcript, picture-in-picture, and six features off the list

Notes required a transcript, a transcript requires a transcription service, and
that is off by default because audio must not leave the box - so automatic
notes produced nothing at all for every meeting. Who attended and for how long
is a meeting record in its own right. Names come from connect.participants,
which the API writes at join time and is certain; timings come from
connect.meeting_events, which is accurate but losable. Durations pair joins
with leaves rather than subtracting first from last: somebody who leaves for
twenty minutes and comes back was not present for the gap.

Picture-in-picture pops out when you switch away. It goes through the
mediaSession enterpictureinpicture action, because requestWindow needs user
activation and a tab switch is not one - a visibilitychange handler fails
silently every time. React's DOM is never moved into the PiP window; the track
is attached to plain elements there instead.

Features 42, 49, 58, 62, 64, 69 and 71. 71 was the worst of them: screen
shares used .find(), so a second person sharing was silently invisible."

git push
```

Then on the box:

```bash
cd /srv/tatvaos-production
git pull
./infra/scripts/deploy.sh production
bash infra/scripts/connect-recording-verify.sh
```

Watch for `[ ok ] 20260903-connect-notes-attendance.sql`.

The verify script gained four checks: the two new columns, `connect.attendance()`,
that `pending_notes` no longer requires a transcript, and a count of how many
ended meetings have notes — which warns if meetings have ended and none has.

---

## Still open

- **The recording write.** Your last report was `permission denied` on the
  egress uid. The fix and the improved check went out in `dc7ddf1`; I do not
  know yet whether it worked, or what uid egress actually is. That is the one
  number I would like back.
- **Speaker attribution in transcripts.** Still null. Needs per-track egress,
  which is a real trade — 0.5 CPU per participant against 1 for the room.
- **Consent, as opposed to notice.** Unchanged and still a product decision.
- **Retention.** Nothing expires a recording yet.

# Connect — feature audit against the 73-item list

Audited 2026-08-17 against the committed tree at `0acdb39`, by reading the code
rather than from memory. Where a row says "not built" I checked for it and
found nothing; where it says "partial" the gap is named.

## The scale

| | meaning |
|---|---|
| **Done** | Built AND observed working — on production, or in a browser, or by a passing test |
| **Built** | In the tree and compiles, never exercised. This is not the same as done |
| **Partial** | Some of it works; what is missing is stated |
| **Not built** | Nothing exists |
| **Core** | Belongs to the Core product, not Connect — Connect inherits it |

The distinction between **Done** and **Built** is the whole point of this
document. Two bugs this week were in code that compiled, deployed, and did
nothing: the webhook answered 200 while writing no rows, and the organiser's
tile said "Host" because a placeholder string shipped. Neither would have been
caught by counting features.

---

## 1. User & Account — 9 items

| # | Feature | State | Note |
|---|---|---|---|
| 1 | TatvaOS login | **Core** ✅ | Connect uses the shared session; proven — you signed in to reach the room |
| 2 | SSO with TatvaOS Core | **Core** ✅ | Same `authedFetch` and refresh flow as every product |
| 3 | User profile | **Core** ✅ | |
| 4 | Profile photo | **Core** ✅ | Available; Connect tiles currently show a letter avatar, not the photo |
| 5 | Name, designation, organization | **Core** ✅ | Name now flows into meetings (`NameOfAsync`); designation is not shown in the room |
| 6 | Personal meeting settings | **Not built** | No per-user defaults — every meeting is configured on creation |
| 7 | Device management | **Core** ✅ | |
| 8 | Active sessions | **Core** ✅ | |
| 9 | Login / security history | **Core** ✅ | |

**Connect's own work here: 0 of 1 built.** Eight of nine are Core's and already live.

---

## 2. Dashboard — 11 items

| # | Feature | State | Note |
|---|---|---|---|
| 10 | Upcoming meetings | **Done** ✅ | `/connect`, `range=upcoming`, proven on production |
| 11 | Today's meetings | **Done** ✅ | `range=today` — returns 200; see the caveat below |
| 12 | Start instant meeting | **Done** ✅ | "Start now" creates and drops you into the room |
| 13 | Join meeting | **Done** ✅ | Code box accepts a bare code or a pasted full link |
| 14 | Schedule meeting | **Built** | `/connect/new` — never submitted in a browser |
| 15 | Recent meetings | **Done** ✅ | `range=past` |
| 16 | Recent calls | **Not built** | No call concept yet — Connect is meetings-only |
| 17 | Unread chats | **Not built** | Chat is ephemeral by design in Phase 1; nothing to be unread |
| 18 | Meeting invitations | **Not built** | No invite/RSVP model. Calendar integration is the natural home |
| 19 | Missed calls | **Not built** | Same as 16 |
| 20 | Quick access to contacts | **Not built** | Family holds the address book; not wired in |

**5 done, 1 built, 5 not built.**

> Caveat on 11: `today` compares against a date computed on the *server's*
> clock in UTC. For an organisation in IST that boundary is 05:30 local, so
> "today" can be wrong at the edges. It returns 200, so no test catches it.

---

## 3. Meetings — 16 items

| # | Feature | State | Note |
|---|---|---|---|
| 21 | Instant meeting | **Done** ✅ | |
| 22 | Scheduled meeting | **Built** | API proven; the form has not been used |
| 23 | Recurring meeting | **Not built** | No recurrence column, no expansion. Calendar already solves this — worth reusing rather than rebuilding |
| 24 | Private meeting | **Partial** | Visibility is per-tenant via RLS, and `allowGuests` closes it to outsiders. There is no "invite-only within the org" |
| 25 | Meeting ID | **Done** ✅ | 22-char code, plaintext by your decision |
| 26 | Custom meeting link | **Not built** | Codes are random; no vanity slugs |
| 27 | Meeting password | **Built** | Argon2id-hashed, wrong password answers 403 not 404 — never exercised end to end |
| 28 | Waiting room | **Built** | Three modes (off / guests / everyone), in-room admit UI, one-shot claim. Test written, never run |
| 29 | Guest / anonymous joining | **Built** ⚠️ | Complete and deployed, but **blocked on Core's review** before it may be advertised |
| 30 | Host and co-host | **Partial** | Roles exist and are enforced server-side; **no UI to promote anyone**. `setRole` is written and unreachable |
| 31 | Meeting duration | **Partial** | `scheduledStart`/`scheduledEnd` stored and shown; nothing enforces or warns on overrun |
| 32 | Time-zone support | **Partial** | The organiser's zone is stored alongside the instant. Display is the browser's local time; see the `today` caveat |
| 33 | Meeting lock | **Built** | Toggle on the meeting page; guest join returns 409. In the waiting-room test, unrun |
| 34 | End meeting for everyone | **Built** | Button in the room and on the meeting page — **never executed once, anywhere** |
| 35 | Rejoin meeting | **Done** ✅ | Rejoin offered on disconnect, and deliberately *not* offered after a host removes you |
| 36 | Meeting history | **Done** ✅ | Past tab; attendance detail depends on the event log below |

**4 done, 6 built, 4 partial, 2 not built.**

---

## 4. Video & Audio — 17 items

| # | Feature | State | Note |
|---|---|---|---|
| 37 | 1-to-1 video call | **Done** ✅ | Proven in Phase 0 across two networks, and in the room |
| 38 | Group video meeting | **Built** | Nothing limits it, but **3+ people has never been rendered** — the tile flex maths is untested at that count |
| 39 | Voice-only call | **Partial** | You can join with the camera off; there is no explicit audio-only mode or entry point |
| 40 | Camera on/off | **Done** ✅ | Seen working |
| 41 | Microphone on/off | **Done** ✅ | Seen working |
| 42 | Speaker selection | **Not built** ❗ | Camera and **microphone** selection exist. Output-device selection (`audiooutput` / `setSinkId`) does not. Easy to miss — the Settings panel looks complete |
| 43 | Camera selection | **Built** | In the Settings panel, never switched |
| 44 | Background blur | **Not built** | Needs `@livekit/track-processors` |
| 45 | Virtual background | **Not built** | Same dependency |
| 46 | Noise suppression | **Done** ✅ | Browser default via getUserMedia constraints |
| 47 | Echo cancellation | **Done** ✅ | Same |
| 48 | Automatic quality adjustment | **Done** ✅ | `adaptiveStream: true` + `dynacast: true`, plus simulcast by default |
| 49 | Network-quality indicator | **Not built** | LiveKit publishes `ConnectionQuality`; nothing subscribes to it |
| 50 | Automatic reconnection | **Partial** | SDK reconnect proven in Phase 0's deliberate drop; the room's banner and recovery UI have never been triggered |
| 51 | Low-bandwidth mode | **Partial** | Simulcast degrades automatically; there is no manual "audio only to save data" switch — which matters on mobile data |
| 52 | Full-screen mode | **Not built** | No `requestFullscreen` anywhere |
| 53 | Gallery / speaker view | **Built** | Toggle works in code; auto-switches to speaker when someone shares. Never seen |

**6 done, 3 built, 3 partial, 5 not built.**

---

## 5. Participant Management — 12 items

| # | Feature | State | Note |
|---|---|---|---|
| 54 | Participant list | **Built** | People panel, live from the SDK, works for guests too |
| 55 | Mute participant | **Built** ❗ | **Never executed.** Twirp call to LiveKit |
| 56 | Remove participant | **Built** ❗ | **Never executed** |
| 57 | Make co-host | **Not built (UI)** | Endpoint exists and compiles; no button anywhere calls it. Also note the change only takes effect on their *next* token — a promoted cohost gets nothing until they reconnect |
| 58 | Disable participant camera | **Partial** | The API takes `kind: 'audio' \| 'video'`; the UI only ever sends `audio`. One argument away |
| 59 | Allow / disallow screen sharing | **Not built** | No per-meeting or per-participant publish policy |
| 60 | Allow / disallow chat | **Not built** | Chat rides the data channel, ungated |
| 61 | Admit from waiting room | **Built** | Cards in-room, plus the People panel. Never run against a real guest |
| 62 | Raise hand | **Not built** | Nothing in the tree |
| 63 | Participant status | **Partial** | Muted / speaking / connected shown. "Connected" on the meeting page is derived from the event log — which is currently empty |
| 64 | Participant search | **Not built** | Fine at meeting scale; needed for large rooms |
| 65 | Meeting lock | **Built** | Duplicate of 33 |

**0 done, 5 built, 2 partial, 5 not built.** This is the weakest section, and the two that matter most — 55 and 56 — are exactly the ones that have never run.

---

## 6. Screen & Content Sharing — 8 items

| # | Feature | State | Note |
|---|---|---|---|
| 66 | Share entire screen | **Built** | The browser's own picker offers screen / window / tab from one call |
| 67 | Share application | **Built** | Same picker |
| 68 | Share browser tab | **Built** | Same picker |
| 69 | Share system audio | **Not built** | `setScreenShareEnabled` is called with no options, so `audio` is never requested. A one-line change — and the thing people notice immediately when sharing a video |
| 70 | Presentation mode | **Partial** | Sharing auto-switches everyone to speaker view; no dedicated presenter layout or controls |
| 71 | Multiple presenters | **Not built** | The code takes `.find(...)` — the **first** sharer wins and a second person's screen is invisible. LiveKit allows several |
| 72 | Stop participant sharing | **Not built** | A host cannot end someone else's share |
| 73 | Shared content history | **Not built** | Nothing records what was shared |

**0 done, 3 built, 1 partial, 4 not built.**

---

## Totals

Counted from the rows above, not estimated.

| Section | Done | Built | Partial | Not built | n |
|---|--:|--:|--:|--:|--:|
| 1. User & Account | 8 (Core) | 0 | 0 | 1 | 9 |
| 2. Dashboard | 5 | 1 | 0 | 5 | 11 |
| 3. Meetings | 4 | 6 | 4 | 2 | 16 |
| 4. Video & Audio | 6 | 3 | 3 | 5 | 17 |
| 5. Participant Management | 0 | 5 | 2 | 5 | 12 |
| 6. Screen & Content Sharing | 0 | 3 | 1 | 4 | 8 |
| **Total** | **23** | **18** | **10** | **22** | **73** |

| State | Count | Share |
|---|--:|--:|
| Done — observed working (15 Connect + 8 Core) | 23 | 32% |
| Built — compiles, never exercised | 18 | 25% |
| Partial | 10 | 14% |
| Not built | 22 | 30% |

**56% is done or built. 32% is actually proven.**

### Reading that honestly

The list is not a Phase 1 list — it is the full product. Your own Phase 1
definition was "features 1–73, roughly", but several items here are plainly
later work: recurring meetings, virtual backgrounds, shared-content history,
recent/missed calls. Against the *Phase 1 bullets* you wrote, the picture is
better: every bullet is built, and the gap is verification rather than
construction.

The number that should bother you is not 32%. It is that **18 features have
never once run**, and among them are mute, remove, and end-for-everyone — the
controls a host needs when a meeting goes wrong.

---

## What would move the needle most, in order

1. **Deploy `0acdb39` and run the three scripts.** That converts most of the
   Built column and answers whether attendance records at all. Until
   `connect.meeting_events` gains a row, features 36 and 63 are hollow.
2. **Speaker selection (42)** — the Settings panel currently looks finished
   and is missing output device. Half a day, and people will hit it on day one
   with a headset.
3. **Share system audio (69)** — one options object. Anyone sharing a video
   without it will report it as broken.
4. **Multiple presenters (71)** — `.find` → handling more than one sharer.
   Currently a second presenter is silently invisible, which is worse than
   unsupported.
5. **Make co-host UI (57)** and **disable camera (58)** — both are endpoints
   with no button. Small work, and 57 needs a decision about whether promotion
   should take effect immediately (it currently waits for their next token).
6. **Raise hand (62)** — cheap over the existing data channel, and the single
   most-missed feature in a classroom, which is your market.

Items 44, 45, 49, 51, 52, 64, 72, 73 are genuine new work rather than
finishing touches, and none of them block the brief's definition of Phase 1
being done.

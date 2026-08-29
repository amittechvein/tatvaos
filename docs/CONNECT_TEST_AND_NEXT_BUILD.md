# Connect — test plan, and the next build

Written 2026-08-17 against `0acdb39`. Part A tests what exists. Part B is what
to build next. They are in one document because three of the test outcomes
change the build order.

---

# PART A — Test plan

Ordered so that each step's failure would invalidate the ones after it. Do not
skip ahead: if attendance never records (T1.3), half of T5 and T6 cannot be
judged, because those tests read the event log to decide whether LiveKit
actually acted.

Mark each row **pass / fail / blocked** and send me the failures with their
output — the exact text matters more than a description.

## T1 — Deploy and automated checks *(15 min, no second device)*

| | Step | Expected | Proves |
|---|---|---|---|
| 1.1 | `git pull && ./infra/scripts/deploy.sh production` | `OK 20260817-connect.sql`, all 10 services running | schema, deploy |
| 1.2 | `bash infra/scripts/connect-phase1-verify.sh` | **14 ok, 0 failed** — including *4* SECURITY DEFINER functions | RLS, tenancy, LiveKit config |
| 1.3 | `bash infra/scripts/connect-host-controls-test.sh` | **rows appear** in `connect.meeting_events`; mute/remove/end all OK | 34, 55, 56 + attendance |
| 1.4 | `bash infra/scripts/connect-waiting-room-test.sh` | 14 ok — including *the same wait token yields nothing the second time* | 27, 28, 29, 33, 61 |

**1.3 is the one to watch.** If it still says "nobody joined", the row never
landed. Run this and send me the output:

```bash
cd /srv/tatvaos-production
C="docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env"
$C logs --since 10m api 2>&1 | grep -iE 'webhook|row-level|LOST' | tail -20
$C exec -T postgres psql -U postgres -d tatvaos_mail -c "SELECT kind, count(*) FROM connect.meeting_events GROUP BY 1"
```

The API log is now honest about this — a refused write logs an **error** and
returns 500 instead of silently answering 200. If nothing appears there either,
`up -d --force-recreate api` and repeat.

## T2 — One person, one browser *(20 min)*

| | Step | Expected | Proves |
|---|---|---|---|
| 2.1 | Open `/connect` signed in | Upcoming / Today / Past tabs, Start now, Schedule, join-by-code box | 10, 11, 15, 36 |
| 2.2 | **Schedule** a meeting for tomorrow 10:00 | Lands on the meeting page; date and time correct | 14, 22, 31, 32 |
| 2.3 | On the meeting page, press **Copy link** | Clipboard holds `https://connect.tatvaos.com/connect/room/<code>` | 25 |
| 2.4 | Paste that **whole URL** into the join box on `/connect` | Opens the room — not a mangled code | 13 |
| 2.5 | **Start now** | Room opens, camera prompt, your video appears | 12, 21, 37, 40 |
| 2.6 | Your tile label | **Your name**, not "Host" | 5 |
| 2.7 | Mute / unmute, video off / on | Buttons turn red when off; tile shows your initial, not black | 40, 41 |
| 2.8 | Settings panel | Camera and microphone lists populate with real names | 43 |
| 2.9 | Toggle **Gallery / Speaker** | Layout changes | 53 |
| 2.10 | Open **Chat**, send a message | Appears as "You" | 8 (chat) |
| 2.11 | Press **Leave** | "You have left the meeting", Rejoin offered | 35 |
| 2.12 | Press **Rejoin** | Back in the room | 35, 50 |

> Expect a miss at 2.8: **there is no speaker/output selection.** That is
> feature 42 and it is genuinely not built — see B1.1.

## T3 — Two people *(30 min, second device or a colleague)*

| | Step | Expected | Proves |
|---|---|---|---|
| 3.1 | Both join the same meeting | Two tiles, both video, audio both ways | 37, 38 |
| 3.2 | Watch the tile borders while talking | Green ring follows whoever is speaking | 63 |
| 3.3 | B mutes | A sees the mic-off icon on B's tile | 63 |
| 3.4 | A opens **People** | Both listed, correct muted/speaking state | 54 |
| 3.4b | Both talk at once, near a speaker | No echo, no howl; typing is not amplified | **46, 47** |
| 3.5 | A sends chat | B receives it, badge count appears on B's Chat button | chat |
| 3.6 | B opens Chat while A sends another | **No stale unread badge** after B closes the panel | chat |
| 3.7 | A shares screen | B sees it; **everyone flips to speaker view**; A's share is *not* mirrored | 66, 67, 68, 70 |
| 3.8 | A shares a video with sound | B hears nothing | **69 — expected miss** |
| 3.9 | A stops sharing | Back to gallery-ish; no frozen frame | 66 |
| 3.10 | **A (host) mutes B** | B is actually muted — B's own button flips | **55** |
| 3.11 | **A removes B** | B lands on **"You were removed from the meeting"**, no Rejoin button | **56** |
| 3.12 | B rejoins by link, A presses **End for everyone** | Both land on **"The meeting has ended"** | **34** |

3.10–3.12 are the highest-value rows in this entire plan. They have never run.

## T4 — Three or more *(15 min)*

| | Step | Expected | Proves |
|---|---|---|---|
| 4.1 | Three people in gallery view | Three tiles, sensible sizes, no overlap or single-column collapse | **38** |
| 4.2 | Four or five | Tiles wrap and shrink; nothing pushed off-screen | 38 |
| 4.3 | Two people share at once | **Only one is visible** | **71 — known limitation** |
| 4.4 | One person leaves | Their tile disappears; no black rectangle | 50 |

4.1 is untested arithmetic — the tile flex basis is `clamp(240px, 26vw, 420px)`
and has never rendered beyond two.

## T5 — The guest path *(20 min, use a private window)*

Do this **after** Core's review, or on a meeting only you know about.

| | Step | Expected | Proves |
|---|---|---|---|
| 5.1 | Schedule a meeting, waiting room = **Guests wait** | Saved | 28 |
| 5.2 | Open the link in a private window (signed out) | Name field, meeting title, no sign-in wall | **29** |
| 5.3 | Enter a name, join | "Waiting to be let in" | 28 |
| 5.4 | Host's room | Card slides in top-right with the guest's name | **61** |
| 5.5 | Press **Let in** | Guest joins automatically within ~3s | 61 |
| 5.6 | Repeat, press **Turn away** | Guest sees "You were not let in" | 61 |
| 5.7 | Set a password, join as guest with the wrong one | "That password is not right" — *not* a generic failure | 27 |
| 5.8 | Lock the meeting, try to join as a new guest | Refused | 33, 65 |
| 5.9 | Open `/connect/room/ZZZZZZZZZZZZZZZZZZZZZZ` | "This meeting link does not work." | no-oracle rule |

## T6 — Network behaviour *(15 min)*

| | Step | Expected | Proves |
|---|---|---|---|
| 6.1 | Mid-call, turn wifi off ~10s, back on | Amber "reconnecting" banner, then it recovers **without** rejoining | **50** |
| 6.2 | Join from mobile data, not wifi | Works — proven in Phase 0, re-confirm on the real UI | 48, 51 |
| 6.3 | Join the same meeting twice from one account | Second takes over; first sees "You joined from somewhere else" | 50 |
| 6.4 | Phone browser, portrait | Control bar becomes icons; tiles usable | responsive |

## T7 — Browsers *(30 min)*

Chrome desktop, Safari desktop, Chrome Android, Safari iOS. For each: join,
camera, mic, screen share (desktop only), leave.

Safari is where differences will show — screen share and autoplay especially.

---

# PART B — The next build

Ordered by **value per hour**, not by list order. Every item names its feature
number from your 73.

## B1 — Finish what looks finished *(about 1 day, all of it)*

These are the ones that will be reported as bugs, because the UI implies they
exist.

**B1.1 Speaker / output selection — feature 42.**
The Settings panel has camera and microphone and stops there. Add
`audiooutput` via `Room.getLocalDevices('audiooutput')` and `setSinkId` on the
audio elements. Anyone on a headset hits this immediately. *~2 hours.*

**B1.2 Share system audio — feature 69.**
`setScreenShareEnabled(true, { audio: true })`. One options object. Without it,
sharing a video is silent and reads as broken. *~30 min, plus testing that
Safari degrades gracefully — it does not support it.*

**B1.3 Multiple presenters — feature 71.**
The code takes `.find(...)` on screen-share tracks, so a second sharer is
silently invisible. Show all of them, or refuse the second share with a clear
message. Invisible is the worst of the three options. *~2 hours.*

**B1.4 Full-screen — feature 52.**
`requestFullscreen()` on the stage, plus a button and Esc handling. Expected in
any meeting tool. *~1 hour.*

**B1.5 Network-quality indicator — feature 49.**
Subscribe to `ConnectionQualityChanged` and put a small bar on each tile. This
is what stops "the call is bad" turning into a support ticket with no data.
*~2 hours.*

## B2 — Small features with real demand *(about 2 days)*

**B2.1 Raise hand — feature 62.**
Rides the existing data channel; no backend. The single most-missed feature in
a classroom, which is your market. Hand state in the participant list and a
badge on the tile. *~3 hours.*

**B2.2 Make co-host UI — feature 57.**
The endpoint exists and nothing calls it. **Needs a decision first:** promotion
currently takes effect only on the person's *next* token, so a cohost promoted
mid-meeting gets nothing until they reconnect. Either accept that and say so in
the UI, or have the server push a new token. *~3 hours once decided.*

**B2.3 Disable participant camera — feature 58.**
The API already takes `kind: 'audio' | 'video'`; the UI only ever sends
`audio`. Add the second button. *~1 hour.*

**B2.4 Participant search — feature 64.**
A filter box in the People panel. Trivial, and it matters the moment a class
of forty joins. *~1 hour.*

**B2.5 Personal meeting settings — feature 6.**
Per-user defaults (waiting room, guests allowed, mic/camera on entry) so
`/connect/new` starts from your preferences. Needs a small table and a
settings screen. *~1 day.*

## B3 — Bugs found in the audit, worth fixing before more features

**B3.1 "Today" uses the server's UTC date.**
`ListMeetingsAsync` compares against `now.Date` on the server. For an
organisation in IST the day boundary lands at 05:30 local, so "Today" is wrong
at the edges. It returns 200, so no test catches it. Take the client's offset
or the meeting's stored timezone. *~2 hours.*

**B3.2 Profile photos are not used — feature 4.**
Core has them; tiles show a letter. Real faces make a participant list far
easier to scan. *~2 hours.*

**B3.3 Delete `/connect/dev`.**
Kept deliberately as the known-good fallback while the room was unproven. Once
T3 passes, it is a page that accepts an arbitrary token and should go.

## B4 — Bigger work, genuinely later

| Feature | Note |
|---|---|
| 44, 45 background blur / virtual background | Needs `@livekit/track-processors`; meaningful CPU cost on the low-end Android phones your market uses. Test on a cheap device before promising it |
| 23 recurring meetings | Calendar already expands recurrence. **Reuse it** rather than building a second engine — that was the reason for the `calendar_event_id` column |
| 59, 60 allow/disallow share and chat | Needs a per-meeting policy model and token grants that reflect it |
| 72 stop participant sharing | Straightforward once 59 exists |
| 51 low-bandwidth mode | An explicit "audio only to save data" switch. Matters in your market more than most |
| 16, 19 recent / missed calls | Requires a call concept Connect does not have. Arguably not Phase 1 at all |
| 18 meeting invitations | Belongs with Calendar |
| 26 custom meeting link | Vanity slugs need a uniqueness and abuse story |
| 73 shared content history | Phase 3, with recordings |

## What I would do, in order

1. **T1** — ten minutes, and it tells you whether attendance works at all.
2. **T3** — the first real proof of host controls. Two devices, half an hour.
3. **B1** as one batch — the five things that look built and are not.
4. **T5** once Core has reviewed the guest path.
5. **B2.1 raise hand** and **B2.4 search** before anything else in B2 —
   cheapest, most visible in a classroom.

B4 should wait until real people have used it for a week. The list will
reorder itself once they have.

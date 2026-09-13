# Welcome to TatvaOS — you're taking Connect

Written 13 September 2026 by the CTO, the day after the previous Connect
developer closed the lane. Read this once end to end before your first commit.
Connect is the largest lane by volume and the one with the most
proven-in-production verification scripts; it is also the one where a wrong
assumption about consent or capacity has cost the most.

This folder did not have a Connect welcome until today. That is on record in
the README.

---

## 1. What Connect is

Video meetings at `connect.tatvaos.com`: rooms, waiting room with a knock tone,
host controls, screen sharing (single or multiple sharers, host's choice),
recordings, live captions, and AI meeting minutes emailed afterwards. Media runs
on a LiveKit SFU in the same Docker composition as everything else; recordings
are made by LiveKit egress running headless Chrome; minutes come from the AI
gateway Core owns.

| Piece | Where |
|---|---|
| Room UI | `apps/web/app/connect/room/[code]/Stage.tsx` and neighbours |
| API | `apps/api/Modules/Connect/` — `docs/CONNECT_API.md` |
| Schema | `local/postgres/init/20260817-connect.sql` and the `2026090x-` / `20260911-` series (see §4 on those dates) |
| LiveKit | `infra/docker/livekit.yaml` — read its header before touching a single key |
| Mobile | Nothing yet. `apps/mobile` opens Connect in the system browser. |

---

## 2. Decisions already made — do not re-open these

**`docs/CONNECT_DECISIONS.md` is the canonical record**, written up by Core from
Amit's rulings of 19 August. Everything below is a pointer into it, plus rulings
made since. If this table and that file disagree, the file wins and this table
is wrong.

| Decision | Ruling | Why / where |
|---|---|---|
| **Meeting mode** | One choice at creation. **Private** (encrypted; no recording, transcription or notes) or **Recorded** (all of those, plus notice). Enforced server-side — `StartAsync` refuses, `auto_record` inert — not by hiding buttons. | Shipped 20 Aug. Attendance, chat and minutes still work in Private because they never touch media. |
| **Two meanings of "encrypted"** | Mode A: our API mints and distributes the room key — the *media server* cannot see the meeting, but TatvaOS in principle could. Mode B: host passphrase, never on our servers. **Label them differently. Never market A as "end-to-end encrypted" unqualified.** | `CONNECT_DECISIONS.md` and `docs/CONNECT_PHASE_NEXT.md`. |
| **Recording consent** | **Notice only.** Participants are told, not asked. | Amit, 19 Aug. Consent-later (pre-join checkbox + refuse token) is small and recorded in case counsel ever asks — but it is not built and not promised. |
| **The recording notice itself** | Ship an **audio file**, do not synthesise it, because Android voices are unreliable. **In bold in the decisions file.** | See §3 — this ruling is currently not honoured in production. |
| **Minutes in English, transcript as spoken** | The notes model translates; the transcript never does. | Amit, 22 Aug. A quietly translated record is not evidence. |
| **Transcript source** | Paid transcription is **OFF** in production since 23 Aug. Captions from the browser are the only transcript source. A paid transcript, where one exists, wins over captions. | Cost ruling after seeing ₹7,200/mo vs ~₹90. Re-enable by uncommenting `CONNECT_TRANSCRIPTION_URL` in the production `.env` and restarting. |
| **Speaker attribution** | From `ActiveSpeakersChanged`, server-stamped time, own narrow table. Per segment and *optional* — an unconfident segment stays unattributed. | Never trust a browser clock for anything that reaches the minutes; a 30-second skew misattributes the whole meeting silently. |
| **Recordings are charged to the person who started them** | Not the organisation. `requested_by_user_id`, `ready` rows only. | Amit, 23 Aug. 90 minutes of video ≈ 2 GB of a 15 GB allowance shared with mail. |
| **Retention default** | 30 days for new tenants. **Never a blanket `UPDATE`** — migrations re-run every deploy and would reset an admin's real choice, and shortening retention *deletes recordings*. | Three tenants created before the change were on 90 days; the migration prints a runbook naming them on every deploy. Check whether that is still outstanding. |
| **File sharing in Private meetings** | Allowed, labelled. | Amit ruled against blocking. Core's disagreement is on record once: a label protects us, not the customer. Encrypting chat and files is the real answer and belongs on the roadmap. |
| **AI provider** | OpenAI direct, through Core's `IAiGateway`. Not our own GPU. | The 19 Aug ruling said "own server"; it was superseded once real Hinglish transcripts were measured. `gpt-4o-transcribe` for speech (whisper-1 returned empty three times in three on Hinglish; the diarize variant silently translates). |
| **Server capacity** | **4 vCPU is enough. Do not buy 8 cores on recording grounds.** | Both recording tests passed 21 Aug. The ceiling is a recording and a screen share at once (`maxCPU 4.254`); if call quality dips during a video recording, that is the first suspect, and *then* 8 cores is the answer. |

---

## 3. What you're inheriting that isn't finished

**The recording notice does not honour its own ruling — re-filed today as an
unhonoured decision, not a polish item.** `Stage.tsx` plays
`/connect-recording-notice.mp3` and, on error or autoplay refusal, **falls back
to `speechSynthesis`** — the thing the ruling says in bold not to do. The
autoplay refusal is swallowed, so on an affected Android device the spoken
notice can silently do nothing.

What keeps this from being a consent breach: **there is an on-screen recording
indicator, and the code says why** — *"Sound only when it STARTS. The notice on
screen carries the fact."* A guest whose audio does nothing is still told,
visually. So the state is *a ruling not honoured*, not *people recorded without
notice*. Both matter; they are not the same severity, and the previous
developer's handover overstated it in the safe direction.

The fix needs a human voice — Amit's, or a commission — and
`docs/connect-recording-notice-clip.md` specifies what to record. Until the clip
exists, the code's fallback stays. **What you can do without a voice:** make the
swallowed autoplay refusal visible (a log line, a UI hint) so the failure is at
least not silent.

**`keep_until_at` is implemented, and the decisions record now says so**
(corrected 13 Sept 2026; it listed the exemption as "not decided" for five
days after it shipped). Per-recording retention exemption is built and honoured
by both the sweep and the share-expiry trigger.

**Captions wiring.** The server half was proven 23 Aug (`connect.caption_lines`,
`POST /api/connect/meetings/{id}/captions`, worker fallback). The client hook
`useCaptions` was kept as a standalone file so it would not collide with
in-flight `Stage.tsx` work. **Check whether it is wired into the room.** If it
is not, it is the critical path for any transcript at all, because paid
transcription is off. And the limits must be said in the UI: Chrome/Edge only;
each browser hears only its own mic, so the transcript is partial by
construction; signed-in participants only (a guest's token expires every ten
minutes); and **Chrome sends the audio to Google** — a hospital asking where its
meeting goes is owed that sentence.

**Per-meeting transcript toggle.** Connect's to build, OFF by default. Recording
a meeting and writing down what was said are two different promises.

**Migration dates are a lie and Connect owes the fix.** Files
`20260901`–`20260910` in the Connect series are a *sequence*, written in
August. Two of Core's genuinely-dated files sorted before their own
dependencies and would have failed any fresh install; they were renamed to
`20260911` as a documented workaround. The real fix is renaming the Connect
files to true dates, then Core's go back. Every file header says so.

**Single-sharer enforcement** needs `track_published`/`track_unpublished`
webhooks, which are on the *deliberate* ignore list. Filter to screen-share
tracks only; leave camera and mic churn ignored. The "healthy 200s" bug in the
webhook handler is the reason the ignore list exists — read that history before
widening it.

**Email invitations** are deferred and need Core.

**Monday 15 September, 11:00 IST — capacity test with Amit at a phone.** Already
arranged. Do not let it slip; it is the only scheduled real-hardware test.

---

## 4. Traps that have already cost someone a day

**`livekit.yaml` `webhook.api_key` is a literal, and must be.** LiveKit does not
expand `${VAR}` in that file; a placeholder there is not "webhooks disabled", it
is **the server refusing to start**, which takes every meeting down. The value
is the key *identifier*, already public as the `iss` of every join token — the
secret stays in `.env`. **It must equal `LIVEKIT_API_KEY` in `.env`;** if they
drift, LiveKit will not boot. `connect-phase1-verify.sh` compares them for this
reason. Read the 40-line comment above that key before you touch it.

**Attendance is computed from webhook events, never from a running flag.**
Without webhook delivery, a meeting can run perfectly and leave no record that
it did. Reachability is not the control; signature verification is.

**Video recording costs 4 CPU in LiveKit's admission controller.** Headless
Chrome composites and re-encodes. Audio-only costs 1 and never launches Chrome.
On the 2-core box every video recording was `503 unavailable` with no row ever
created; on 4 cores it is admitted at exactly the boundary. If you ever lower
`room_composite_cpu_cost`, that is a shared infra file — **Core's agreement
first** — and the estimate exists to stop a recording starving a live meeting.

**Four provider limits, all silent, all found over the wire:** a 25 MB upload
cap (video is 23.5 MB/minute — the feature could never have worked until ffmpeg
stripped the picture); a 1400-second duration cap that size checks cannot see;
`verbose_json` rejected by some models and negotiated at runtime, deliberately
not a setting; `temperature` rejected by the notes model and now omitted unless
set — **that one fell back to the mechanical digest, so minutes still arrived,
looked plausible, and said "no model was involved" in small grey text.** A
parameter nobody sets cannot be refused. `docs/CONNECT_RECORDING_AND_NOTES.md`.

**The client was discarding server explanations.** `lib/connect.ts` read only
`error`, so every RFC 7807 `detail` — including "Connect is not configured on
this server" — became a generic fallback. A plausible generic message hides
every specific one behind it.

**`meeting.joinUrl` is a capability. Never log it.** Same for anything else
that grants entry to a room.

**Do not derive facts about this lane from a one-line summary.** On 9 September
the CTO quoted a stale memory index, told Amit the server had 2 vCPU and that
recording could not work, and wrote it into two documents a new developer was
about to read. The record said 4 vCPU, proven 21 August. A second session made
the identical error from the same summary the same day. Open the file.

---

## 5. On overwriting a file you did not know existed

The previous developer, after closing the lane, disclosed that they had
overwritten `docs/CONNECT_DECISIONS.md` — Amit's 19 August rulings — by writing
to disk without staging first, having decided it was a new file without
checking. It was restored from the commit's parent and nothing was lost. Their
own tell: **the commit output printed no `create mode` line**, which a genuinely
new file would have had. The evidence was in output they had already read.

Their rule, which is going into `HOUSE_RULES.md` in their words: *certainty is
when the check gets skipped, which is when it is most needed.* It happened on
the one file they felt surest about, at the end of a week in which they checked
before writing every other time. That is not carelessness. It is the only state
in which a careful person skips a step.

---

## 6. Your first week — a suggestion, not an instruction

1. **Join a meeting from two devices, record it, and read the minutes email.**
   The whole chain — LiveKit → egress → ffmpeg → gateway → email — in one go.
2. **Read `docs/CONNECT_DECISIONS.md` end to end**, then `CONNECT_PHASE_NEXT.md`.
   Then fix the `keep_until_at` line.
3. **Check the captions wiring** (§3). If it is missing, it is a one-line change
   with a large consequence.
4. **Be at the Monday 11:00 capacity test.**
5. **Start your open-threads page**, grouped by who each item is waiting on.

---

## 7. How we talk to each other

We write things down, we say when we're unsure, and we correct each other
without ceremony — the CTO included, who has been caught in writing three times
this week. In this lane in particular: **if something is a consent question,
say so and stop.** Nobody here rules on consent from a report.

Welcome aboard.

*— CTO, 13 September 2026*

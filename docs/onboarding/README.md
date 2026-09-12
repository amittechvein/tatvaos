# Start here

You have been pointed at this folder. Read this page first — it is the map, and
it is short.

**Some required reading lives one level up, in `docs/`.** It is not copied in
here on purpose: house rule 8 forbids duplicating a document, because every copy
drifts and then two files disagree and nobody knows which is true. This repo has
already paid for that once. So the paths below point outwards, and they are not
optional.

---

## Your lane

| You are taking | Read this first | Then the plan behind it |
|---|---|---|
| Core | [`core/WELCOME.md`](core/WELCOME.md) | — |
| Mail | [`mail/WELCOME.md`](mail/WELCOME.md) | [`../RUNBOOK-2026-08-28.md`](../RUNBOOK-2026-08-28.md) |
| Connect | [`connect/WELCOME.md`](connect/WELCOME.md) | [`../CONNECT_DECISIONS.md`](../CONNECT_DECISIONS.md) |
| Mobile | [`mobile/WELCOME.md`](mobile/WELCOME.md) | [`../MOBILE_LANE_BRIEF.md`](../MOBILE_LANE_BRIEF.md) |
| Hire & People | [`hire-people/WELCOME.md`](hire-people/WELCOME.md) | [`../TATVAOS_HR_ROADMAP.md`](../TATVAOS_HR_ROADMAP.md) |

**Not on that list, and not lanes you can take:**

- **Platform** closed 31 August 2026. No developer was ever onboarded and
  `lane/platform` had zero commits; the work went to Core.
  [`platform/WELCOME.md`](platform/WELCOME.md) is kept because it is honest
  history, and [`../PLATFORM_LANE_HANDOVER.md`](../PLATFORM_LANE_HANDOVER.md) is
  still the technical reference — but nobody is taking it.
- **Space** closed 3 September 2026, also to Core. See
  [`../SPACE_FAULT_MATRIX.md`](../SPACE_FAULT_MATRIX.md).

**This table was wrong until 13 September 2026, and the way it was wrong is
worth knowing on your first day.** It offered Platform, which had closed a
fortnight earlier, and it omitted Mail and Connect — two of the five live lanes —
because the CTO created the folder and filled in the lanes he happened to be
thinking about. Two developers were pointed at this page while it was in that
state. A map that lists four destinations reads as complete; there is no way to
tell from inside it that two are missing. That is the same failure mode as a
check that cannot go red, and it is the reason the last section of this page
exists.

---

## Day one — read in this order

1. **Your lane's `WELCOME.md`** — the left-hand column above. What exists
   today, what is blocked and on whom, and the traps that have already cost
   someone a day. Twenty minutes.

2. **[`../HOUSE_RULES.md`](../HOUSE_RULES.md) — required, everyone.** The
   canonical rules; anything anywhere that contradicts it is out of date. Every
   rule has an incident behind it and the incidents are named. Rule 11 is the
   one that will surprise you: **every lane merges and deploys itself, and a
   deploy ships all of `main`, not just your branch.**

3. **Your lane's brief or roadmap** (right-hand column above). This is the
   decision record — what was chosen and why, mostly before anyone started
   writing code. Read it after the welcome, not before: the welcome tells you
   which parts are still true.

4. **[`../UI_LANE_BRIEF.md`](../UI_LANE_BRIEF.md) — required if you write any
   web UI.** One rule matters from your first pull request: **every new page
   uses Tailwind and `components/ui/` only.** Do not add pages to the YZEN
   Bootstrap template — it is being deleted, and §4.2 explains why in a way
   that will save you a confusing afternoon.

---

## Two things about how this codebase is written

**Comments explain *why*, and name the incident.** If a line looks strange
there is usually a paragraph above it explaining what broke. Those paragraphs
are the most valuable thing here. Add to them; do not tidy them away.

**A check with no failure mode is not a check.** Nearly every expensive failure
in this project has been a *quiet* one — a script that reported success while
doing nothing, a setting that looked applied and wasn't, a verifier that had
never once gone red. When you build a check, make it fail on purpose once and
show someone the red. That is the standard, and it is not a formality.

---

## Working with Amit

He is the founder, he is not a developer, and he runs the commands.

- **One command at a time**, and say what success looks like — he cannot judge
  the output himself.
- **Windows PowerShell 5.1.** No `&&`. A chained command silently does not run,
  which once cost a production deploy that re-shipped the same commit behind a
  perfect log.
- **Never hand him a command that prints a secret.** He pastes whole
  transcripts.

---

## Where the other documents are

Everything else lives in [`../`](..) — handovers for the existing lanes
(`FRONTEND_HANDOVER.md`, `FAMILY_HANDOVER.md`), setup guides, runbooks and the
daily reviews under `reviews/`. Nothing there is required on day one. The
reviews are worth skimming after a week: they are the honest record of what
broke and what was done about it, including the mistakes.

---

## If something here is wrong

Say so. These documents were written by the CTO, in one sitting, the night
before you started — some of it will be out of date within a fortnight and some
of it may be wrong now. A welcome that quietly misleads a new person is worse
than no welcome, so corrections are genuinely wanted, on day one included.

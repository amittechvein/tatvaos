# docs/

**New here? Go to [`onboarding/`](onboarding/) and read its README first.** It
tells you what to read, in what order, for your lane. Come back to this page
when you want to know what everything else is.

---

## The two kinds of document here, and why it matters

**Current** — describes how things are now, and is maintained. Trust it, and
fix it when it is wrong.

**Point-in-time** — a record of a session, a decision or a night's work, true
when written and never updated since. Useful history; **not instructions.**
Several documents below are dated in their filename, and that date is the
warning.

If you cannot tell which a document is, check when it was last changed
(`git log -1 -- docs/<file>`) and read its opening paragraph — most say.

---

## Folders

| Folder | Contents |
|---|---|
| [`onboarding/`](onboarding/) | ★ One folder per lane. Start here |
| [`architecture/`](architecture/) | How the system works and why |
| [`setup/`](setup/) | Getting a machine ready to develop |
| [`runbooks/`](runbooks/) | ★ What to do when something is broken |
| [`decisions/`](decisions/) | ADRs — why we chose X over Y |
| [`reviews/`](reviews/) | The CTO's daily reviews. Point-in-time, and the honest record of what broke |
| [`plans/`](plans/), [`mail-api-guide/`](mail-api-guide/) | Working material for specific pieces |

---

## Rules and ways of working — read these whatever your lane

| Document | |
|---|---|
| [`HOUSE_RULES.md`](HOUSE_RULES.md) | **Canonical.** Anything contradicting it is out of date. Every rule has a named incident behind it |
| [`WORKING_IN_LANES.md`](WORKING_IN_LANES.md) | How the worktrees and lanes fit together |
| [`UI_LANE_BRIEF.md`](UI_LANE_BRIEF.md) | **Required before you write any web UI.** New pages use Tailwind and `components/ui/` only |

---

## By product

**Connect** (video meetings) — the largest set here, and most of it is history.

- [`CONNECT_PHASE_NEXT.md`](CONNECT_PHASE_NEXT.md) — **read before starting any
  new Connect feature.** Amit's rulings and the build order
- [`CONNECT_BRIEF.md`](CONNECT_BRIEF.md), [`CONNECT_API.md`](CONNECT_API.md),
  [`CONNECT_DECISIONS.md`](CONNECT_DECISIONS.md) — the shape of it
- `CONNECT_2026-08-18-SESSION.md`, `CONNECT_2026-08-19-OVERNIGHT.md`,
  `CONNECT_PHASE0.md`, `CONNECT_PHASE1_FRONTEND.md`, `CONNECT_PHASE1_STEPS.md`,
  `CONNECT_TEST_AND_NEXT_BUILD.md`, `CONNECT_RECORDING_DEPLOY.md`,
  `CONNECT_FEATURE_AUDIT.md`, `CONNECT_HOST_CONTROLS.md`,
  `CONNECT_NOTES_RETENTION.md`, `CONNECT_RECORDING_AND_NOTES.md`,
  `CONNECT_COORDINATION.md`, `connect-minutes-for-everyone.md`,
  `connect-recording-notice-clip.md`
  — **point-in-time.** History of how Connect got built

**Mail**

- [`CLIENT_MAIL_SETUP.md`](CLIENT_MAIL_SETUP.md) — connecting Outlook, phones
- [`MAIL_IMIP_SEAM.md`](MAIL_IMIP_SEAM.md) — Calendar ↔ Mail invitations
- [`MAIL_LARGE_ATTACHMENTS.md`](MAIL_LARGE_ATTACHMENTS.md)
- [`RUNBOOK-2026-08-28.md`](RUNBOOK-2026-08-28.md) — **the TLS/SASL/app-password
  mail-edge work. Check whether it has shipped before relying on it**; it was
  written as a plan, not a description of production
- [`mail-api-guide/`](mail-api-guide/) — the Resend-shaped send API

**Space** (files) — [`SPACE_API.md`](SPACE_API.md),
`SPACE_API_DRIVE_ADDENDUM.md`, `SPACE_API_PUBLIC_LINKS_ADDENDUM.md`,
`SPACE_ATTACH.md`, `SPACE_BACKEND_BRIEF.md`, `SPACE_FAULT_MATRIX.md`,
[`STORAGE_MODEL.md`](STORAGE_MODEL.md)

**The web front end** — [`FRONTEND_HANDOVER.md`](FRONTEND_HANDOVER.md), the
handover for `apps/web` as a whole. Read alongside `UI_LANE_BRIEF.md`, which
supersedes anything it says about styling.

**Family** (contacts) — [`FAMILY_API.md`](FAMILY_API.md),
[`FAMILY_HANDOVER.md`](FAMILY_HANDOVER.md), `FAMILY_BACKLOG.md`

**Mobile** — [`MOBILE_LANE_BRIEF.md`](MOBILE_LANE_BRIEF.md) plus
[`onboarding/mobile/`](onboarding/mobile/)

**Hire & People** — [`TATVAOS_HR_ROADMAP.md`](TATVAOS_HR_ROADMAP.md) plus
[`onboarding/hire-people/`](onboarding/hire-people/)

**Platform / admin** — [`PLATFORM_LANE_HANDOVER.md`](PLATFORM_LANE_HANDOVER.md),
`PLATFORM_TO_CORE_TRANSFER.md`,
[`PERSONAL_PLANS_AND_PRICING.md`](PERSONAL_PLANS_AND_PRICING.md)

**Everything, unsorted** — [`BACKLOG.md`](BACKLOG.md)

---

## Honest caveat about this index

It was written in one pass on 9 September 2026. The groupings are reliable; the
**current / point-in-time** marks are a judgement made from filenames, opening
paragraphs and what the CTO knew that week — not from re-reading all
forty-three documents. If one is marked wrong, it is worth ten minutes to fix
the label, because a stale document read as current is how someone spends a day
implementing something that already exists or was abandoned.

The older reading order this file used to carry (`setup/01-dev-environment.md`,
`architecture/01-architecture.md`, and so on) now lives in
[`onboarding/README.md`](onboarding/README.md), alongside the lane-specific
material, so there is one reading order rather than two that drift apart.

---

## runbooks/

Write these **before** the first outage, not during it. At 3am, under pressure,
with customers waiting, is not when you want to be reasoning from first
principles about how DKIM key rotation works.

Each runbook: symptom → diagnosis → fix → how to confirm it worked.

## decisions/

One short file per significant choice. Context, options considered, what we
picked, why, and what would make us revisit. Future you will not remember the
reasoning, and a new developer has no way to reconstruct it.

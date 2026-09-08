# Onboarding

One folder per lane. Start with your own `WELCOME.md`, then
`../HOUSE_RULES.md` — that one is canonical and applies to everybody.

| Lane | Start here | The plan behind it |
|---|---|---|
| Core | [`core/WELCOME.md`](core/WELCOME.md) | — |
| Platform | [`platform/WELCOME.md`](platform/WELCOME.md) | [`../PLATFORM_LANE_HANDOVER.md`](../PLATFORM_LANE_HANDOVER.md) |
| Mobile | [`mobile/WELCOME.md`](mobile/WELCOME.md) | [`../MOBILE_LANE_BRIEF.md`](../MOBILE_LANE_BRIEF.md) |
| Hire & People | [`hire-people/WELCOME.md`](hire-people/WELCOME.md) | [`../TATVAOS_HR_ROADMAP.md`](../TATVAOS_HR_ROADMAP.md) |

**The two kinds of document, and why they are separate.** A *brief* or
*roadmap* is a decision record: what we chose and why, written before anyone
started. A *welcome* is what is actually in the repository today, what is
blocked and on whom, and the traps that cost someone a day. Briefs age slowly;
welcomes age fast. When they disagree, the welcome should say so out loud and
explain which is right — a new person who finds code contradicting the plan,
with no explanation, reasonably assumes the code is wrong.

Existing lanes without a welcome document have a handover instead:
[`../FRONTEND_HANDOVER.md`](../FRONTEND_HANDOVER.md),
[`../FAMILY_HANDOVER.md`](../FAMILY_HANDOVER.md).

**Everyone, whatever the lane:**

- `../HOUSE_RULES.md` — the canonical rules. Rule 11: every lane merges and
  deploys itself, and a deploy ships all of `main`, not just your branch.
- `../UI_LANE_BRIEF.md` — every new page uses Tailwind and `components/ui/`.
  Do not add pages to the YZEN Bootstrap template; it is being deleted.
- Migrations are additive. Rollback restores code, not schema.
- Amit is not a developer and is on Windows PowerShell 5.1. One command at a
  time, say what success looks like, and never `&&`.

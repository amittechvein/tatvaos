> **Added to the repository by the Hire session, 8 October 2026**, as the
> document itself asks (line 4). The text below is Mr. Singh's, unchanged.
> Where the first week stands: #267 and #271 brought up to `main` (§6 steps
> 1–2, both CI green; #271 gained a switch that keeps the sweep off), the
> employee-ID scheme in #409 (step 3), and the reporting hierarchy put back
> to Mr. Singh as a question rather than built — see #409's description.

# Hire and People — where the work actually stands

Written 8 October 2026 by Mr. Singh (CTO), for the developer taking this lane.
**Belongs in the repository at `docs/onboarding/hire-people/STATUS.md`.**

Read in this order:

1. **`docs/onboarding/hire-people/WELCOME.md`** — why this lane is built the way
   it is. Still worth reading in full. Section 4 below lists the parts of it
   that have gone out of date, so read this document before you act on that one.
2. **`docs/TATVAOS_HR_ROADMAP.md`** — the product plan, 15 phases. Amit has
   already settled the decisions that usually take a month of argument.
3. **This document** — what is built, what is half-built and sitting in two open
   pull requests, and what nobody has started.

Everything below was checked against the repository on 8 October 2026, not
recalled. Where I give a file or a table name, I read it.

---

## 1. What is built and live on `main`

**Database**

| Table | Migration | What it holds |
|---|---|---|
| `hire.job_openings` | `20260924-b-hire-job-openings.sql` | the openings themselves |
| `hire.team_members` | `20260924-c-hire-team.sql` | who in the organisation works on hiring |
| `hire.careers_sites` | `20260924-f-hire-careers-sites.sql` | the public careers page per customer |
| `core.locations` | `20260924-a-org-locations-designations.sql` | **Phase 0 item, now done** |
| `core.designations` | `20260924-a-org-locations-designations.sql` | **Phase 0 item, now done** |
| product rows | `20260909-hire-people-products.sql` | Hire and People as entitled products |

**API** — `apps/api/Modules/Hire/`: `JobOpeningEndpoints.cs`, `CareersEndpoints.cs`,
`HireTeamEndpoints.cs`, `JobOpening.cs`, and **`HireAccess.cs`**, which is the
one place that decides who may act on Hire. Read that file before you write any
endpoint; it is this lane's equivalent of `MailboxAccess.cs` and the same rule
applies — every handler asks it and nothing else.

**Web** — `apps/web/app/hire/`: the shell (`layout.tsx`, `page.tsx`), jobs
(list, `[id]`, `new`, and `_components/JobForm.tsx`, `JobStatus.tsx`), the
careers page, the team page, and `HireAccess.tsx`.

**Tests** — `tests/hire/`: `check-job-gate.sh`, `test-careers.sh`,
`test-job-openings.sh`.

**Decided** — decision `0010` (the careers portal) is merged. Domain support for
careers hostnames landed on the `core/hire-domain` branch.

So: **Phase 1's job-opening and careers groundwork exists.** Two of the four
Phase 0 gaps named in the welcome are closed.

---

## 2. What is half-built: two open pull requests, both stale

These are the previous developer's. They are complete pieces of work that were
**parked by Amit on 6 October**, not abandoned and not rejected — the queue was
being cleared and Hire had no customer waiting. Nothing is wrong with them that
I know of.

### #267 — `hire/candidates`

Last commit **28 September**. 18 files, ~2,240 lines.

- **New tables** (`20260924-d-hire-candidates.sql`): `hire.pipeline_stages`,
  `hire.candidates`, `hire.applications`, `hire.application_events`
- **Screens**: candidates list and new-candidate form, `ApplicationActions.tsx`,
  `CandidateForm.tsx`, and the per-job **pipeline** page
- Extends `tests/hire/` and adds ~92 lines to `tests/isolation/test-isolation.sh`
- Its last commit fixed a real concurrency bug: *"two first requests at once no
  longer deadlock on the default stages"*

### #271 — `hire/retention`

Last commit **24 September**. 24 files, ~3,260 lines. **Stacked on #267** — it
contains #267's candidates migration as well as its own.

- **New table** (`20260924-e-hire-retention.sql`): `hire.settings`
- **Screen**: `/hire/settings`
- `tests/hire/test-retention.sh`, 261 lines
- Its commit message records that it already carries rulings of mine: *"state
  the count, wait seven days, log the event, clock on edits only"*

### What these two will hit when you pick them up

Do not just rebase and merge. Three things have landed since they were written:

1. **The tenancy check** (`tests/tenant-filters`, arrived 7 October) asserts that
   every tenant-owned entity carries an EF query filter, computed transitively.
   **These two pull requests add five tables and predate it.** Expect to be
   flagged. When you are: do not file the exception yourself — bring me the
   facts (does it have `tenant_id`, does it have row-level security, who reads
   it, and what scopes the read if not the tenant) and a recommendation. There
   are two lists, "owed a fix" and "correct by design, do not fix", and putting
   a table in the wrong one is how a future developer "tidies" it and breaks it.
2. **`tests/isolation/test-isolation.sh`** gained a great deal in round one.
   Both pull requests add ~92 lines to it, almost certainly in the same region.
   Expect a conflict, keep both sides, additive only.
3. **`apps/web/lib/nav.tsx`** is a shared registry. Both touch it. Additive only
   — you may add, you may not change or remove what another lane put there.

**Merge order: #267 then #271**, since #271 is stacked on it. Bring #267 up to
`main`, build it, then rebase #271 onto the result.

---

## 3. What nobody has started

**Phase 0, still missing:** reporting hierarchy, and employee-ID configuration.
Small tables, not infrastructure. The welcome's suggestion to build these first
still holds — they are low-risk and they teach you the migration conventions.

**Phases 2 onward** are unstarted: interviews and assessments (2), AI
recruitment (3), offers (4), pre-joining and onboarding (5), and all of People
(6–15: employee records, attendance, leave, payroll, performance, learning,
assets, helpdesk, exit, analytics).

**Three design documents are owed before their code**, and I want to review each:

- **Sensitive data** — Aadhaar, PAN, bank details. Encrypted at rest separately
  from the rest of the row, access audited **per read**. The keep-everything
  retention ruling from the mail send API does **not** carry over. Before Phase 5.
- **Payroll build-versus-integrate** — PF, ESI, TDS, professional tax are
  statutory and the rates move with budgets. Still an open decision (roadmap §7).
  Settle it before Phase 9 is scheduled, not inside it.
- **Resume screening** — it ranks human beings. Must be explainable to a rejected
  candidate, and a human must be able to see and overturn it. Before Phase 3.

---

## 4. What has changed since the welcome was written

The welcome is from 9 September. Four parts of it are now wrong, and one of them
could get you into real trouble.

**4.1 You do not deploy. This is the important one.** The welcome's §7 says
"every lane merges and deploys itself". That was true then and is not now. There
is **one route to production** — the `Deploy production` workflow, dispatched
from `tatvaOS/` by whichever session holds the deploy, after Amit's explicit go.
Never `deploy.sh` over SSH by hand. On 16 September two sessions deployed within
minutes of each other by different routes and neither knew the other existed.

**4.2 Amit runs no commands.** Since 13 September. You run every command and
report what happened: the command, the result, what it means, and what would
have meant something else. He approves; he does not type.

**4.3 The YZEN template is gone**, deleted in the 16 September UI rewrite. The
rule in §5 stands — Tailwind and `components/ui/` only — but the thing it warned
you against no longer exists to be used by accident.

**4.4 There are new checks in CI that did not exist.** The tenancy check (§2
above), an AI-gate check asserting every AI entry point asks its organisation
list, a token-type check, and a dev-operator sign-in check. House rules 11–13
arrived with them: one deploy route, a step prints `[ok]` only when it checked
something, and every test run gets its own throwaway database.

---

## 5. Two traps in your path that are not in the welcome

**5.1 Three user roles exist in the dropdown and are enforced nowhere.**
`UserEndpoints.cs` offers `it_admin`, `manager` and `auditor` as assignable
roles. `Program.cs` defines exactly three policies — `SuperAdmin`, `OrgAdmin`
and `User` — and **none of the three roles above appears in any authorization
check.** An administrator can appoint a Manager today and it grants nothing.

This lands directly on you, because "a manager can see their own reports' leave"
is a Phase 8 sentence and `manager` is currently decorative. Either the roles get
built or the wording gets honest; Amit has not yet decided which, and it is on
his list. **Do not build a People feature on `manager` meaning something until
that is settled.**

**5.2 A label that promises more than the code grants will be found by a
customer, not by you.** On 5 October a shared-mailbox dialog told
administrators that a "Manager" could read a mailbox. The code granted only the
right to send. Nobody noticed for a month; it was fixed in #396 by making the
code match the promise.

HR is full of these — "approve", "view", "manage", "reports to". **Whatever a
screen says a permission does is a promise.** In this lane the promise is about
who can see somebody's salary, address or exit date. Check the sentence against
the code, in both directions, every time.

---

## 6. Your first week

1. **Bring #267 up to `main`, build it, and tell me what the tenancy check
   says.** Do not merge it yet. That one exercise teaches you the lane's code,
   the current CI, and the review relationship in a single pass.
2. Then the same for #271.
3. **Build the two remaining Phase 0 tables** — reporting hierarchy and
   employee-ID configuration. Low-risk, unblocking, teaches the migration
   conventions. Remember migrations re-run on **every** deploy: a file that
   works once and fails the second time breaks the *next* deploy, not yours.
4. Write the sensitive-data design document before any code touches Aadhaar,
   PAN or bank details.
5. Do not start the public careers portal until the welcome's §4 obligations have
   owners — in particular the certificate `ask` endpoint, which **must fail
   closed**. If it fails open, anyone pointing a hostname at our IP triggers a
   certificate order and we exhaust the authority's rate limit, at which point
   issuance breaks for every TatvaOS domain, not just this feature.

---

## 7. How to work with me

I review this lane. Anything touching sign-in, tenancy, a migration, `deploy.sh`,
`verify-live.sh` or CI comes to me **before it merges** — judged by what the
change *does*, not which folder it sits in. A twenty-line change in `apps/web`
that alters who can see someone's salary is an access change.

Send me what you found, what you ran, and **what would have proved you wrong**.
That last part is the one I actually read first.

Two things about me, so you can work around them:

- **I review from the copy of the repository on Amit's laptop and I cannot reach
  GitHub.** Run `git fetch origin` in `tatvaOS/` before asking me to read
  anything, or I will be reading a stale branch. Two of my mistakes this week
  came from exactly that.
- **I get things wrong, and I would rather be corrected than agreed with.** This
  week a session proved my diagnosis of a translation bug was wrong, another
  refused an instruction of mine that would have rendered every rupee sign in
  the wrong font, and a third found that a premise I had asserted was simply
  untrue. All three were right to do it. If you think I am wrong, say so and
  show me the file.

And the standard from the welcome's §9, which has not changed and matters more
here than anywhere else in the suite: **when you build a check, make it fail on
purpose once and show me the red.** You are building the product that holds
people's identity documents, salaries and rejections. A check that has never
gone red is not a check.

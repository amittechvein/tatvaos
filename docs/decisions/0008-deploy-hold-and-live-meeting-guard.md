# 0008 — A deploy refuses while a meeting is live, or while a hold is set

**Status:** proposed design, for Mr. Singh's gate on `deploy.sh` and the CI
workflows. **Nothing is built, and neither file is touched until this is approved.**
**Date:** 2026-09-21
**The rule itself was adopted by Mr. Singh on 20 September:** "Adopt the deploy
hold/active-meeting guard, with emergency override recording authorizer, reason,
deployed version, live-check owner, verdict, and rollback point." This record is
only *how*.

## Context

**19 September, 11:35 UTC.** A deploy (run 35440548065) went out while Amit's
company-wide meeting was live. Amit had said "merge and deploy"; nobody asked
whether a meeting was running. His "do not deploy in mid" arrived after it
finished. The media server was not restarted, but the API and web were, for about
a minute: joins, waiting-room admits, host controls and captions could not work.
Guests who reloaded during that minute probably added rows towards the guest
ceiling that locked people out later that evening. That link was never confirmed:
production's row count was not read.

Since then the only protection is a habit: the developer session asks Amit
"is any meeting live?" before every dispatch. A habit held by one session is not
a control. Two sessions deployed within minutes of each other on 16 September
without knowing about each other.

What exists today, and must not be duplicated:

- `deploy.sh production` only. There is no staging server; the old "testing"
  environment was removed.
- `flock`: a second deploy on the box is refused.
- A `pg_dumpall` before anything changes; the deploy **stops** if it fails.
- `verify-live.sh` and the build-SHA comparison at the end.
- The workflow: manual dispatch, a typed `production`, a GitHub environment
  approval, and "CI green for this exact commit".

## What the guard checks — two things, and nothing else

**1. A hold a person set.** A platform setting `deploy.hold` holding a reason and
an end time, set from the operator console, e.g. "Company meeting, until 19:30 IST".
While it is set and unexpired, the deploy refuses and prints the reason and who
set it. Covers what no measurement can: a meeting about to start, a demo, an exam.

**2. A meeting that is live now.** Measured from the database, in the same way the
API already decides who is in a room (`ConnectEndpoints`, the replay of
`participant_joined` / `participant_left` events):

```
meetings with status = 'active'
  that have at least one identity whose LAST event is participant_joined
  and whose last event is less than 6 hours old
```

It prints the count and the largest room's head-count, never titles or names.

**Where it runs.** In `deploy.sh`, as the first step after the lock and before the
pre-deploy backup. **Nothing has been touched when it refuses.** A new file,
`infra/scripts/deploy-guard.sh`, sourced there, so the query lives in one place.

## The override, as adopted

The workflow gains inputs that are empty by default:

| Input | Required when overriding |
|---|---|
| `override_reason` | why this cannot wait |
| `override_authorizer` | who decided (Amit, or Mr. Singh) |
| `override_live_check_owner` | who is watching the live meeting during the restart |

Without all three, a refusal is final. With them, the deploy proceeds, and the
guard writes **one row** to a new append-only table `ops.deploy_overrides`:
authorizer, reason, live-check owner, deployed version (full SHA), rollback point
(full SHA), what the guard saw (hold text, live-meeting count), and — filled in
by the same run's last step — the verdict line. The run log prints the same.

The rollback point is taken from the **workflow's own history of successful
deploys**, not from the running container. `deploy.sh`'s current printed line
reads the container and has been wrong twice.

## The override path in full

Mr. Singh, 21 September: "six fields is right, but I want to know who can invoke
it and what happens afterwards, because an override nobody reviews is a gate
that isn't there."

### A fact found while writing this: the second approver does not exist today

`deploy-production.yml` says, above the deploy job: *"Requires a reviewer in
GitHub -> Settings -> Environments -> production. A typed string is a speed
bump; an approval is a second person."* Asked of GitHub on 21 September:

```
gh api repos/amittechvein/tatvaos/environments/production
{"name":"production","protection_rules":[]}
```

**For the record, as Mr. Singh ruled on 21 September:** the claim entered the
repository on **4 August 2026**, in commit `9963094` ("TatvaOS Core schema, cloud
environments, CI/CD"), the commit that created this workflow. On **21 September**
GitHub showed no protection rules. Between those dates **45 production deploys
succeeded** (the first on 6 August). Whether a reviewer was ever configured and
later removed cannot be told from the repository; GitHub's settings keep no
history visible here. Either way, the documented gate was not there on the day
it was checked, and every one of those deploys should be read as having had one
person behind it.

**No protection rules. No required reviewer.** Every deploy so far went out on
one person's dispatch and a typed word. The comment describes a control that is
not configured — the codebase's signature failure, a check that looks applied
and is not. Only Amit can fix it: GitHub, signed in as him, Settings →
Environments → production → Required reviewers. The override design below
depends on it.

### 21 September, later: the hold withdrawn, and what replaces it

**Mr. Singh withdrew his hold** ("nothing ships until Required reviewers is on")
the same day. Their words: the setting isn't off, it no longer exists to turn on.
The repository went **private** on 21 September. GitHub then removed the whole
*Deployment protection rules* section from the `production` environment page,
because those rules are not available for private repositories on this plan.
They said a hold whose condition cannot be met is a bad rule. They said the rule
was theirs, and they withdrew it rather than have it routed around.

**The override is recorded, not absorbed.** Before the withdrawal, Amit told the
deploying session to deploy without a reviewer. That session did not deploy.
It put the question to Mr. Singh, who answered with the withdrawal above.

**What replaces it, effective 21 September:**

1. **The false claim is gone.** `deploy-production.yml` no longer says that a
   reviewer gates production; both places now say none does. This change is in
   this pull request.
2. **Second reader, in the pull request.** Before a production deploy, a named
   person who is not the deployer writes in each pull request being shipped that
   they have looked at what is shipping. PR 195: Mr. Singh, on record. PR 198:
   Amit, one line, owed.
3. **GitHub Team, to be decided on purpose.** Paying for GitHub Team restores the
   real gate. That is Amit's decision. Whatever the answer is, record it here.
   Do not let "we can't" drift into "we don't".

### 22 September: the repository is never made public to get Actions minutes back

**Root cause of the public windows, from Amit's GitHub security log.** The
repository was created private on 4 August. It was made public twice, both
times when the private-plan Actions quota ran out: on 16 September from 11:04
to 11:59 UTC, and from 16 September 18:07 to 21 September 11:38 UTC. The second
window lasted 4 days 17½ hours. On 16 September this looked like "Actions
billing came back the same afternoon". It was the visibility switch.

What the inventory of 22 September found in that window: no provider keys or
private keys in any commit or pull request text. It found four development and
CI values. A same/different check on production showed that none of them is
live, and Postgres itself refuses both development passwords. All 295 workflow
runs during the windows came from Amit's account in this repository. No workflow
has ever used `pull_request_target`. The one `workflow_run` trigger was deleted
on 12 August. Whether anyone cloned the code is **not** known. GitHub's Traffic
view would show it for 14 days, but on this plan it is locked.

**The rule, set by Mr. Singh on 22 September:** this repository is never made
public to restore GitHub Actions minutes, for any length of time. If the quota
is the problem, the answer is the plan or a wait, never the visibility switch.
The same plan limit has now blocked required reviewers, Actions minutes, and the
Traffic evidence. Decide the plan on purpose (item 3 above) instead of working
around it each time.

The *Who can invoke an override* table below assumes the environment approval
exists. Until item 3 is decided, that row does not apply. The typed
`override_authorizer` is checked against the list and nothing else.

### Who can invoke an override

| Layer | Who | Enforced by |
|---|---|---|
| Dispatch the workflow | anyone with write access to the repository | GitHub |
| Approve the production job | the required reviewers: **Amit and Mr. Singh** | GitHub environment protection — **once Amit turns it on** |
| Be named as authorizer | only a name on a list in the repository, `infra/deploy-override-authorizers` (Amit, Mr. Singh). Anything else refuses | the guard |
| Be the live-check owner | anyone, but it must be filled, and it cannot be the dispatcher's own GitHub name unless the authorizer is also that person | the guard |

**The honest limit.** `override_authorizer` is typed text; the guard can only
check that it names someone on the list. What makes it true is the environment
approval: GitHub records which named reviewer pressed Approve, and the guard
copies that name into the record next to the typed one. If the two differ, the
record says so in its first line.

### What happens afterwards — so it is reviewed, and cannot be forgotten

1. **The record.** One row in `ops.deploy_overrides`: run id, dispatcher
   (`github.actor`), approving reviewer, typed authorizer, reason, live-check
   owner, what the guard saw (hold text, live-meeting count and largest room),
   deployed version and rollback point (both full SHAs), and the verdict line.
   Append-only: `UPDATE` and `DELETE` revoked from the application role, as for
   the other append-only tables.
2. **A review item is opened by the same run.** A GitHub issue labelled
   `deploy-override`, assigned to Mr. Singh, holding the record. The workflow
   gains `issues: write` for that one step.
3. **The review.** Mr. Singh reads it and closes the issue with a one-line
   verdict: *accepted*, or *not acceptable — reason*. A second override
   referencing an unreviewed one says so.
4. **The next deploy refuses while any `deploy-override` issue older than 72
   hours is still open.** A review item can be closed by **Mr. Singh or the named
   deputy** — both are on the `infra/deploy-override-authorizers` list, marked as
   reviewers. Mr. Singh, 21 September: a gate that only one person can clear is
   "an outage waiting for a holiday". **The deputy is not named yet**; this record
   is not accepted until a name is written here: `DEPUTY: ________`. Checked in the workflow, on the runner, before SSH —
   the runner can ask GitHub; the server cannot. That refusal can itself only be
   overridden with the same three fields, which opens a second issue. So an
   unreviewed override blocks the pipeline within three days instead of
   disappearing into a log.
5. **Monthly**, the list of closed override issues is part of the CTO's review.
   If overrides are routine, the guard is wrong, and this record is reopened.

### Added to "what would prove it works"

| Case | Expected |
|---|---|
| Override with an authorizer not on the list | refuses |
| Override approved in GitHub by someone other than the typed authorizer | proceeds; the record's first line says the two names differ |
| An override issue open for 73 hours, then a normal deploy | refuses before SSH, naming the issue |
| The same, with the issue closed | proceeds |

## House rules this has to keep

- **Rule 12: `[ok]` only after a check.** The guard prints `[ok] no live meetings`
  only after the query ran and returned a number. If the database does not answer,
  the guard **refuses** and says so. A guard that fails open is not a guard.
- **Migrations additive.** One new table and one new setting. No change to any
  Connect table.
- **Tell Amit before you deploy** stays. The guard is the net under the habit, not
  a replacement for it.

## What would prove it works — to run before merge

| Case | Expected |
|---|---|
| No hold, no active meeting | proceeds; prints `[ok]` for both checks |
| Hold set, unexpired | refuses before the backup step; prints the reason; exit ≠ 0 |
| Hold expired | proceeds |
| One active meeting, one identity joined in the last hour | refuses; prints "1 live meeting, 1 person" |
| Active meeting, everyone has left | proceeds |
| Active meeting, last join 7 hours ago, no leave (a missed webhook) | proceeds, and prints a warning naming the stale meeting |
| Database unreachable | refuses |
| Override with all three inputs, meeting live | proceeds; exactly one `ops.deploy_overrides` row with both full SHAs and the verdict |
| Override with only two inputs | refuses |

Each refusing case is **red first**: written and run against today's `deploy.sh`,
where it proceeds, before the guard exists. Run on the server's scratch clone
(`~/tatvaos-scratch`) against a copy of the compose stack, never against
production's.

## Known limits — said now, not found later

- **It trusts the webhooks.** A missed `participant_left` keeps a room "live"; the
  6-hour bound and the warning cover that. A missed `participant_joined` makes a
  live room invisible. Asking LiveKit directly for its rooms would remove that
  dependence but needs a signed request from a shell script — a larger change,
  offered as option B below.
- **It does not see a meeting about to start.** That is what the hold is for.
- **A guest-only room** is counted like any other: guests produce the same events.

## Options for Mr. Singh

- **A. As above:** database presence plus a hold. Small; one new file, one small
  table, one call in `deploy.sh`, three workflow inputs.
- **B. A, but live-ness asked of LiveKit itself** (`ListRooms`, rooms with
  participants). Truer; more code in the most sensitive script.
- **C. Hold only.** Cheapest. It depends on a person remembering, which is what
  failed on 19 September.

**Recommended: A**, with B as a later step if a missed webhook is ever seen.

## Questions

1. A, B or C?
2. Who may set a hold: only the operator (Amit), or organisation owners for their
   own meetings as well?
3. Six hours as the staleness bound?
4. Is the `ops` schema right for the override record, or should it live in
   `core.audit_logs` under a platform action?
5. Is 72 hours right for an unreviewed override to start blocking deploys?
7. Who is the deputy who may clear an override review when Mr. Singh is away?
6. **Not a question for you but a blocker:** Amit turns on Required reviewers for
   the `production` environment (Amit and Mr. Singh). Until then, nothing in
   this record has a second person behind it.

## Revisit when

- A deploy is ever refused wrongly, or passes while a meeting was live.
- A staging environment exists again.
- Connect moves to its own server.

## Deployment rule, added 24 September: exactly one API container

**Mr. Singh's ruling on PR 273 (TatvaOS Docs), 24 September:** the constraint
goes into this record as a deployment rule, "not a code comment. A rule that
lives only in prose is not a rule."

**The rule.** Production runs **exactly one `api` container**. Never
`docker compose up --scale api=N` with N > 1, never `replicas:` on the `api`
service, and never a second API process against the production database —
including a debugging copy pointed at it from `~/tatvaos-scratch`.

**Why.** Docs live editing keeps each document's room in the API's memory. Two
API processes put two people editing one document into two rooms: they stop
seeing each other, and their work meets only at a checkpoint, where one of
them can lose a paragraph. Silent, data-losing, and triggered by an ordinary
"more replicas for availability" decision. (The per-person connection cap is
per process too, so it would also halve.)

**How it is enforced, not just written.** `apps/api/Modules/Docs/DocsInstanceGuard.cs`
takes a Postgres advisory lock for the life of the process. Only the holder
serves live editing. Any other instance answers `503` to
`/api/docs/{id}/live`, so no browser can join a split room, and logs at
CRITICAL once a minute:

    SECOND API INSTANCE DETECTED. Another process holds the Docs single-instance lock ...

It does **not** refuse to start. A refusal would turn the normal deploy
overlap, where the new container is up a moment before the old one exits,
into a failed deploy, and would take Mail and Connect down for a Docs-only
constraint. The second instance re-tries every 15 seconds, so that overlap
resolves itself.

**What would prove it works.** Two API processes against one database: the
second logs the CRITICAL line and refuses `/live` while the first serves;
stop the first, and the second takes over within about 15 seconds. Run
locally for PR 273; see that PR for the result.

**When this rule may change.** Only together with a cross-process broadcast
for Docs rooms (Postgres LISTEN/NOTIFY or Redis) and a cross-process
connection cap. Both are a design change, to be brought here first.

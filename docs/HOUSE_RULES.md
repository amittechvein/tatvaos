# House rules

*The single source. `WELCOME_CORE_DEVELOPER.md`, `WELCOME_PLATFORM_DEVELOPER.md`
and `PLATFORM_LANE_HANDOVER.md` point here rather than restating these — they
each carried a full copy until 30 Aug 2026, which is exactly the defect rule 10
describes.*

Every rule below has an incident behind it. The incidents are named because a
rule without its cost gets optimised away by the next person in a hurry.

---

## 1. Lanes

Your module's files are yours to change freely. Another module's files are
ask-first. If production is burning and you must cross a line, do it and
**declare it in the commit message**.

Shared registries — `AppDbContext.cs`, `Program.cs`, `apps/web/lib/nav.tsx` —
are **additive-only**. Adding a `DbSet` for an entity your own module owns needs
no ask; it cannot break another lane. Renaming or removing someone else's entry
is ask-first, always.

*Cost: two people spent a day fixing the same backtick in different ways. And a
three-line `DbSet` registration blocked a finished feature for three days
because the ask was queued behind a busier person.*

## 2. Migrations

Date-prefixed with the **real** date, idempotent, additive. Must survive
`infra/scripts/verify-migrations.sh`, which builds every migration against a
scratch database from empty, then runs the whole directory again.

Both halves matter: the first catches a file depending on one that sorts after
it; the second catches a file fighting a later one.

*Cost: `20260901`–`20260910` are a sequence wearing September dates in August.
Two Core files had to adopt the same false dates to sort after them. A fix dated
before the file it amended would have altered a table that did not yet exist on
any fresh box.*

## 3. Build before commit; count files before push

`git diff --cached --stat`, read the number, then push. A green build proves
your **working tree**; the commit ships the **index**. They are not the same
thing, and untracked files are compiled by the build and absent from the commit.

*Cost: a staged file referencing an unstaged one built green locally and broke
on the server.*

## 4. Merged is not running

Config that renders at container start does not change because you deployed. And
a container's environment is fixed at creation — a variable added afterwards is
invisible inside it until the container is recreated.

When you add a service, decide **at birth** how its config reaches the running
process, and write it down.

*Cost: an outbound-TLS fix sat correct in git for four days while real mail went
out unencrypted. Separately, `PLATFORM_DOMAIN` reached `.env` and the compose
file and still took the site down, because the running Caddy predated both —
pulled-but-not-recreated, which looks identical from outside to
merged-but-not-pulled and has a different remedy.*

## 5. Secrets never appear in output

Not in a log, not in a terminal, not in a chat window. Generate them where
they are used — `read -rsp`, or written straight into the destination file.

**A command whose output is a secret is unsafe by construction; one that writes
it to its destination is safe by construction.**

Every secret's blast radius includes the nightly backup: `backup.sh` copies
`infra/docker/.env` verbatim, and says so in its own comments. That is why the
bucket credentials live in `/srv/backups/tatvaos/.backup-env` and deliberately
not in `.env`.

*Cost: every key generated on a laptop so far has ended up pasted into a
transcript and had to be burned.*

## 6. A check with no failure mode is not a check

Before running one, ask **what result would prove you wrong**. If nothing could,
you are confirming, not verifying — and you can tell without executing it once.

The common form is comparing a post-state against your *memory* of the
pre-state. Capture the before, or compare against the source of truth:
`git show origin/main:<file>` is the pre-state; what you remember writing is not.

*Cost: eleven instances in one week across workflows, scripts, configs,
migrations and comments — `deploy.sh` comparing the running count against
itself; a queue check whose `|| true` reported a healthy empty queue when
Postfix was dead; smoke tests that pass with the mail server down, directly
below a comment naming that exact failure as the worst this product has; a
marker count blind to the unmarked copy that already existed. See
`docs/reviews/` for the catalogue.*

## 7. Ask what breaks if it is violated — **and what breaks if it is enforced**

Rule 6's second half. An invariant nobody enforces is a wish; an invariant
enforced without checking what depends on the slack is an outage.

*Cost: a unique index that correctly enforced one-active-app-password-per-mailbox
would have thrown `23505` on every replacement password — deterministically, for
every customer, on the second password a person generates, which is the one they
generate because the first stopped working. The model knew nothing of the index,
so the ORM was free to order the insert before the revoke.*

## 8. Documented is not built

When a document or comment tells you what the code does, **grep for the caller**
before you believe it. That includes every document in this folder.

*Cost: three "documented behaviours" in one week that had never existed — a seam
whose two ends had no callers, a sandbox guarantee describing different code, a
comment promising production TLS on a port serving cleartext. Then a comment
stating "Caddy tolerates an empty site block" three lines above a correct warning
saying the opposite. The wrong one won, because it was the line the code
executed.*

## 9. No counts and no line numbers in comments or markers

Both are facts that decay silently and are trusted absolutely. Name the path;
let grep find the line.

*Cost: a marker block saying "five locations" was stale before it merged — the
real number was six or seven depending on how you count, and one copy was
discovered while the list was being written. An API settings block moved from
line 91 to 99 inside a day.*

## 10. One implementation of a fact

If a value or a behaviour appears twice, one copy will drift and read as
authoritative. Prefer one implementation called from both places. Where
duplication is genuinely unavoidable, mark every copy, name the root and the
direction of the dependency, and **enforce it by grepping the value, not by
counting the markers** — a count cannot see an unmarked copy.

Exceptions lists carry a **reason per line**, and reasons come in two kinds that
must not be blurred:

- **not the thing at all** — `587.33 — audio frequency, D5 knock chime`
- **the thing, but a different concern** — `container-internal port; moves with
  the compose mapping, not with the customer-facing set`

Writing the second as "not a port" invites the next person to delete it as a
false match.

*Cost: the client connection ports live in six or seven places including DNS SRV
records that configure other people's software silently. These rules themselves
existed in three documents until this file replaced them.*

---

## Why this keeps happening to careful people

**The failure is not in the writing. It is in the direction of attention:
writing the reasoning consumes exactly the care that checking the mechanism
would have.** A well-argued comment feels like a discharged obligation, and it
reads like one to everybody afterwards.

That is why none of the rules above is "be careful." Everyone involved in every
incident listed here was being careful. They are structural on purpose.

The antidote that actually worked, every time, was cheaper than any of it:
**run it.** Two dead checks were found in ninety seconds by execution after
several hours of careful reading by several people had missed them.

---

*Amendments are welcome and should arrive as a pull request with the incident
attached. A rule without a cost behind it does not belong here.*

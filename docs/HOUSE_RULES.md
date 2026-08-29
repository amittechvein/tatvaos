# House rules

*The single source. `WELCOME_CORE_DEVELOPER.md`, `WELCOME_PLATFORM_DEVELOPER.md`,
`PLATFORM_LANE_HANDOVER.md` and `WORKING_IN_LANES.md` point here rather than
restating these. Each carried its own copy until 29 Aug 2026 — and the claim in
this paragraph was written before that was true, so for two days the file
asserting rule 8 opened with an instance of it. The copies were removed rather
than corrected: a corrected copy is still a copy.*

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

*Cost, the obvious half: a marker block saying "five locations" was stale before
it merged — the real number was six or seven depending on how you count, and one
copy was found while the list was being written. That one was wrong when
written.*

*Cost, the half that makes this structural: a review cited
`deploy.sh:547` for the `verify-live.sh` call. Read a day later, the call was at
line 575. **Both numbers were true.** At the commit the reviewer had fetched it
was 547; eight commits landed in between, one of them adding twenty-eight lines
above that call, and it became 575. Nobody was hurried, nobody misread, nobody
touched the sentence. The citation did not decay because someone was careless —
it decayed because the file moved underneath a true statement, which no amount
of care prevents. That is why the rule is "don't write the number", not "check
the number".*

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

## 11. Every lane merges and deploys its own work

Amit's ruling, 29 Aug 2026. Nobody waits on Core to merge or deploy. Core still
owns `Shared/`, `infra/`, migrations as a set, and rulings — he is the person you
ask, not the person you wait for.

**A deploy ships all of `main`, not your branch.** You are not deploying your
feature; you are deploying the product, including everyone else's merged work
and everyone else's pending migrations. So `main` must always be deployable, and
a deploy that breaks something that isn't yours is still your deploy: roll back
first, diagnose after, say so immediately.

**The sequence, every time:**

1. In your lane: `git fetch origin`, rebase onto `origin/main`, then
   `dotnet build apps\api` and `npm --prefix apps\web run build`. Both green.

   **After a rebase git will report your branch as "diverged" from its remote
   copy and suggest `git pull`. Do not.** That merges your own pre-rebase
   commits back in and duplicates the work. The divergence is the expected
   result of rewriting your own history, not a problem to repair — git's
   suggestion is wrong here because it cannot tell a rebase from someone
   else's push. To update the remote copy of *your own* branch, use
   `git push --force-with-lease` — never bare `--force`, which overwrites a
   colleague's push without telling you.
2. In `tatvaOS`: `git pull`, `git merge --no-edit <branch>`. **If the pull
   brought anything down, build again HERE before pushing** — you rebased against
   a `main` that has since moved, and nobody has built the combination that is
   about to ship. Then `git push origin main`. Separate lines; PowerShell 5.1
   has no `&&`.
3. **Before deploying**, not before pushing: if `main` contains any migration
   you have not already run, run `infra/scripts/verify-migrations.sh`. The
   deploy applies *everyone's* pending migrations, so this is the deployer's
   check, not the author's.

   **While CI is unavailable, the author runs it too, before pushing.**
   `verify-migrations.sh` lives in CI's isolation job, so when CI is down
   nothing anywhere tests migration ordering automatically — the person
   shipping a migration is then the only person who will ever have tested it.
   Same standing as the two builds, for the same reason.
4. On the server (host in `docs/setup/00-command-reference.md`): record
   `git rev-parse --short HEAD` as the rollback point, `git fetch origin`,
   `git reset --hard origin/main` — which must name a **different** commit than
   the one you recorded — then `./infra/scripts/deploy.sh production`.

   **Run `deploy.sh`; do not hand-roll the compose command.** It builds its
   invocation with `--env-file infra/docker/.env` — not the repo-root `.env`,
   which is a different file with different contents. A compose command typed
   by hand reads the wrong one silently: the containers start, and their
   environment is quietly not production's. Read the compose block in
   `deploy.sh` rather than trusting this sentence.

**Rollback restores code, not schema.** `git reset --hard <sha>` and redeploy
puts the code back; a migration that has already run stays run. That promise
only holds because rule 2 requires migrations to be additive — which makes rule 2
load-bearing here in a way it was not when one person deployed. The first
destructive migration anyone writes breaks the rollback story, so it doesn't get
written without a conversation.

**One deployer at a time — the lock is enforced.** `deploy.sh` takes an
exclusive `flock` and a second deploy is refused outright with
`Another deploy is already running on this box.` **Announce anyway** — "deploying
now" before, "deploy done" or "rolled back" after — so people know *why* the box
is busy rather than only *that* it is. The lock stops the collision; the
announcement stops the confusion.

**Paste the output, not a tick.** The verdict line and the service count.
`verify-live.sh` is already in that log — `deploy.sh` calls it and refuses
success on its failure — so it is not a separate step to run, and a passing
deploy is not evidence that it was skipped or optional.

*Cost: a finished feature sat blocked for three days behind a three-line edit
because one person was the gate. This trades that queue for a discipline —
both builds green, rebuilt after the pull, rollback SHA written down, announce
before, paste after — and the discipline only matters on the days somebody is
in a hurry.*

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

# House rules

*The single source. Every welcome document under `onboarding/`,
`PLATFORM_LANE_HANDOVER.md` and `WORKING_IN_LANES.md` point here rather than
restating these. Each carried its own copy until 29 Aug 2026 — and the claim in
this paragraph was written before that was true, so for two days the file
asserting rule 8 opened with an instance of it. The copies were removed rather
than corrected: a corrected copy is still a copy. The welcomes moved into
`onboarding/<lane>/WELCOME.md` on 9 Sept 2026, when the mobile developer started
— Hire & People has a welcome but no developer, Amit having put that lane on
hold on 8 Sept pending the Core handover; this paragraph now names the folder rather than the
files, because a list of filenames here is itself a copy — one that goes stale
the next time somebody is hired.*

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

**A byte count is not a checksum, and a checksum is not the content.**

*9 Sept 2026.* Three files were sent to the production box as base64 chunks and
verified with `wc -c`. Every count matched. The terminal had substituted a
duplicated fragment of the same length, so the length was right and the bytes
were wrong. `gunzip` then failed with a CRC error, python ran the truncated
script anyway, and it edited three files and printed success on all of them.
What caught it was an `md5sum` of the decoded script — which did not match.

Three checks, three different questions:

- `wc -c` answers *is it the right size*. Passes under substitution.
- `md5sum` answers *is it the bytes I sent*. Passes if I sent the wrong thing.
- Reading the result answers *is it what I wanted*, and nothing else does.

The same failure appeared twice more that day, one layer apart each time.
`deploy.sh` recorded a rollback commit from `git rev-parse`, which answers
"what is this directory sitting on" and not "what is running". And a green
deploy verdict meant "every step succeeded", which is not "the containers are
running the new code".

**So: verify the artefact you care about, from the place it actually lives.**
A check that measures something adjacent to the thing is not a weak check, it
is a check-shaped object — it reports success while the thing it stands for is
false, and it does so most confidently exactly when something has gone wrong.

**Calibrate the red, both ways — CTO, 17 Sept 2026.** Showing a check red on
purpose is not enough: a check can go red for the wrong reason, and it can
stay green under calibration, and only the calibration tells them apart. So:

- when a check goes red under calibration, confirm it went red **for the
  reason you broke**, not for something else that happened to be broken;
- when a check stays green under calibration, the check is measuring
  something other than what it claims. That is not an inconvenience to work
  around; it is the check telling you it has been lying.

Three in one week, each obeying the "show it red" rule and still wrong:

- *The isolation suite.* Deleting the security policy made the table
  unreadable to everyone, so every leak check passed — for the wrong reason.
  The "can I see my own row" case is what caught it.
- *The Caddy guard (PR 150).* Its first calibration run went red, but not
  for the stale config it was meant to catch: busybox `wget` resolved
  `localhost` to IPv6 while Caddy's admin endpoint listens on 127.0.0.1, so
  the guard was comparing against nothing. Red for the wrong reason.
- *Stage 3's userinfo liveness check (PR 154).* With the check patched out,
  the suspended person's token still answered 401 — because refresh-reuse
  detection had already revoked it a few lines earlier. The 401 owed nothing
  to liveness, and the check had never tested what its name said. Green
  under calibration; the step was rewritten to use a fresh token, and only
  then did the patched build fail it.

**And it must fail at the assertion — Mr. Singh, 25 Sept 2026.**

> A calibration must fail at the assertion it exists to exercise — not during
> setup, not on a load error, not anywhere else. A red that arrives before the
> check runs is noise.

*The cost.* PR 277 moved a unique constraint so that several organisations
could hold a pending claim on one domain while only one could hold a verified
one. Its first calibration copy was that migration with the `DROP CONSTRAINT`
removed — and the run did go red, with
`duplicate key value violates unique constraint "domains_fqdn_key"`. But that
red arrived while *loading the test state*, before a single expectation was
evaluated. It proved the premise — two pending claims are impossible under the
old rule — and calibrated nothing, because no assertion had run. The copy was
changed to the migration with the new index removed, which is the mistake
actually worth catching: the one that lets two organisations both hold a
verified claim. Two expectations then went red, and the greens meant something.

**Two signals that agree are not corroboration — Mr. Singh, 25 Sept 2026.**

> A compound failure gets past every reader, because the two things they would
> cross-check against each other agree.

*The cost.* `verify-one-migration.py` had two defects at once, and they
propped each other up. It passed psql's connection URI before its options;
Windows psql does not permute arguments, so every option was discarded with a
warning — and psql then **exits 0 having applied nothing**, for a real
migration and for `this is not sql at all;` alike. Meanwhile the summary
printed `Proved: … the expectations above hold` whatever had happened. So a
run could report

```
  PASS  run 1 of 2 applies cleanly
  PASS  run 2 of 2 applies cleanly
ALL CHECKS PASSED                      (exit 0)
```

on a file that was not SQL. The usual defence — *don't trust the prose, check
the exit status* — was useless here, because the exit status was wrong in the
same direction as the prose. Only `--expect` made a noise, and only because it
compares text; both runs in the tool's fourteen-day life happened to use it,
which is luck and not design. The tool now aborts on any ignored option (#279).

*And the ruling that was wrong.* Mr. Singh first called this defect
"embarrassing but not dangerous — it fails loudly". It does not fail loudly;
with `--expect` absent it does not fail at all. In his own words, 25 Sept:

> I reasoned that from the symptom you'd described, and I didn't measure it.

> I called something safe that wasn't, on reasoning rather than evidence.
> That's the same error I've been holding everyone else to. Put the correction
> in the record next to the incident.

*Everything in this entry except the indented quotations is written by the
Claude Code session that found the defect, not by Mr. Singh. He asked for the
correction to be recorded; he has not checked this wording. If it misstates
him, the error is the transcriber's.*

**A pipeline reports every stage — Mr. Singh, 25 Sept 2026.**

> A pipeline whose failures matter reports every stage's exit code. One that
> sends its own errors to `/dev/null` can pass while broken and can't be
> diagnosed when it fails.

*The cost.* The restore drill (#286) ran five commands in a pipe — fetch,
decrypt, untar, gunzip, psql — with every stage's stderr discarded. Its
calibration failed twice and neither failure could be explained: the output was
a bare "success" or "failure" with nothing behind it. Reading `PIPESTATUS` per
stage made both visible in one run, and both turned out to be defects in the
calibration rather than the pipeline — a "truncated" object that still
contained the whole member, and state leaking between cases.

`set -o pipefail` tells you the pipeline failed. It does not tell you which
stage, and on a five-stage pipe that is most of the answer. Capture
`PIPESTATUS` into an array **before any other command, including an
assignment**, and print it when something goes wrong.

Note also what the discarded stderr cost: the one line that explained the
second failure — `ERROR: relation "drill_probe" already exists` — was being
produced the whole time and thrown away.

*Everything in this entry except the indented quotation is written by the
Claude Code session that hit it, not by Mr. Singh. He asked for the rule to be
recorded; he has not checked this wording. If it misstates him, the error is
the transcriber's.*

**Two nothings agreeing is not a match — Mr. Singh, 25 Sept 2026.**

> A comparison must first prove both sides are non-empty. Two nothings agreeing
> is not a match.

*The cost.* Two sessions hit this on the same script on the same day, and found
it independently. On the #254 restore drill, a schema query errored on **both**
sides with a `text || "char"` cast, the two empty answers compared equal, and
the run printed ok; a count query failed on a trailing space and counted 0
tables, and also printed ok. Two whole drill runs were invalid. On #286's
calibration, the same shape twice: a comparison that would have passed on two
blanks, and a "truncated" object that wasn't truncated.

The cure is cheap and belongs in the comparison itself, not in a reviewer's
attention: demand a real answer before allowing a pass — a 32-character hash, a
count that is a number and greater than zero, a non-empty string on both sides.
The drill now refuses to compare unless both sides return a number; the #254
drill now demands more than 0 tables and rows before any equality can count.

This is the oldest failure in `docs/` — `testing-false-greens` — and it keeps
coming back because it is invisible: the check does not error, it agrees.

*Everything in this entry except the indented quotation is written by the
Claude Code session that hit it, not by Mr. Singh. He asked for the rule to be
recorded; he has not checked this wording. If it misstates him, the error is
the transcriber's.*

**A precondition is not the operation — Mr. Singh, 26 Sept 2026.**

> The PR measured that `deploy` can read `.backup-env`. It did not measure
> that `conf_value` — new code, a subshell sourcing that file and extracting
> one variable — produces the passphrase from that file's actual contents.
> Those are different claims. I read "readable by deploy" and treated it as
> "the new function works on production," which it does not establish.

*The cost.* PR 254 makes `deploy.sh` stop rather than write an unencrypted copy
of production, so an empty passphrase is fatal by design. The evidence offered
was that the deploy user can read the file holding it. That is a precondition
of the parse, not the parse: the new `conf_value` sources the file in a
subshell, and a file can be perfectly readable and still yield nothing through
that path. The gap was closed by running the actual mechanism on the server —
which printed `passphrase resolves via conf_value: yes` and cost one command.
Had it printed NO, the first deploy after the merge would have stopped dead,
with the cause three functions from the message.

So: when a check stands in for an operation, say which one you ran. "The file
is readable", "the endpoint is reachable", "the credential exists" are all
preconditions. None of them is "it works".

*Everything in this entry except the indented quotation is written by the
Claude Code session that found the gap, not by Mr. Singh. He asked for the
pattern to be recorded; he has not checked this wording. If it misstates him,
the error is the transcriber's.*

## 6b. A result is about a version. Say which one.

Rule 6 asks whether a check *can* fail. This asks whether its result still
describes anything. **Run the check against committed code, and put the SHA in
the result.** "Proved against `8e00bea`" survives contact with a merge.
"Proved, green" does not — and nothing announces the moment it stops being true.

Two ways this goes wrong, both of which have happened:

- **Proving uncommitted edits.** Files modified in a working directory are on no
  branch. A proof of those describes a version that may never ship, and reads
  exactly like a proof of one that did.
- **Quoting a summary instead of the record.** An index line, a description
  field, a table of contents, an earlier report of your own — all copies, and
  copies go stale without announcing it. Open the file.

*Cost, 9 September 2026, twice in one day. Mobile ran a Postgres harness against
two migrations while they sat as uncommitted edits in the integration checkout;
a later PR happened to commit exactly those edits, so the proof happened to
describe what shipped — it did not have to, and nothing in the result would have
said otherwise. He caught it himself and re-proved against a named SHA.
Separately, the CTO quoted a one-line summary of his own notes saying Connect ran
on a 2 vCPU box that could not record, and wrote it into two documents a new
developer was about to read. The record underneath said 4 vCPU with recording
proven on 21 August. The record was right; the pointer to it was stale. A
different session made the identical error from the same summary the same day —
which makes it a defect in how we read our own notes, not two mistakes.*

**And a corollary, earned 12 September: a proposal can be invalidated by your
own later work.** Connect proposed raising a timeout to 120 seconds because the
failure it guarded against was irreversible, then shipped the feature that made
it reversible, and carried the proposal forward for four days without revisiting
the premise. Their words: *"I proposed 120 before I'd built the thing that made
120 unnecessary."* Nothing external changed and no signal fired. When you ship
something, ask what it makes unnecessary.

## 6c. Certainty is when the check gets skipped — which is when it is most needed

Rule 6 is about checks that cannot fail. Rule 6b is about results that have
stopped describing anything. This one is about **the check you did not run**,
and it is different in kind: the other two are caught by reading the check, and
this one leaves nothing to read.

The pattern: a careful person, at the end of a careful week, on the one thing
they feel surest about, skips the step they took every other time. Not
carelessness — confidence, which is the only state in which a careful person
skips a step. So the rule is not "be careful". It is: **the feeling of
certainty is itself the signal to check.** When you notice you are about to
write, delete, or assert something *without* looking because you already know,
that is the moment to look.

*Cost, 12 September 2026. Connect, after closing their lane, disclosed they had
overwritten `docs/CONNECT_DECISIONS.md` — Amit's 19 August rulings, written up
by Core — by writing to disk without staging first, having decided it was a new
file without checking. Restored from the commit's parent; nothing lost. Their
own tell, afterwards: the commit output had printed no `create mode` line, which
a genuinely new file would have had. The evidence was in output they had already
read. Their words, which are the rule: "certainty is when the check gets
skipped, which is when it is most needed."*

**Mail's question, 13 September, is the cheapest form of the check:** when
anyone — a session, a colleague, a document, yourself — tells you something is
verified, ask *what did you actually run, and what would have made it fail?* If
the answer is a description rather than a command and an observed result, it
was not verified. It was believed.

*Cost, 13 September 2026, same day. A fault description for an untracked
migration — "it breaks every deploy" — was repeated for four weeks by Mail and
the CTO both. It was wrong: the file passed a fresh build twice and failed only
against a database with rows. Nobody re-read the file because everybody knew
what was in it. `docs/decisions/0001-reject-user-recovery-migration.md`. And
the CTO, in the same hour, verified rule 6b on the working tree of a `wip/`
branch and reported it as on `main` — certain of the branch, so the branch was
the thing not checked.*

## 7. Ask what breaks if it is violated — **and what breaks if it is enforced**

Rule 6's second half. An invariant nobody enforces is a wish; an invariant
enforced without checking what depends on the slack is an outage.

*Cost: a unique index that correctly enforced one-active-app-password-per-mailbox
would have thrown `23505` on every replacement password — deterministically, for
every customer, on the second password a person generates, which is the one they
generate because the first stopped working. The model knew nothing of the index,
so the ORM was free to order the insert before the revoke.*

**7a. A setting that promises a restriction is a customer-facing promise.** It
ships only with its enforcement and the proof that the enforcement works,
never ahead of it. (Mr. Singh's ruling, 1 Oct 2026.) Until the enforcement
exists, the screen that offers the setting says plainly that it does not yet
restrict anything.

*Cost: the department setting "Can email outside the organisation" was saved,
shown with an "internal only" badge, and described to administrators as "Off
means they can only email colleagues" - and no sending path read it: not
webmail, the phone app, the send API, or the mail edge. Every school that
signed up was given a default "Students" department set to internal-only, so
the product itself made the promise. Found on 30 Sept 2026 while removing an
unused database grant (PR 363), seven weeks after the first such department
was created. Production, 1 Oct: 2 such departments, in 2 organisations that
were not live, with no active people in them - nobody had yet relied on it.*

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
2. **Push your branch and open a pull request. Do not merge locally and push
   `main`.** CI runs on pull requests and on pushes to `main` — so a branch
   merged locally is examined only *after* it has landed, which is examination
   with nothing left to stop. The pull request is the only pre-merge check that
   exists. Wait for green, then `gh pr merge --merge` — not squash; the commit
   messages are the record.

   **If `main` moved while you waited, rebase again and let CI run on the
   result.** You built against a `main` that has since changed, and nobody has
   built the combination that is about to ship. Separate lines; PowerShell 5.1
   has no `&&`.
3. **Before deploying**, not before pushing: if `main` contains any migration
   you have not already run, run `infra/scripts/verify-migrations.sh`. The
   deploy applies *everyone's* pending migrations, so this is the deployer's
   check, not the author's.

   *This paragraph carried a "while CI is unavailable, the author runs it too"
   exception from 29 Aug. CI came back on 3 Sept 2026 and the exception is
   removed rather than left standing — a conditional with no expiry date reads
   as current for as long as nobody checks.*
4. **Deploy with the `Deploy production` workflow, not by hand on the box.**
   Actions → Deploy production → Run workflow, type `production` in the
   confirmation box, and approve the environment prompt. It is deliberately
   manual: production is where mail reaches real inboxes and the data belongs to
   paying customers, so a deploy is a decision, not a consequence of merging.

   The workflow resets the server to `origin/main` and runs
   `./infra/scripts/deploy.sh production` there.

   **Do not write down a rollback point yourself. `deploy.sh` prints it.** It
   reads the `BUILD_SHA` baked into the running web container and prints the
   commit that is *serving traffic*, with the command to return to it:

   ```
   running   9da2316   <- the commit SERVING TRAFFIC right now
   rollback  git reset --hard 9da2316   # then re-run this script
   ```

   This rule used to say "record `git rev-parse --short origin/main` before you
   start". That is the commit you are deploying **to** — rolling back to it
   redeploys the thing you are rolling back from. `git rev-parse HEAD` is no
   better: the deploy resets the checkout before `deploy.sh` runs, and the two
   drift anyway when a deploy fails partway. **The checkout and the running
   system are different things, and every "which version is this?" has to name
   which one it means.** Getting that wrong caused the `x-build` regression,
   this instruction, and two wrong-branch deploys.

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

**`/srv/tatvaos-production` is for deploying. It is not a workspace.** Use
`~/tatvaos-scratch` — a second clone on the same box — for debugging,
reproducing, checking out someone else's branch, or anything else. Nothing
deploys from it, nothing is served from it, and it can sit on any branch
forever without consequence. Same rule as Amit's laptop, where `tatvaOS` is the
integration checkout and lanes are worktrees.

It sits in the deploy user's home and not under `/srv` because `/srv` is
root-owned and `deploy` has no sudo. This rule said `/srv/tatvaos-scratch` for
about an hour, and the path could not be created by the only account that would
ever use it — the same wall the backup runbook hit the same morning. Create it
with `git clone /srv/tatvaos-production ~/tatvaos-scratch`, which needs no
credentials at all, then point `origin` at the SSH URL production already uses:
`git remote set-url origin "$(git -C /srv/tatvaos-production remote get-url origin)"`.
HTTPS will not work — 2FA is on, and password authentication is refused.

`deploy.sh` returns the production checkout to `main` after a successful
deploy, so leftover branch state cleans itself up at the last provably-safe
moment. The guard refuses the bad deploy; the scratch clone removes the reason
someone was there; the checkout-back removes what they left behind. All three,
because two of them have each been tried alone.

*Incident, 8–9 Sept 2026: four wrong-branch checkouts in two days, two of them
on production, and a rollback commit recorded from the documented instruction
that pointed at unreviewed work. The branch guard stopped two bad deploys in
the same week — it was working. Nobody had anywhere else to go.*

*Cost: a finished feature sat blocked for three days behind a three-line edit
because one person was the gate. This trades that queue for a discipline —
both builds green, rebuilt after the pull, rollback SHA written down, announce
before, paste after — and the discipline only matters on the days somebody is
in a hurry.*

---

## 11b. A hand deploy runs detached, and a log with no verdict is a failure

Mr. Singh's ruling, 27 Sept 2026, after the incident below. Three parts, and
the third is what makes the first two last.

1. **Every hand deploy runs detached from the SSH session**, logging to a
   file, so the connection dropping never stops it halfway:

   ```bash
   LOG=~/deploy-production-$(date -u +%Y%m%dT%H%M%SZ).log
   CI=1 setsid nohup ./infra/scripts/deploy.sh production > "$LOG" 2>&1 < /dev/null &
   tail -f "$LOG"        # Ctrl-C stops the tail only, never the deploy
   ```

   `CI=1` because the typed `production` confirmation cannot be answered
   from `/dev/null`; the confirmation is the "go" Amit gave in chat, and the
   deploy report names it. `setsid` gives the deploy its own session, so the
   SIGHUP that follows a dropped connection never reaches it; `nohup` is the
   belt to that brace.

2. **A deploy with no verdict is not a success.** `deploy.sh` ends every run
   with a `DEPLOY VERDICT: PASS <sha>` or `DEPLOY VERDICT: FAIL (exit N)`
   line. **Whoever ran the deploy finds that line in the log before
   reporting the deploy as done**, and pastes it.

   *What PASS covers.* `deploy.sh` runs `verify-live.sh` itself, as its last
   step before the verdict, and a failure there never reaches PASS. So PASS
   means "deployed, and this run's own verify passed". It does **not** cover
   anything that runs after the script: the workflow runs `verify-live.sh` a
   second time and then checks from outside, and those have their own
   results. On a hand deploy, the checks from outside are yours to run and
   report separately. **A log that has neither was cut off** — the process was killed, or
   the box died under it — and the box may be half-updated: images pulled
   but containers not recreated, or the schema step run and nothing after.
   Treat it as failed. Before anything else, read the running build from the
   web container (`docker inspect tatvaos-web-1` → `BUILD_SHA`), compare it
   with the checkout, and say which you found. Never re-run on the
   assumption that the first run did nothing.

3. **`deploy.sh` refuses to start unless it is detached** and prints the
   command above instead. A rule in a document lasts until someone in a hurry
   forgets it; a check in the script does not. It refuses when any of these
   is true, and says which:

   - input, output or errors are a terminal;
   - the process has a controlling terminal (`/dev/tty` opens) — this is
     what catches `./deploy.sh production > log 2>&1` typed in an SSH
     session, which the first version of the check let through;
   - output is not a regular file — this is what catches
     `ssh host ./deploy.sh production` and `| tee log`, which have no
     terminal at all and still die with the connection, by SIGPIPE.

   **The override is narrow, so it cannot be typed by habit** (Mr. Singh,
   29 Sept 2026):

   - `DEPLOY_ATTACHED=1` counts only beside `GITHUB_ACTIONS=true`. The
     workflow sets both. **Typed alone in an SSH session it does nothing**,
     and the refusal says so.
   - `DEPLOY_LOCAL_REHEARSAL=1` is the laptop's switch. It has no business
     on the production box.

   **The workflow's exception is temporary and dated.** The runner keeps the
   output as the job log and does not hang up on its own process, so the
   reason for the file test does not apply there today. Once Actions is
   running again (expected 1 October 2026), the workflow is rewritten to
   start the deploy detached and follow its log to the verdict line: one way
   to run a deploy, not two. **If the exception is still in the workflow on
   15 October 2026, that is a rule 12 failure** — a temporary carve-out that
   became permanent.

   `tests/deploy/test-detached-guard.sh` runs every form, refused and
   allowed. It refuses to run where `infra/docker/.env` exists.

*Incident, 26 Sept 2026: a hand deploy of #312 started at 13:58Z and died
when the SSH session reset during the pre-deploy backup. It had not reached
the schema step, so production stayed on `7f2de67` — one step later and it
would have been half-updated. It then sat unnoticed for about three hours,
because the tool call driving it had timed out into the background and
nothing was watching a log. The re-run at 16:49Z was started with
`setsid nohup` and polled from its log; it passed. Nothing broke. The rule
exists because the next one lands one step later.*

---

## 12. A deploy step prints `[ok]` only when it has checked something

CTO's ruling, 17 Sept 2026, proposed by the Core session the same day.

A step earns an `[ok]` by comparing something it just measured against
something it expected. If it has nothing to compare, it prints **what
happened** — the command's own output, the component's own log line — and
no verdict at all. A confident line with no failure mode behind it is worse
than no line: it is the thing the next reader trusts instead of looking.

The test, for every `[ok]` in a script: *what result would have printed
`[FAIL]` here instead?* If the answer is "nothing", the line is not a check,
it is a rule 6 check-shaped object wearing a deploy step's clothes.

Three instances in one week, all in `deploy.sh`, all the same error:

- **The rollback line, 16 Sept.** It read `BUILD_SHA` from the live
  container and printed it as the commit to return to. When something had
  deployed outside the workflow, the line named the commit that was already
  running — it pointed at itself — and it did so under a green verdict, twice.
  Nothing in the step could have printed anything else.
- **The compose output, 12–13 Sept.** `docker compose up -d` was piped
  through `tail -12`. Compose prints one line per container it recreates,
  and those lines were the answer to "were the containers replaced?" — cut
  off, so the question took a day of `docker inspect` to answer instead of
  one read of the log.
- **The Caddy reload, 17 Sept.** `caddy reload` exited 0, so the step printed
  `[ok] caddy reloaded from the mounted Caddyfile`. Caddy had just logged
  `config is unchanged`, because the single-file bind mount still held the
  inode `git reset --hard` had replaced. The right component produced the
  exact answer at the right moment, and the step printed a success over the
  top of it. The new `/.well-known/` route was missing until the container
  was recreated by hand. The container's stale copy was byte-for-byte the
  pre-deploy file, which bounds the damage to that one deploy — an earlier
  lost edit would have left an older copy, not an equal one.

What the third one shows that the first two do not: Caddy terminates TLS and
carries the header and access policy. The failure mode is not "a route did not
appear"; it is "somebody tightens a security directive, the deploy says ok,
and the old policy is still live" — with every reason to believe it landed.

So, in a deploy step:

- **Print the component's own words.** Compose's `Recreate` lines, Caddy's
  `config is unchanged`, the API's startup line. They are the record, not
  noise; a `tail`, a `grep -c` or a `>/dev/null` on them is a decision to
  not know.
- **Check the artefact where it lives** (rule 6): the running config from
  Caddy's admin endpoint against the adapted file on disk, not the file's
  presence in the container; the SHA the container reports, not the one the
  checkout is sitting on.
- **A verdict follows a comparison.** `[ok]` after the compare passes,
  `[FAIL]` after it does not, and the compared values printed beside it so a
  reader can see what was compared.

*Cost: one deploy whose advertised OpenID Connect discovery URL answered a
404 for the minutes until the container was recreated, found because the
post-deploy checklist asked for the document by hand; a rollback line wrong
twice; and one day of reconstruction from `docker inspect` for an answer the
log had already printed and thrown away.*

---

## 13. Every test run gets its own database

Mr. Singh's ruling, 29 Sept 2026, to every developer session.

1. **Each test run creates its own database, applies every file in
   `local/postgres/init/` from nothing, runs, and drops it at the end, pass or
   fail.** Applying the files twice is free, and it is the migration re-run
   check: every file re-runs on every deploy.
2. **Nobody edits the shared local database to make a test pass.** If a test
   needs a particular state, it creates that state in its own database.
3. **The shared database (`tatvaos_mail`) is for trying things in a browser,
   never for proof.** A PR's evidence names the throwaway database it ran
   against.

`tests/lib/throwaway-db.sh` does 1 for a suite that sources it and calls
`tdb_create <label>`. It prints the database's name, applies every migration
twice with `ON_ERROR_STOP`, and drops the database in an `EXIT` trap. It stops
the run, naming the reason, if a migration fails or changes a **server-wide
role**, because roles are the one thing every database on a Postgres server
shares. `tests/mfa/test-recovery-codes.sh` is the example. Each lane moves its
own suites onto it as it touches them.

**The incident.** On 29 Sept the PR 329 test (calendar reminders) failed in the
shared database for a reason that had nothing to do with PR 329. PR 330, still
a draft, had left its row-security rule on `calendar.reminder_sends` there,
from an earlier run of its own tests, and 329's code could not satisfy it:
every reminder send was refused. The session found it, set the table back to
`main`'s shape for its runs, and restored 330's settings. That worked, but only
because the restorer knew exactly what the table had been. A shared test
database means:

- one session's unmerged change can make another's test fail, or **pass for
  the wrong reason**, which is worse, because nobody looks;
- two sessions resetting the same tables at the same moment corrupt each
  other's results, with nobody noticing;
- "restored exactly as it was" depends on the restorer knowing what "was"
  meant.

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

## If you could not run a required check, say so — in the PR body

When a check the work is supposed to pass could not be RUN — not failed, could
not run: the tool is missing, the environment can't reach it, the machine has
no Docker — say so in the pull request body, and say why. One sentence: what
you could not run, and what stopped you.

The cost this pays for: without a named place to write "I couldn't", the only
options are silence and unusual conscientiousness, and silence wins on the
busy days. A skipped check that is announced is a decision the reviewer can
weigh; a skipped check that is silent is a hole nobody knows to look in. This
turns the second into the first.

*(Earned 3 September 2026: `verify-migrations.sh` gated on `docker ps` and so
could not run at all on a machine without Docker — both its real checks sit
downstream of that gate. The gap was surfaced by a report, not by the script,
which is exactly the conscientiousness this rule exists so nobody has to
rely on.)*

---

*Amendments are welcome and should arrive as a pull request with the incident
attached. A rule without a cost behind it does not belong here.*

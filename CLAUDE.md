# TatvaOS — read this first

A multi-tenant workspace suite for Indian organisations: Mail, Connect (video),
Space (files), Calendar, Contacts, and an admin console. ASP.NET Core .NET 10
(`apps/api`) plus Next.js 15 (`apps/web`), Postgres 17, Docker behind Caddy, one
server in Mumbai.

**This file is deliberately short and points outwards. It does not restate the
rules — `docs/HOUSE_RULES.md` is the single canonical copy, and duplicating it
here is the exact mistake house rule 8 exists to prevent.**

---

## 1. Work out which lane you are, from your own path

| If your working directory is | You own |
|---|---|
| `tatvaos-core` | **Core** — auth, tenancy, AI gateway, infra, deploy, Platform, Space |
| `tatvaos-mail` | **Mail** — webmail, mail edge, calendar seam |
| `tatvaos-connect` | **Connect** — meetings, recordings, captions, AI minutes |
| `tatvaos-mobile` | **Mobile** — `apps/mobile`, the Expo app |
| `tatvaos-hire` | **Hire & People** — recruitment and HR |
| `tatvaOS` | **nobody.** This is the integration and deploy checkout |

**Then read your lane's welcome document** under `docs/onboarding/<lane>/WELCOME.md`,
and `docs/onboarding/README.md` if you are new. Those say what exists today,
what is blocked and on whom, and the traps that have already cost someone a day.

**⚠️ `tatvaOS` is not a workspace.** It is where `main` is integrated and
deployed from. Work left there is invisible until somebody runs `git status` by
chance — it has needed rescuing more than once. If you are in it and you are not
deploying, you are in the wrong directory.

---

## 2. Before you change anything

- **`docs/HOUSE_RULES.md`** — canonical. Every rule has a named incident behind
  it. Anything anywhere that contradicts it is out of date, including this file.
- **`docs/README.md`** — the map. Roughly half of `docs/` is point-in-time
  session notes, true when written and never updated. That index says which.
- **`docs/UI_LANE_BRIEF.md`** — required if you touch web UI. New pages use
  Tailwind and `components/ui/` only, never the YZEN Bootstrap template.

Three that bite hardest if you learn them the hard way:

- **A deploy ships all of `main`, not just your branch** (rule 11). Every lane
  merges and deploys its own work, so a deploy that breaks someone else's work is
  still your deploy. Roll back first, diagnose after, and say so immediately.
  Nobody is in trouble for a rollback; silence is the only wrong move.
- **Migrations are additive, and every file in `local/postgres/init/` re-runs on
  every deploy.** Rollback restores code, not schema — that is why.
- **A check with no failure mode is not a check.** Ask what result would prove
  you wrong. If nothing could, you are confirming rather than verifying. And
  prove the *committed* version: name the SHA in the result (rule 6b).

---

## 3. How to verify your own work

| | |
|---|---|
| Web types and lint | `pnpm --filter @tatvaos/web typecheck` · `lint` |
| Whole schema builds from nothing | `infra/scripts/verify-migrations.sh` (needs Docker) |
| One migration, no Docker | `infra/scripts/verify-one-migration.py` |
| Production is genuinely serving | `infra/scripts/verify-live.sh` — `deploy.sh` calls it and refuses success on its failure |

`apps/mobile` is **outside** the pnpm workspace. Inside it, always
`pnpm install --ignore-workspace` — plain `pnpm install` walks up, installs the
*other* projects, and reports success having done nothing for mobile.

---

## 4. Working with Amit

He is the founder, he is not a developer, and on anything you cannot run
yourself he is the one running it.

- **One command at a time**, and say what success looks like — he cannot judge
  raw output.
- **Windows PowerShell 5.1. No `&&`.** A chained command silently does not run;
  this once cost a production deploy that re-shipped the same commit behind a
  perfect log.
- **Never hand him a command that prints a secret.** He pastes whole transcripts.
- **State your blockers as a list, naming who owns each.** "Blocked on X, doing
  Y meanwhile" is a status. "I will pick this up later" hides which of you has to
  act.

---

## 5. What this codebase's bugs look like

Almost every expensive failure here has been **silent**. A script that reported
success while doing nothing. A setting that looked applied and was not. A health
check answering 200 while every database query threw. An app that displayed
`SHARING` with nothing being sent. A byte-count check that passed while the
content was wrong.

So: **measure rather than reason, and check the result rather than trusting the
transport.** When you fix something, leave behind the thing that would have
found it — a log line, an assertion, a comment naming what the failure looked
like from the outside. Most of the long comments in this repository exist
because somebody lost hours to something that could have said what was wrong and
did not. Add to them; do not tidy them away.

If a document here is wrong, fix it and attach the incident. A rule without a
cost behind it does not belong in `HOUSE_RULES.md`.

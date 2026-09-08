# Welcome to TatvaOS — you're taking Core

Written 27 August 2026 by the CTO, who has been holding Core himself and is
handing it to you. Read this once end to end before your first commit. It is
decisions and honest unfinished business, not mysteries.

---

## 1. What TatvaOS is

A single sign-on suite for Indian organisations — schools, clinics, small
businesses — built by Techvein. Google Workspace in shape, but on our own
infrastructure, priced for India, and with the data questions answerable.

Seven products, all live in production today:

| Product | What it is | Address |
|---|---|---|
| **Core** | Organisations, people, domains, signup, billing, the admin console | core.tatvaos.com |
| **Mail** | Full webmail on our own SMTP/IMAP stack | mail.tatvaos.com |
| **Space** | File storage and sharing | space.tatvaos.com |
| **Calendar** | Events, invitations, iMIP | calendar.tatvaos.com |
| **Family** | Contacts | (inside the suite) |
| **Connect** | Video meetings, recordings, live captions, AI minutes | connect.tatvaos.com |
| **Platform** | Developer-facing: connection settings, API keys, docs | platform.tatvaos.com |

One server in Mumbai, one Postgres 17, eleven containers behind Caddy. One
codebase: a .NET 10 modular monolith (`apps/api`) and a Next.js 15 app
(`apps/web`). Not microservices — deliberately. A team this size moves faster
in one repository with clear internal boundaries than across many.

---

## 2. The team

Five developers, each owning a product **end to end** — schema, API, worker,
UI, deploy. Everyone here is full-stack by necessity and design: the person
who writes the endpoint writes the screen that uses it, so nothing gets thrown
over a wall and nobody waits.

- **Core** — yours. See §3.
- **Mail** — webmail, the mail edge, the calendar seam. Deep in a design
  overhaul. He's the one who found our AI gateway had no per-organisation
  consent, which is now a shipped feature — and who told me, correctly, that
  a test procedure I'd written described a seam with no callers.
- **Connect** — video meetings, recordings, captions, AI minutes. The most
  complex lane by volume; also the one with the most proven-in-production
  verification scripts.
- **Space** — storage, sharing, public links. Keeps the best written record of
  known-unknowns on the team; his fault matrix is worth reading as a style guide.
- **Platform** — joining now, alongside you.

**Amit** is the founder. Product decisions, customer promises, anything that
changes what we tell a client, are his. He is not a developer — write to him
in plain language, and when you need a decision give him the trade-off, not
the implementation.

**Me (CTO)** — rules, daily review of every lane, unblocking, and rulings when
two lanes disagree. I don't write feature code. If I'm editing your files,
something has gone wrong with the assignment, and you should say so.

We work asynchronously, in writing. Each lane keeps an "open threads" page
listing what's outstanding **grouped by who it's waiting on** — because what
usually stalls work here is ownership, not priority. You'll want one.

---

## 3. What Core is, and what you own

Core is **the spine every other lane stands on.** That is the whole job
description, and it's why this lane is being staffed rather than left with me.

**Yours:**

- `apps/api/Modules/Core/` — signup, domain verification and ownership,
  organisation settings, storage quotas. Small on disk, load-bearing.
- `apps/api/Shared/` — and this is the real weight:
  - `Auth/` — password hashing, sessions, JWTs, the middleware every request
    passes through
  - `Tenancy/` — `TenantContext`, `TenantConnectionInterceptor`, and the
    row-level-security contract that keeps one school from seeing another's data
  - `Data/` — `AppDbContext`, the entity registry every module adds to
  - `Ai/` — `IAiGateway` and `OpenAiGateway`: the one door to any AI provider,
    with per-organisation consent enforced fail-closed
  - `Settings/`, `Notify/`, `Mail/` (the sending seam, not the mail product)
- `local/postgres/init/` — the migration directory as a whole. Everyone writes
  migrations; you own whether the set stays coherent.
- `infra/` — Docker composition, Caddy fragments, and the scripts:
  `deploy.sh`, `backup.sh`, and the `verify-*.sh` family.

**Not yours:** any other module's business logic. When Connect needs a schema
change you review it; you don't write it.

**The tension in this job, named up front:** Core's files are the ones four
other people need to touch. `AppDbContext.cs`, `Program.cs`, `lib/nav.tsx` are
shared registries — **additive-only** for everyone including you. Never rename
someone else's entry; it shows up as their icon changing and costs them an
afternoon. Your instinct will be to tidy. Resist it in shared files.

---

## 4. How we work

**The rules live in `docs/HOUSE_RULES.md`, and only there.** Read it before
your first commit, and again before your first deploy — rule 11 governs what
you are allowed to do alone.

This document deliberately does not summarise them. A summary is a copy; it
drifts, and it reads as authoritative the whole time it is wrong. That is
rule 10, and this section was an instance of it until 29 Aug 2026: it carried
seven rules inline, including a superseded rule 6 that taught the weaker
habit — *"a test you've only seen pass is not a test"*, which asks you to
distrust a result, in place of *"a check with no failure mode is not a
check"*, which lets you reject a bad check by reading it.

---

## 5. What you're inheriting that isn't finished

Honest list. Nothing here is hidden from you.

**Not yet on `origin/main` (blocking, today).** The app-password API and page,
the org AI consent screen, the platform door and landing page, and the handover
docs are committed locally on `main` but not pushed — and **have never been
compiled.** Two builds (`dotnet build apps\api`, `npm --prefix apps\web run build`)
then a push. Errors are likely small. This is your first job, and it's a good
one: you'll read the newest code in the repo with a compiler helping you.

**Argon2 primary IMAP passwords — a named risk.** Existing `imap_password_hash`
rows are raw `$argon2id$` with base64 padding; Dovecot's parser may still refuse
them even at the ARGON2ID default. App passwords are immune ({SSHA512},
self-prefixed) which is why the client path uses them. The primary store is a
follow-up. See `local/postgres/init/20260827-a-mail-app-passwords.sql` — its
comments are the design record, including why one active password per mailbox.

**`docs/RUNBOOK-2026-08-28.md` step 7 has never been run.** A real mail client,
a real app password, a send and a reply, plus a wrong-password refusal. Until
that passes, our claim that a customer's ERP can send through us is documented,
not proven. See rule 7.

**Four worktrees show `prunable`.** Their branches merged; the folders are
stale. Worth a sweep once you've confirmed nobody's mid-flight.

**Coming at you from Platform:** personal access tokens, then organisation API
keys. Both touch `Shared/Auth` — yours. Platform owns how a developer finds and
understands them; you own the token format, the hashing (read `PasswordHasher.cs`
and the `{SCHEME}` lesson in the app-passwords migration before choosing
anything), and how middleware accepts a key beside a JWT. **Pair on it.**
Per-organisation keys must respect `core.tenants` liveness the way every
credential store here does — a suspended org's keys die with it.

---

## 6. Your first week — a suggestion, not an instruction

1. **Get the local stack running** (`local/`) and send yourself an email
   through it. Nothing teaches this codebase faster than watching a message go
   all the way through.
2. **Do the push in §5.** Small, real, and it puts a compiler between you and
   the newest code.
3. **Read four files** for the house voice: `infra/scripts/deploy.sh`,
   `apps/api/Shared/Ai/IAiGateway.cs`, `apps/api/Shared/Tenancy/`, and any
   migration in `local/postgres/init/`. Notice that comments explain *why*, and
   that several record mistakes by name. A comment saying what the code does
   goes stale; one saying why it's shaped this way saves the next person a day.
4. **Run `infra/scripts/verify-migrations.sh` once** on a scratch database,
   just to watch it work. You now own the thing it protects.
5. **Start your open-threads page.** It's how the rest of us know what you need.

---

## 7. How we talk to each other

We write things down, we say when we're unsure, and we correct each other
without ceremony. Nobody here has been wrong quietly and nobody's been punished
for being wrong loudly. In one recent week four separate bugs were found by four
different people — **none of them the person who wrote the bug**, and every one
found by *running* something rather than reading it.

If you think a decision is wrong, say so with your reasoning. If a rule above
gets in your way, say that too — several exist because somebody pushed back on
a worse version. That includes pushing back on me.

And if something looks broken, assume it might be, and check. That instinct is
the most valuable thing you can bring.

Welcome aboard.

*— CTO, 27 August 2026*

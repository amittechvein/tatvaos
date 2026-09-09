# Welcome to TatvaOS

You're taking **Platform** — `platform.tatvaos.com` — and this is everything
you need to start well. Read it once end to end; it's the shape of the
place, not just the shape of your job.

---

## 1. What TatvaOS is

A single sign-on suite for Indian organisations — schools, clinics, small
businesses — built by Techvein. Think Google Workspace, but run on our own
infrastructure, priced for India, and with the data questions answerable.

Six products, all live in production today:

| Product | What it is | Address |
|---|---|---|
| **Core** | Organisations, people, domains, billing, the admin console | core.tatvaos.com |
| **Mail** | Full webmail on our own SMTP/IMAP stack | mail.tatvaos.com |
| **Space** | File storage and sharing | space.tatvaos.com |
| **Family** | Contacts | (inside the suite) |
| **Calendar** | Events, invitations, iMIP | calendar.tatvaos.com |
| **Connect** | Video meetings, recordings, AI minutes | connect.tatvaos.com |
| **Platform** | ← **yours** | platform.tatvaos.com |

One server in Mumbai (4 vCPU), one Postgres, everything in Docker behind
Caddy. One codebase: a .NET 10 modular monolith (`apps/api`) and a Next.js
app (`apps/web`). Not microservices — deliberately. A team this size moves
faster in one repository with clear internal boundaries than across many.

---

## 2. The team

Four developers, each owning a product **end to end** — schema, API,
worker, UI, deploy. Everyone here is full-stack by necessity and by design:
the person who writes the endpoint writes the screen that uses it, so
nothing gets thrown over a wall and nobody waits.

- **Core** — the shared spine: auth, tenancy, the AI gateway, infrastructure,
  deploy tooling, and rulings when two lanes disagree. That's who wrote this
  document, and who you'll pair with on anything touching `Shared/`.
- **Mail** — webmail, the mail edge, the calendar seam. Deep in a design
  overhaul at the moment. He's the one who found that our AI gateway had no
  per-organisation consent, which is now a shipped feature.
- **Connect** — video meetings, recordings, live captions, AI minutes.
- **Space** — storage, sharing, public links. Keeps the best written record
  of known-unknowns on the team; his fault matrix is worth reading as a
  style guide.

**Amit** is the founder. Product decisions, customer promises, and anything
that changes what we tell a client, are his. He is not a developer — write
to him in plain language, and when you need a decision, give him the
trade-off rather than the implementation.

We work asynchronously, in writing. Each lane keeps an "open threads" page
listing what's outstanding **grouped by who it's waiting on** — because what
usually stalls work here is ownership, not priority. You'll want one too.

---

## 3. What Platform is, and what you own

Platform is where TatvaOS faces **programs rather than people**.

Everything else in the suite is somebody sitting at a screen. Yours is the
surface a customer's *developer* meets: connection settings, credentials,
API keys, documentation. When a school's ERP vendor asks "how do we send
mail from our software" or "can we create users programmatically", the
answer is a URL you own.

**Yours:** the platform door, its pages, credential and API-key management
UI, and the developer documentation.

**Not yours:** the APIs themselves. When "create a user" ships, that endpoint
lands in Core's module with Core; when "create a meeting" ships, it lands in
Connect's. You own how a developer *finds, authenticates to, and understands*
them. That split keeps one person owning each piece of business logic while
you own the developer's experience of all of it.

### What already exists (shipped, live, today)

- **`platform.tatvaos.com`** — the door (`infra/docker/conf.d/platform.caddy`),
  DNS resolving, certificate issued.
- **The landing page** (`apps/web/app/platform/page.tsx`) — deliberately
  static, unauthenticated, server-rendered, because it's read by someone who
  doesn't have an account yet. Anything needing a session links *into* the
  products where sessions already live. Your brand assets are at
  `/brand/platform-logo.png` and `/brand/platform-name.png`.
- **The mail-client story it documents** — as of today, TatvaOS mailboxes work
  from Outlook, Thunderbird, phones and third-party software: TLS on 587
  (STARTTLS) and 993 (SSL), authenticated submission, and **app passwords**
  so nobody's real sign-in password goes into someone else's software. Your
  page is that feature's brochure.

### What's next, in Amit's order

1. **Personal access tokens** — a developer authenticating to our APIs as
   themselves.
2. **Organisation API keys** — a customer's software authenticating as the
   organisation.
3. **The public APIs' documentation** — people, then mailboxes, then meetings,
   each as it ships.

Tokens and keys touch `Shared/Auth`, which is Core's — **pair on it, don't
build it alone.** Token format, hashing, and how middleware accepts a key
beside a JWT are platform-wide decisions with a lot of prior art in this
repo, some of it painfully learned.

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

## 5. Your first week — a suggestion, not an instruction

1. **Get the local stack running** (`local/`) and send yourself an email
   through it. Nothing teaches this codebase faster than watching a message
   go all the way through.
2. **Read three files** for the house voice: `infra/scripts/deploy.sh`,
   `apps/api/Shared/Ai/IAiGateway.cs`, and any migration in
   `local/postgres/init/`. Notice that comments explain *why*, and that
   several record mistakes by name. That's deliberate — a comment that says
   what the code does goes stale; one that says why it's shaped this way
   saves the next person a day.
3. **Read `docs/PLATFORM_LANE_HANDOVER.md`** — your lane's specifics.
4. **Ship something small end to end.** A copy fix on your landing page,
   through commit, build, deploy, verify. **The sequence is rule 11 in
   `docs/HOUSE_RULES.md`** — merge, both builds green, rollback SHA written
   down, announce before, paste after. Read it before you start rather than
   partway through; it is the one rule that changes what you may do without
   asking anyone. Do the whole loop once while the stakes are tiny, so the
   loop isn't new when the stakes aren't.
5. **Start your open-threads page** — what you're building, what's waiting on
   whom. It's how the rest of us will know what you need.

---

## 6. A note on how we talk to each other

We write things down, we say when we're unsure, and we correct each other
without ceremony. Nobody here has been wrong quietly and nobody's been
punished for being wrong loudly. Last week four separate bugs were found by
four different people — **none of them the person who wrote the bug**, and
every one found by *running* something rather than reading it.

If you think a decision is wrong, say so with your reasoning. If a rule
above gets in your way, say that too — several of them exist because
somebody pushed back on a worse version.

And if something looks broken, assume it might be, and check. That instinct
is the most valuable thing you can bring.

Welcome aboard.

*— Core, 28 August 2026*

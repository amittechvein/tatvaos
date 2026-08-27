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

## 4. How we work — seven rules, each of which cost us something

These aren't style preferences. Every one has an incident behind it, and the
incidents are documented in the files themselves.

**1. Lanes.** Your files are yours to change freely. Another module's files
are ask-first. If production is burning and you must cross a line, do it and
**declare it in the commit message** — a quiet cross-lane edit is how two
people spend a day fixing the same bug in different ways. For genuinely
shared files (`lib/nav.tsx`, `AppDbContext.cs`): your own function is yours,
shared registries are **additive-only** (never rename someone else's entry —
it shows up as their icon changing), everything else is ask-first. That
includes Core.

**2. Migrations are date-prefixed, idempotent, additive** — and must survive
`infra/scripts/verify-migrations.sh`, which builds every migration against a
scratch database from empty, then runs the whole directory again. Both halves
matter: the first catches a file that depends on one sorting after it; the
second catches a file that fights a later one. Both have cost us blocked
deploys. Use the **real date** — and ignore the `202609xx` Connect files,
which are a documented mistake awaiting rename.

**3. Build before commit. Count files before push.** `git diff --cached
--stat`, read the number, then push. A green build proves your *working
tree*; the commit ships the *index*. Those diverged once and shipped a
broken file to production.

**4. Merged is not running.** Config that renders at container start doesn't
change because you deployed. An outbound-TLS fix sat correct in git for four
days while real mail went out unencrypted. `deploy.sh` now handles the known
cases; when you add a service, decide **at birth** how its config reaches the
running process, and write it down.

**5. Secrets never appear in output.** Not in a log, not in a terminal, not
in a chat. Generate them where they're used (`read -rsp`, or straight into
the destination file). A command whose output is a secret is unsafe by
construction; one that writes it to its destination is safe by construction.
And know that every secret's blast radius includes the nightly backup —
`backup.sh` copies `.env` verbatim, and says so in its own comments.

**6. A test you've only seen pass is not a test.** Calibrate first: prove it
can detect the thing before you believe what it says. Real examples from one
week — a race test that raced the wrong URL and reported 10/10 failures
against working code; a rate limiter's refusals counted as the bug being
hunted; a link at its download cap that would have "passed" a test by
refusing before it reached the code under test. The house style for check
scripts is in `infra/scripts/verify-*.sh`: **guards that refuse**, not
warnings that scroll past.

**7. Documented is not built.** In one week we found three "documented
behaviours" that had never existed — a seam whose two ends had no callers, a
sandbox guarantee describing code that did something else, a comment
promising production TLS on a port serving cleartext. When a document tells
you what the code does, **grep for the caller** before you believe it. That
habit has found more bugs here than any test suite.

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
   through commit, build, deploy, verify. Do the whole loop once while the
   stakes are tiny, so the loop isn't new when the stakes aren't.
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

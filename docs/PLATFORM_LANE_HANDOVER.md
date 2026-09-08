# TatvaOS Platform — lane handover

For the developer taking `platform.tatvaos.com`. Written 28 Aug 2026 by Core,
who built the skeleton you are inheriting. Read this before your first commit;
it is decisions, not mysteries.

Read `onboarding/platform/WELCOME.md` first for the shape of the place. This
document is your lane's specifics — and where a specific has a file behind it,
the file is named. Go and read it. Rule 7 applies to this document too.

---

## What Platform IS

Where TatvaOS faces **PROGRAMS rather than people**.

Every other product is somebody sitting at a screen. Yours is the surface a
customer's *developer* meets: connection settings, credentials, API keys,
documentation. When a school's ERP vendor asks "how do we send mail from our
software", the answer is a URL you own.

**Yours:** the platform door, its pages, the credential and key-management UI,
and the developer documentation.

**Not yours:** the APIs themselves. When "create a user" ships, that endpoint
lands in Core's module with Core; "create a meeting" lands in Connect's. You
own how a developer *finds, authenticates to, and understands* them. That split
keeps one person owning each piece of business logic while you own the
developer's experience of all of it.

---

## What exists today

All of the following is in-tree and shipping via `docs/RUNBOOK-2026-08-28.md`.

**`infra/docker/conf.d/platform.caddy`** — the door. DNS A record: done.

> ### ⚠️ PLATFORM_DOMAIN — adding a domain is a THREE-PLACE edit
>
> A mounted Caddy fragment with an unset domain makes Caddy read a site
> address of `""` and **refuse the entire config — not that site block, all of
> them.** On 27 August that took Core, Mail and Family down together.
>
> The variable was in `.env` and the fragment existed. What was missing was the
> third place: **the `environment:` list on the `caddy` service in
> `infra/docker/docker-compose.base.yml`.** Compose interpolates `.env` when it
> renders that block — the container never sees `.env` itself, so a variable
> present only there arrives inside Caddy as an empty string.
>
> The error Caddy prints is `server block without any key is global
> configuration, and if used, it must be first` — which names neither the
> variable nor the file, and sends you to the Caddyfile, which is fine.
>
> So: **(1)** the `environment:` list in `docker-compose.base.yml`, **(2)**
> `.env` on the server, **(3)** the `conf.d` fragment. All three, before the
> fragment first deploys.
>
> Every domain is now `${VAR:?...}`, **not `:-`**. A blank default hides a
> missing variable until Caddy is already running with a broken config, which
> means the failure lands on production; `:?` moves it to `docker compose
> config`, before anything is pulled, built or restarted. There is no
> environment where an unset domain is correct: a domain with no fragment is
> harmless, a fragment with no domain is an outage. Keep it that way when you
> add yours.
>
> The full account is in the comment block at `docker-compose.base.yml:360`.
> Read it before you add a domain, not after.

**`apps/web/app/platform/page.tsx`** — the landing page. Deliberately static,
unauthenticated, server-rendered: it is read by a client's developer before they
have an account. Anything needing auth links *into* the products, where sessions
already live. Brand assets: `/brand/platform-logo.png`, `/brand/platform-name.png`.

**The mail-edge work your page describes** — TLS on 587 (STARTTLS) and 993
(SSL), SASL submission, app passwords so nobody's real sign-in password goes
into someone else's software — is Core+Mail's and already built. Your page is
its brochure.

> ### ⚠️ Four connection values are duplicated. If a port changes, change both.
>
> `imapHost`, `imapPort`, `smtpHost`, `smtpPort` are hardcoded on your landing
> page and also live in the `settings` block of
> `apps/api/Modules/Mail/Endpoints/MailAppPasswordEndpoints.cs` (~line 89).
> Deliberate — a static page cannot call an authenticated API — and the risk is
> named in `page.tsx`'s header comment.
>
> **Correction to an earlier draft of this document, which said the risk was
> named in both files: it is not.** The API-side comment says the settings are
> served from the API "so the settings screen and the client sheet can never
> disagree about a port number." That was true when it was written and your page
> is now a third copy the API cannot keep in sync. Whoever edits that block will
> read a comment telling them the problem is already solved.
>
> Fixing that comment is a one-line cross-lane edit in Mail's file. Ask Mail;
> declare it in the commit message. Until it is fixed, this paragraph is the only
> place the trap is written down.

---

## The rules of this repo

**`docs/HOUSE_RULES.md`.** Read it before your first commit, and again before
your first deploy — rule 11 governs what you may do alone.

Not compressed here on purpose. A compression is a copy, and this section was
one until 29 Aug 2026: it carried the rules inline, including a superseded
rule 6. Copies drift, and they read as authoritative while they do — which is
rule 10, and which this section demonstrated rather than described.

---

## When you build personal access tokens / organisation API keys

This touches `apps/api/Shared/Auth/` — **Core's, ask-first, and Core will pair
on it willingly.** Token format, hashing, and how the auth middleware accepts a
PAT beside a JWT are platform-wide decisions with a lot of prior art here, some
of it painfully learned. **Do not build it alone.**

Read before proposing anything:

- **`apps/api/Shared/Auth/TokenIssuer.cs`** — how tokens are issued and hashed
  today, and why the access-token lifetime is fifteen minutes. That comment is
  the constraint your design has to live with: a JWT is not checked against the
  database, so it cannot be withdrawn once signed. Core promises that suspending
  a person removes access to every product at once. A long-lived PAT is a
  different animal from a JWT precisely there, and that difference is the design
  conversation.

- **`apps/api/Shared/Auth/PasswordHasher.cs`** — the house hashing.

> ### ⚠️ The `{SCHEME}` lesson — read it before choosing any hashing
>
> `local/postgres/init/20260827-a-mail-app-passwords.sql`, around line 38:
>
> > *Carries its own `{SCHEME}` prefix (`{SSHA512}` from the API). The scheme
> > travels WITH the hash because the one store that relied on a default scheme
> > verified every hash against the wrong algorithm for weeks.*
>
> **Weeks.** Not a failed deploy — a store quietly verifying against the wrong
> algorithm while looking healthy. Whatever you and Core settle on, the stored
> hash names its own scheme. A default is a decision you cannot change later
> without knowing which rows predate the change, and by then you cannot tell.

Two more constraints that are not negotiable:

- **A credential is shown ONCE, at generation, and is never retrievable** — only
  a hash is stored. "View key" turns one database read into every customer's
  data. `MailAppPasswordEndpoints.cs` encodes the same rule and is worth reading
  as the shape to copy.
- **Per-organisation keys must respect `core.tenants` liveness** the way every
  credential store here does — a suspended org's keys die with it. This is not a
  cleanup job; it is checked at authentication time.

**Amit's order** for the lane: personal access tokens → organisation API keys →
the public APIs' documentation pages as each API ships (people → mailboxes →
meetings). No estimates here on purpose: nobody has scoped this work, Core has
not settled the token format, and a number invented before either of those is
something you would end up measured against. Scope it with Core once the format
is decided, and put your own estimate in your open-threads page where it can be
revised.

---

## Your first week

1. **Get the local stack running** (`local/`) and send yourself an email through
   it. Nothing teaches this codebase faster than watching a message go all the
   way through.

   > `deploy.sh` finishing with `all N services running` means N containers are
   > in Docker's `running` state — **which is not the same as N working
   > services.** A container runs while the process inside it refuses every
   > login. On 27 August this script printed `[FAIL]` for the certificate sync
   > and the mail-edge restart, then finished `all 10 services running` and a
   > green `production deployed.` over a mail server refusing every login; the
   > checks fired correctly and the verdict simply did not read them. The
   > verdict is fixed (every `bad()` now increments `FAILURES` and success
   > refuses to print while it is non-zero — see `deploy.sh:24`), but the
   > running-count line still only knows container state. Mail has deeper
   > liveness checks in flight on `feature/mail-verify-live-checks`
   > (`infra/patches/mail-verify-live-0001-mail-checks.md`) — **not on `main`
   > yet**, so do not go looking for a `verify-live.sh` in `infra/scripts`. Until
   > it lands: prove the thing works by using it, not by reading the line.

2. **Read three files** for the house voice: `infra/scripts/deploy.sh`,
   `apps/api/Shared/Ai/IAiGateway.cs`, and any migration in
   `local/postgres/init/`. Comments here explain *why*, and several record
   mistakes by name. That is deliberate — a comment saying what the code does
   goes stale; one saying why it is shaped this way saves the next person a day.

3. **Ship something small end to end.** A copy fix on your landing page, through
   commit, build, deploy, verify. Do the whole loop once while the stakes are
   tiny, so the loop is not new when the stakes are not.

4. **Start your open-threads page.** Every lane keeps one, grouped by **who it
   is waiting on** — what stalls work here is ownership, not priority. Suggested
   starting state:

   ```markdown
   # Platform — open threads

   ## Waiting on Core
   - Token format + hashing scheme for PATs (blocks everything below)
   - How middleware accepts a PAT beside a JWT

   ## Waiting on Mail
   - Fix the stale "can never disagree" comment in MailAppPasswordEndpoints.cs
   - verify-live checks landing on main

   ## Waiting on Amit
   - Are scopes in v1 for org API keys, or v1.1?

   ## Waiting on nobody (mine)
   - Landing page copy
   - Read TokenIssuer.cs, PasswordHasher.cs, the app-passwords migration
   ```

---

## Who to ask

**Core** (this document's author) for anything `Shared/`, `infra/`, or a ruling.
**Amit** for anything that changes what a customer is promised — plain language,
and give him the trade-off rather than the implementation; he is not a developer.
**Mail** for the app-password and mail-edge story your page describes.

The platform-wide open-threads page is the map of who owes what.

If you think a decision here is wrong, say so with your reasoning. Several of
these rules exist because somebody pushed back on a worse version.

Welcome aboard.

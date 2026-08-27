# TatvaOS Platform — lane handover

For the developer taking platform.tatvaos.com. Written 28 Aug 2026 by Core,
who built the skeleton you are inheriting. Read this before your first
commit; it is decisions, not mysteries.

## What Platform IS

Where TatvaOS faces PROGRAMS rather than people. Today: mail-client
settings and the app-password story. Yours to build: personal access
tokens, organisation API keys, and the public APIs' documentation pages as
each API ships (people → mailboxes → meetings, in that order — Amit's).
The APIs THEMSELVES land in `apps/api` under the owning module's lane with
Core; your lane is the platform door, its pages, and the key-management UI.

## What exists (all in-tree as of this writing; ships via docs/RUNBOOK-2026-08-28.md)

- `infra/docker/conf.d/platform.caddy` — the door. Needs `PLATFORM_DOMAIN`
  in the production `.env` BEFORE it first deploys (a mounted fragment with
  an unset domain makes Caddy refuse the WHOLE config — every product goes
  down; deploy.sh's validate gate is the net). DNS A record: done.
- `apps/web/app/platform/page.tsx` — the landing page. Deliberately static,
  unauthenticated, server-rendered: it is read by a client's developer
  before they have an account. Anything needing auth links INTO the
  products, where sessions already live. Brand assets:
  `/brand/platform-logo.png`, `/brand/platform-name.png`.
- The mail-edge work your page describes (TLS on 587/993, SASL submission,
  app passwords) is Core+Mail's and already built — your page is its
  brochure. Four connection values are duplicated from
  `MailAppPasswordEndpoints`' settings block, by design, risk named in both
  files: if a port ever changes, change both.

## The rules of this repo, compressed (each earned the hard way — details in the named files)

1. **Lanes.** Your files are yours; other modules' files are ask-first; a
   cross-lane edit in an emergency is a DECLARED exception in the commit
   message, never a quiet one. Shared files: your `platformNav()`-equivalent
   function is yours, `PATHS` entries are additive-only, everything else
   ask-first (`lib/nav.tsx` header has the ratified rule).
2. **Migrations** are date-prefixed with the REAL date, idempotent, additive,
   and must survive `infra/scripts/verify-migrations.sh` — which builds all
   of them against a scratch database from empty, twice. Run it before any
   deploy that adds one. (Do not imitate the September-named 202609xx files;
   they are a documented mistake awaiting rename.)
3. **Build before commit; count files before push.** `git diff --cached
   --stat` and read the number. A green build proves the working tree, not
   the commit.
4. **Merged is not running.** Config that renders at container start
   (Postfix, Dovecot) needs its restart; deploy.sh handles the known ones.
   When you add a service, decide at birth how its config reaches the
   running process, and write it down.
5. **Secrets** never appear in chat, in output, or in a command that prints
   them. Generated where they are used (`read -rsp`, or straight into the
   destination file). Every secret's blast radius includes the nightly
   backup — backup.sh copies `.env` verbatim, and says so.
6. **A test you have only seen pass is not a test.** Calibrate: prove it can
   detect the thing before believing it. The verify-* scripts in
   infra/scripts are the house style — refusals, not warnings; guards that
   make the dangerous invocation structurally impossible.
7. **Documented is not built.** This platform found three "documented
   behaviours" in one week that had never existed. When a doc asserts what
   code does, grep for the caller before trusting it.

## When you build API keys / personal access tokens

That touches `Shared/Auth` — Core's, ask-first, and Core will pair on it
willingly: token format, hashing (see PasswordHasher.cs and the {SCHEME}
lesson in 20260828-mail-app-passwords.sql before choosing anything), and
how the auth middleware accepts a PAT beside a JWT are platform-wide
decisions. Per-organisation keys must respect `core.tenants` liveness the
way every credential store here does — a suspended org's keys die with it.

## Who to ask

Core (this document's author) for anything Shared/, infra/, or a ruling.
Amit for anything that changes what a customer is promised. The
platform-wide open-threads page is the map of who owes what.

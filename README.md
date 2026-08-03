# TatvaOS Mail

Multi-tenant business email hosting. One platform, many organisations, each on its own domain, completely isolated from every other.

> **New here? Read this file top to bottom, then `docs/setup/01-dev-environment.md`.** You should be running mail locally within an hour.

---

## The repository in one screen

```
tatvaOS/
│
├── apps/                    ← things that run
│   ├── web/                 Next.js — desktop web + mobile web + PWA
│   ├── mobile/              Expo — iOS and Android from ONE codebase
│   └── api/                 ASP.NET Core — the backend
│
├── packages/                ← shared code, used by web AND mobile
│   ├── core/                business logic: threading, MIME, sync
│   ├── api-client/          typed HTTP client (generated, do not hand-edit)
│   ├── types/               shared domain types (generated from C#)
│   ├── validation/          Zod schemas
│   ├── ui-tokens/           colours, spacing, typography
│   └── i18n/                translations
│
├── infra/                   ← things that are configured, not coded
│   ├── postfix/             MTA config + SQL lookups + milters
│   ├── dovecot/             IMAP/LMTP config + plugins
│   ├── rspamd/              spam filtering
│   ├── docker/              production compose files
│   ├── terraform/           servers, DNS, storage as code
│   └── dns/                 record templates for customer domains
│
├── local/                   ← the local dev stack. START HERE.
│                              docker compose up -d  → working mail server
│
├── tests/
│   ├── isolation/           ★ proves tenants cannot see each other
│   ├── e2e/                 Playwright
│   └── load/
│
├── docs/
│   ├── architecture/        how it works and why
│   ├── setup/               getting your machine ready
│   ├── runbooks/            what to do when it breaks
│   └── decisions/           ADRs — why we chose X over Y
│
└── scripts/                 setup and maintenance scripts
```

**The rule:** `apps/` runs, `packages/` is shared, `infra/` is configured, `docs/` explains. If you are unsure where something goes, it almost always belongs in `packages/`.

---

## Getting started

```powershell
# 1. Install everything (Windows, elevated PowerShell). Skips what you have.
.\scripts\setup-dev-env.ps1
```

```bash
# 2. Bring up a working mail server (inside WSL)
cd local
docker compose up -d --build
./scripts/test-mail.sh
./scripts/test-isolation.sh
```

Then open **http://localhost:8025** to see mail flowing.

Full detail: [`docs/setup/01-dev-environment.md`](docs/setup/01-dev-environment.md)

---

## Where do I put a new file?

The question every new developer actually has:

| I am adding… | It goes in |
|---|---|
| A web page or route | `apps/web/app/` |
| A React component for the web | `apps/web/components/` — `ui/` for generic, `mail/` and `admin/` for feature-specific |
| A mobile screen | `apps/mobile/app/` |
| A mobile component | `apps/mobile/components/` |
| **Logic used by BOTH web and mobile** | **`packages/core/src/`** — this is the important one |
| A shared type | `packages/types/` |
| A form validation rule | `packages/validation/` |
| An API endpoint | `apps/api/Modules/<Feature>/` |
| A background job | `apps/api/Workers/` |
| A database migration | `apps/api/Migrations/` |
| A Postfix or Dovecot setting | `infra/postfix/` or `infra/dovecot/` |
| An image or font for web | `apps/web/public/images/` or `public/fonts/` |
| An image or font for mobile | `apps/mobile/assets/images/` or `assets/fonts/` |
| A test that one tenant cannot see another's data | **`tests/isolation/`** — always |
| A "here is how to fix X at 3am" note | `docs/runbooks/` |
| "We chose PostgreSQL because…" | `docs/decisions/` |

### Two notes on structure, since they surprise people

**There is no top-level `css/` folder.** Next.js and Tailwind expect styles beside the components that use them; `apps/web/styles/` holds only `globals.css` and the Tailwind config. React Native has no CSS at all — mobile styling is NativeWind classes and JS objects. Separating stylesheets into their own tree would mean fighting both frameworks' defaults for no gain.

**There is no separate `android/` and `ios/`.** `apps/mobile/` builds both from one Expo codebase — that is the entire reason React Native was chosen. Genuinely platform-specific native configuration lives in `apps/mobile/native/`, and it stays small.

---

## The one idea that explains the codebase

**Every organisation is a tenant, and tenants must never see each other's mail.** Almost every design decision follows from that.

The subtlety is that the boundary is not uniform. The MTA is *inherently* cross-tenant — an SMTP connection arrives with no authentication, so Postfix must ask "does this recipient exist anywhere on the platform?" before it can reply `250` or `550`. So the database splits in two:

| | Tables | RLS | Mail edge access |
|---|---|---|---|
| **Routing** | `domains`, `mailboxes`, `aliases` | No | `SELECT` |
| **Content** | `messages`, `folders`, `attachments` | Enabled **and forced** | **None** |

A fully compromised mail edge leaks the address list, not the mail. That is the intended blast radius.

`tests/isolation/` is the actual guarantee — the RLS policy is only its implementation. **Add a case there for every endpoint you write.** No exceptions, for the life of the project.

Full reasoning: [`docs/architecture/01-architecture.md`](docs/architecture/01-architecture.md) §2.3

---

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js, React, TypeScript, Tailwind |
| Mobile | Expo / React Native (iOS + Android) |
| Backend | ASP.NET Core, .NET 10 LTS |
| Database | PostgreSQL 17 with Row-Level Security |
| Mail edge | Postfix, Dovecot, Rspamd |
| Cache / queue | Redis, Postgres `SKIP LOCKED` |
| Storage | S3-compatible (R2 / B2) |

Rationale and rejected alternatives: [`docs/architecture/02-tech-stack.md`](docs/architecture/02-tech-stack.md)

---

## Rules that are not negotiable

These are the mistakes that are expensive or impossible to undo.

1. **Never write an MTA or IMAP server.** Postfix and Dovecot have absorbed twenty years of interoperability edge cases. Custom logic goes in milters and plugins that call our API.
2. **Never remove `relayhost` from the local stack.** It is what stops test messages reaching real people.
3. **Every new endpoint gets an isolation test.** See above.
4. **Never put message content in a push notification payload.** Identifier and change token only; the device fetches over TLS after waking.
5. **Never return `250 OK` before the message is durably written.** Once accepted, that mail is ours forever.
6. **Keep the repo inside WSL, never on `/mnt/c`.** Cross-filesystem I/O is ~10× slower.

---

## Documentation map

| Read this | When |
|---|---|
| [`docs/setup/01-dev-environment.md`](docs/setup/01-dev-environment.md) | Day one |
| [`local/README.md`](local/README.md) | Running mail locally |
| [`docs/architecture/01-architecture.md`](docs/architecture/01-architecture.md) | Understanding the system |
| [`docs/architecture/02-tech-stack.md`](docs/architecture/02-tech-stack.md) | Why these technologies |
| [`docs/architecture/03-delivery-plan.md`](docs/architecture/03-delivery-plan.md) | What we are building next |
| [`docs/runbooks/`](docs/runbooks/) | Something is broken |

---

## Status

Pre-Phase 0. The local stack runs; the applications do not exist yet.

See [`docs/architecture/03-delivery-plan.md`](docs/architecture/03-delivery-plan.md) for phases, sprints and exit gates.

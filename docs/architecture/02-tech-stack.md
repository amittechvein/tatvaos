# TatvaOS Mail — Technology Stack

**Companion to:** TatvaOS Mail Architecture v0.1
**Date:** 2 August 2026
**Team:** Amit (engineering manager) + Claude (development team, ~5 developers of throughput)
**Covers:** Web app, mobile web, native Android, native iOS, backend, infrastructure

---

## 0. The Constraint That Shapes Every Choice

The stack below is not the stack a 20-person company would pick. It is optimised for one thing: **a two-person team shipping and then operating a product that cannot go down.**

That produces three rules, applied consistently throughout:

1. **One language per side of the wire.** TypeScript for everything users see, C# for everything behind the API. Two languages total. Every additional language is a context switch tax paid forever.
2. **Every running system must earn its place.** Your original draft listed ten distinct systems to operate. At two people, each one is a thing that can page you at 3 a.m. Section 7 cuts that list roughly in half for v1.
3. **Buy managed wherever the failure mode is data loss.** Losing customer mail ends the product. Self-hosting the durability layer to save ₹8,000/month is not a saving.

A note worth saying plainly, because you framed this as a product launch rather than a project: with Claude in the loop, writing the code is genuinely the part that scales down to two people. What does not scale down is **operating** it — on-call, deliverability reputation work, support tickets in customers' timezones, DNS hand-holding, abuse response, compliance questionnaires. Plan for that to be the binding constraint, not the code. Section 10 sequences around it.

---

## 1. The Stack at a Glance

| Layer | Choice | Version (Aug 2026) |
|---|---|---|
| **Language — frontend** | TypeScript | 5.x |
| **Language — backend** | C# | 14 |
| **Web app** | Next.js (App Router) | 16.2.x |
| **Mobile web** | Same Next.js app, responsive + PWA | — |
| **iOS + Android** | Expo / React Native | SDK 57 (RN 0.86, React 19.2) |
| **UI (web)** | Tailwind CSS + shadcn/ui | |
| **UI (mobile)** | Expo UI universal components + NativeWind | |
| **State / data** | TanStack Query + Zustand | |
| **Monorepo** | pnpm workspaces + Turborepo | |
| **API** | ASP.NET Core Minimal APIs | **.NET 10 LTS** |
| **ORM** | EF Core 10 (+ Dapper for hot paths) | |
| **Database** | PostgreSQL | 17 |
| **Cache / sessions** | Redis (managed) | 7.x |
| **Object storage** | Cloudflare R2 or Backblaze B2 | S3-compatible |
| **Background jobs** | Postgres queue (`SKIP LOCKED`) | not RabbitMQ at v1 |
| **Search** | Postgres FTS at v1 → OpenSearch later | |
| **MTA** | Postfix | |
| **IMAP/POP** | Dovecot | |
| **Anti-spam** | Rspamd | |
| **Anti-virus** | ClamAV + commercial engine | |
| **Push** | APNs (iOS) + FCM (Android) via your own service | |
| **Deploy** | Docker Compose on VMs → K8s much later | |
| **Auth** | ASP.NET Core Identity + OIDC, JWT | |

### One correction, and it has a deadline

Your draft specified **ASP.NET Core 9**. .NET 9 reaches end of support on **10 November 2026** — roughly three months from now. Build on **.NET 10 LTS**, supported through November 2028. Starting a multi-year product on a runtime that goes EOL before your beta would be an avoidable and irritating mistake.

---

## 2. Frontend Architecture — What Is Actually Shared

The critical framing: you named three frontend targets, but there are only **two codebases**, not three.

```
tatvaos-mail/                        ← single pnpm + Turborepo monorepo
├── apps/
│   ├── web/          Next.js 16     → desktop web + mobile web + PWA
│   ├── mobile/       Expo SDK 57    → iOS + Android
│   └── admin/        Next.js        → super-admin console (or a route group in web/)
│
├── packages/
│   ├── api-client/   typed client, generated from the OpenAPI spec
│   ├── core/         ★ business logic — threading, MIME parse, search
│   │                   query building, filter rules, date/quota formatting,
│   │                   draft state machine, offline sync reconciliation
│   ├── types/        shared domain types, generated from C# via NSwag
│   ├── ui-tokens/    colours, spacing, typography — one source of truth
│   └── validation/   Zod schemas shared by both apps and the forms
│
└── tooling/          eslint, tsconfig, prettier — configured once
```

**"Mobile version" is not a third build.** It is `apps/web` rendered responsively and installable as a PWA. Building a separate mobile website is a 2010 pattern that would give you three UIs to keep in sync forever. One responsive Next.js app covers desktop browsers, mobile browsers, and the installable PWA.

**Realistic sharing ratio.** Expect **60–70%** of frontend work to be shared through `packages/`, and 30–40% to be genuinely per-platform UI. Be sceptical of anyone claiming 90%+ — a keyboard-driven three-pane desktop inbox and a thumb-driven swipe-to-archive mobile list are *supposed* to be different. Share the logic, not the layout.

`packages/core` is where the leverage is. Message threading, MIME parsing, search query parsing, the draft autosave state machine, and offline reconciliation are hard, subtle, well-testable, and identical on every platform. Write them once, test them hard, never think about them again.

---

## 3. Web App

**Next.js 16 (App Router) + React 19, TypeScript, Tailwind, shadcn/ui.**

| Concern | Choice | Why |
|---|---|---|
| Rendering | Mostly client-side after auth | An inbox is an app, not a document. SSR the marketing site, login, and admin console; the mail client itself is a SPA |
| Data | TanStack Query | Cache, background refetch, optimistic updates — exactly the semantics of a mail UI |
| Local state | Zustand | Selection, compose windows, layout. Redux is overkill for two people |
| Offline / local store | IndexedDB via Dexie | Recent messages cached locally; the inbox opens instantly and survives a dropped connection |
| Realtime | WebSocket (SignalR) | New mail, read-state sync across tabs and devices |
| Virtualised lists | TanStack Virtual | A 50,000-message folder must scroll at 60fps |
| Rich text | TipTap (ProseMirror) | Compose. Do not hand-roll a contenteditable editor |
| **HTML sanitisation** | **DOMPurify + sandboxed iframe + strict CSP** | **Non-negotiable — see below** |
| Forms | React Hook Form + Zod | Zod schemas shared with mobile and the API |
| Testing | Vitest + Playwright | Playwright also covers the isolation test suite |

### Rendering untrusted email HTML

This deserves its own callout because it is the highest-severity frontend risk in the entire product. Every message you display is attacker-controlled HTML, sent to your users by strangers, for free. The layered defence:

1. Sanitise server-side on ingest (store both raw and sanitised).
2. Sanitise again client-side with DOMPurify — never trust a single pass.
3. Render inside a `sandbox`ed iframe on a **separate origin**, so a bypass cannot reach your session, tokens, or DOM.
4. Strict CSP; block all remote content (images, fonts, CSS) until the user clicks "show images" — this is both an XSS control and the tracking-pixel protection users expect.
5. Rewrite every link through a warning interstitial for first-time or lookalike domains.

Gmail and Outlook have each shipped high-severity CVEs in exactly this area. Assume you will too, and build so that a bypass is contained.

---

## 4. Mobile Web and PWA

Same codebase as §3, with:

- Responsive breakpoints: three-pane on desktop → two-pane on tablet → single-pane stack with swipe navigation on phones
- Web App Manifest, installable, custom splash and icon
- Service worker for offline read access and asset caching
- Web Push where supported

**iOS PWA limitations, stated honestly:** Safari supports web push only for PWAs the user has explicitly added to the Home Screen, background sync is unreliable, and storage can be evicted under pressure. The PWA is a good fallback and a good desktop-Linux/ChromeOS story. It is **not** a substitute for a native iOS app. Which leads directly to the next section.

---

## 5. Native Mobile — iOS and Android

### 5.1 Choice: Expo (React Native), SDK 57

Rationale, in order of weight for a two-person team:

1. **Same language and mental model as the web app.** You move between `apps/web` and `apps/mobile` without changing languages, and `packages/core` is literally the same code.
2. **One codebase for both platforms.** Building separately in Swift and Kotlin roughly doubles mobile effort — the single most expensive decision available to you.
3. **EAS Build removes the Mac/CI/signing tax.** Cloud builds for both platforms, certificate management handled. For a two-person team with no dedicated mobile engineer, this alone is worth the choice.
4. **OTA updates.** Push JS fixes without a store review cycle. When a bug is in front of paying customers, waiting 48 hours for App Store review is a bad day.
5. **Expo SDK 57 is current and healthy** — React Native 0.86, React 19.2, New Architecture, and the universal components API from SDK 56 that makes shared primitives practical.

Native modules remain available when you need them (background sync, secure keychain, notification service extensions), so the escape hatch is real.

### 5.2 The argument for building the app *earlier* than you would think

There is a hard platform fact that changes the sequencing:

**Apple's push API for Mail is private and available only to iCloud. iOS has never supported IMAP IDLE, and third-party apps cannot hold a persistent IMAP connection in the background.** Any account added to iOS Mail as generic IMAP is limited to periodic *fetch* — typically 15+ minute delays, and users widely report scheduled fetch failing to notify at all.

The consequence for TatvaOS Mail: if you launch IMAP-only and tell customers to use iOS Mail, **their mail will feel slow, and they will blame you, not Apple.** "New email takes 20 minutes to arrive on my phone" reads as a broken product to a paying customer.

The only reliable fix is your own app with your own APNs pipeline. (The `XAPPLEPUSHSERVICE` / Dovecot route exists but depends on Apple push certificates issued for a deprecated macOS Server path — treat it as unsupported and do not build the product on it.)

**So: the iOS app is not a phase-4 luxury. It is a launch requirement, and it should ship at beta.**

### 5.3 Mobile stack detail

| Concern | Choice |
|---|---|
| Framework | Expo SDK 57 / React Native 0.86 |
| Navigation | Expo Router (file-based, matches Next.js conventions) |
| Styling | NativeWind (Tailwind syntax) + Expo UI universal components |
| Local database | SQLite via `expo-sqlite` + Drizzle |
| Sync | Custom delta sync against your API — **not** IMAP from the device |
| Secure storage | `expo-secure-store` (Keychain / Keystore) |
| Push | `expo-notifications` → APNs + FCM |
| Background | `expo-background-task` for opportunistic sync |
| Attachments | `expo-file-system`, `expo-document-picker`, `expo-sharing` |
| Biometrics | `expo-local-authentication` — app lock via Face ID / fingerprint |
| Builds | EAS Build + EAS Submit |
| OTA | EAS Update |
| Crash / perf | Sentry |

**The app talks to your REST API, never IMAP directly.** IMAP is a poor mobile protocol — chatty, stateful, battery-hostile. Your own delta-sync endpoint (`GET /sync?since=<cursor>`) returns exactly what changed, in one round trip. IMAP exists for third-party clients like Outlook and Thunderbird; your own app should not use it.

### 5.4 Push architecture

```
Message delivered (Dovecot LDA / your delivery service)
            ▼
   Push dispatch service (.NET background worker)
            ▼
   Device registry lookup (user → devices → tokens, per tenant)
            ▼
     ┌──────┴───────┐
     ▼              ▼
   APNs           FCM
  (iOS)         (Android)
     │              │
     ▼              ▼
 Notification Service Extension / background handler
     │
     ▼
 Fetch message via API → decrypt/render → show notification
```

Send a *minimal* payload — sender and a flag — and let the device fetch content over TLS from your API. Do not put message bodies in push payloads; they pass through Apple's and Google's infrastructure, and enterprise customers will ask about exactly this.

Two operational details that bite later: keep an APNs `.p8` key rotation runbook (expiry breaks push silently and completely), and prune stale device tokens aggressively — APNs feedback for unregistered devices, or you slowly accumulate failures.

The push pipeline requires one backend table the architecture document's data model does not yet have:

```sql
devices
  id, tenant_id, user_id, platform (ios|android|web),
  push_token, app_version, os_version,
  created_at, last_seen_at, revoked_at
```

Which in turn enables three things business customers will ask for: a per-device session list in the admin console, **remote wipe** (revoke tokens + clear the local store on next wake) for lost or stolen phones, and forced sign-out on offboarding.

### 5.5 Store policy and billing — a decision with direct revenue impact

**Do not sell subscriptions through in-app purchase.** TatvaOS Mail is B2B SaaS: an organization admin buys seats on the web, then individual users sign in on mobile. Apple's multiplatform-services carve-out and Google's equivalent both permit sign-in-only apps with no commission owed. Routing billing through IAP instead would hand over 15–30% of revenue for no benefit — and it does not even fit the model, since the buyer and the app user are usually different people.

Consequences worth designing around now rather than discovering at review:

| Item | Implication |
|---|---|
| **Sign-in only, no sign-up** | Apple requires in-app account *deletion* wherever there is in-app account *creation*. Since mailboxes are admin-provisioned anyway, keeping account creation out of the app sidesteps this entirely |
| **US external purchase links** | Following the Epic v. Apple contempt ruling and the Ninth Circuit decision, US-storefront apps may link out to web checkout without an Apple fee. Useful leverage, but largely moot if you never sell in-app |
| **Data-safety declarations** | Scrutinised heavily for email apps on both stores. An inaccurate declaration blocks the release — budget real time, and have Legal review it once |
| **Background modes / entitlements** | iOS review will ask why you need them. Have the justification written before submitting, not improvised during an appeal |
| **Android Enterprise / Managed Google Play** | Worth supporting — it is a genuine unblocker for business deals where IT requires MDM distribution |
| **Review latency** | Store review sits on your critical path for any native change. This is the second argument for EAS Update: JS fixes ship in minutes, not days |

### 5.6 Mobile-specific security

Beyond the HTML-rendering defences in §3 — which apply identically inside the app's WebView, with JavaScript disabled:

- **Certificate pinning** on the API domain, with a documented rotation procedure. A pin you cannot rotate is an outage waiting to happen.
- **PKCE, no client secret.** Anything shipped in the bundle is public. OAuth Authorization Code + PKCE only, with refresh-token rotation.
- **Biometric app lock** via `expo-local-authentication`, configurable auto-lock interval, enforceable as an org-level policy.
- **`FLAG_SECURE` / screenshot blocking** as an org policy option — routinely required by hospital and finance customers.
- **Jailbreak/root signalling** as a policy input, not a hard block. Treat it as a risk signal for admins, since hard blocks are trivially bypassed and mostly annoy legitimate users.

---

## 6. Backend

**ASP.NET Core on .NET 10 LTS. Confirming your original choice** — it is genuinely well suited here: excellent performance, first-class async, strong typing, superb tooling, and a runtime that will still be supported in 2028.

| Concern | Choice | Note |
|---|---|---|
| API style | Minimal APIs + OpenAPI | Generates the TS client for both apps |
| ORM | EF Core 10 | Global query filters carry the tenant boundary |
| Hot paths | Dapper | Message list and sync queries — bypass EF where it counts |
| Validation | FluentValidation | |
| Auth | ASP.NET Core Identity + OIDC + JWT | |
| Realtime | SignalR | WebSocket for web, fallback handled |
| Jobs | Postgres queue + hosted services | See §7 — not RabbitMQ at v1 |
| Mapping | Mapperly (source-generated) | No reflection cost |
| Logging | Serilog → structured JSON | |
| Observability | OpenTelemetry → Grafana stack | |
| Testing | xUnit + Testcontainers | **Real Postgres in tests — RLS cannot be tested against an in-memory provider** |
| Migrations | EF Core migrations | |

### Architecture shape

**A modular monolith, not microservices.** One deployable API with clean internal module boundaries (Tenancy, Mail, Admin, Billing, Search). Microservices at two people is a distributed-systems tax with no organisational benefit — you would inherit all the operational complexity and none of the team-autonomy payoff that justifies it. Keep module boundaries clean so extraction stays possible; extract only when a specific component actually needs independent scaling.

Two things run **outside** the monolith from day one, because they scale and fail differently:

- **Mail edge** — Postfix + Dovecot + Rspamd on dedicated hosts with static IPs and PTR records
- **Delivery/sync workers** — background processing, scaled separately from request traffic

### The mail edge — restating it because it is load-bearing

Postfix, Dovecot and Rspamd. Do not write an MTA or IMAP server in C#. Your custom logic lives in **milters** and **Dovecot plugins** that call your API — that is the correct integration seam, and it is well-trodden. This is the single highest-leverage "don't build it" decision in the whole product, and it is worth more than any framework choice in this document.

---

## 7. Infrastructure — What to Cut for v1

Your original draft listed PostgreSQL, Redis, OpenSearch, RabbitMQ, MinIO, Kubernetes, Postfix, Dovecot, Rspamd, ClamAV, Nginx. That is eleven systems. **Each is a thing two people must patch, monitor, back up, and debug at 3 a.m.**

| System | v1 verdict | Reasoning |
|---|---|---|
| PostgreSQL | **Keep — managed** | The core. RLS is why this DB was the right call |
| Redis | **Keep — managed** | Cheap, high value, low operational cost |
| Postfix / Dovecot / Rspamd | **Keep — self-hosted** | Unavoidable, and correct |
| ClamAV | **Keep** | Plus a commercial engine before GA |
| Object storage | **Keep — managed (R2 / B2 / S3)** | **Not self-hosted MinIO.** If MinIO loses data, you have lost customers' mail permanently. Do not own that failure mode at two people |
| OpenSearch | **Cut at v1** | Postgres full-text search with `tsvector` + GIN handles mail search well into the tens of GB. Add OpenSearch when a real tenant outgrows it — a migration you will be glad to have earned |
| RabbitMQ | **Cut at v1** | A Postgres jobs table with `FOR UPDATE SKIP LOCKED` gives you a durable queue with transactional enqueue and zero new infrastructure. Transactional enqueue is actually *better* here: the job cannot exist unless the message write committed |
| Kubernetes | **Cut at v1** | K8s is a part-time job for a person you do not have. Docker Compose on a handful of properly-sized VMs will carry you to hundreds of tenants. Adopt K8s when scaling pain is real, not anticipated |
| Nginx / Traefik | **Keep** | Caddy is also fine — automatic TLS is a genuine time saver |

**Net: eleven systems down to seven, with the two most dangerous (self-hosted object storage, Kubernetes) removed.** Every one of these is reversible later, and each is easier to add under real load than to operate under imaginary load.

### Hosting

Mail infrastructure needs static IPs, PTR/rDNS control, and a provider that will not shut you down for running SMTP. Hetzner, OVH, or a dedicated-IP arrangement on a major cloud. **Verify PTR record control and SMTP policy before committing** — several providers block port 25 outright, and finding out after you have built is expensive.

Keep the mail edge and the application tier on separate hosts. Different scaling curves, different patch cadences, and a compromised web tier should not be an open relay.

---

## 8. Rejected Alternatives

| Rejected | Why |
|---|---|
| **Flutter** | Excellent mobile framework. But it is a third language (Dart), Flutter web renders to canvas — poor for a text-dense, accessibility-sensitive, SEO-relevant email client — and you would share nothing with the web app. Wrong fit for *this* product, not a bad framework |
| **.NET MAUI / Blazor Hybrid** | Tempting for language unification with the backend. But the mobile ecosystem, community, and third-party library depth are far behind React Native, and Blazor WASM's payload and interaction latency are wrong for an inbox |
| **Native Swift + Kotlin** | Best possible mobile experience, roughly 2× the mobile effort and two more languages. Revisit only if mobile becomes the dominant surface and you have hired for it |
| **Expo Router universal (one app for web + mobile)** | Genuinely appealing — one UI codebase for all three targets. But react-native-web output for a dense desktop inbox is a real compromise: keyboard navigation, right-click menus, multi-select, drag-and-drop, and SEO for marketing pages all suffer. Next.js for web + Expo for mobile is the right split for an email client specifically |
| **Node.js / NestJS backend** | Would unify on one language everywhere. But you already know C#, ASP.NET Core outperforms it for this workload, and the type safety is stronger. Not worth switching |
| **GraphQL** | Overhead without benefit at two people and one client team. REST + OpenAPI + generated TS client gives you end-to-end types with far less machinery |
| **Microservices** | All of the operational cost, none of the organisational benefit, at this team size |
| **Writing the MTA/IMAP server** | Twenty years of interop edge cases you would rediscover in production, one angry customer at a time |
| **JMAP at v1** | Correct protocol, wrong decade. Client support is near-zero. Your own app uses your REST API anyway |

---

## 9. Third-Party Services

Building these yourself is a poor use of a two-person team:

| Need | Service |
|---|---|
| Payments (India) | Razorpay (UPI, GST invoicing) + Stripe for international — **web checkout only, never in-app purchase (§5.5)** |
| Transactional email (signup, alerts) | Resend or SES — **separate IPs and domain from customer mail.** Never mix the two reputation profiles |
| SMS / OTP | MSG91 or Twilio |
| Error tracking | Sentry (web, mobile, backend) |
| Product analytics | PostHog (self-hostable if data residency demands it) |
| Support desk | Crisp or Intercom |
| Status page | BetterStack or Instatus — email customers *will* ask |
| Uptime monitoring | BetterStack, with SMTP/IMAP protocol checks, not just HTTP |
| Secrets | Infisical or cloud KMS |
| CI/CD | GitHub Actions + EAS |

---

> **Note on sizing.** Sections below were written for a solo build. The stack
> choices stand — they were chosen for operability, not headcount, and a smaller
> number of moving parts is right at any team size. Only the timeline changed;
> see `03-delivery-plan.md` for current estimates.

## 10. Build Order

> **See `TatvaOS-Mail-Delivery-Plan.md` for the authoritative plan** — sprint-level detail for phases 0–2, exit gates, cut-order, and hiring triggers, sized for a solo build. Summary below.

The sequencing matters more than the stack. Do not build all three clients in parallel.

| Phase | Duration | Build | Deliberately not yet |
|---|---|---|---|
| **0 — Spike** | 6 wks | Postfix + Dovecot + Postgres. Send and receive on one domain. Prove the edge before designing around it | Any UI |
| **1 — Backend + web** | 5 mo | .NET API, RLS multi-tenancy, monorepo, Next.js web client, admin console. Dogfood from here | Mobile |
| **2a — Extract core** | 2 wks | Pull threading, sync, MIME, search into `packages/core`. **Do this before the mobile app exists**, or you will write it twice | |
| **2b — Mobile app** | 2.5 mo | Expo app, both platforms, push pipeline, offline sync. `packages/core` makes this far cheaper than it looks | |
| **3 — Private beta** | 3.5 mo | Migration tooling, billing, quotas, groups, shared mailboxes. Techvein's own mail runs on it | |
| **4 — Hardening** | 4 mo | Deliverability, pentest, DR drill, runbooks, status page | |
| **5 — GA** | 2.5 mo | Self-serve signup, pricing, docs, SLA, launch | |

**Phase 2a is the one people skip and regret.** Extracting shared logic *before* the second client exists costs two weeks. Extracting it after costs a rewrite plus every bug you fixed once and now must fix twice.

Total: roughly **19–20 months to a credible GA solo**, 12–16 with a second engineer. Both figures already assume high velocity on the code — the difference is operations, support and deliverability, none of which parallelise with AI leverage.

---

## 11. What This Stack Does Not Solve

Stated plainly, because a stack document can create a false sense that the hard parts are chosen rather than earned:

- **Deliverability** is an operational discipline measured in months of IP warm-up, postmaster-tool monitoring, and blocklist response. No framework helps. See §12 of the architecture doc — including the relay-first option, which for a two-person team is worth taking seriously rather than treating as a compromise.
- **24×7 operations.** Two people cannot sustainably hold a pager for a service where a two-hour outage means a customer misses a contract. Before GA, decide: a third hire, a managed NOC, or an explicitly limited SLA honestly disclosed.
- **Support load.** DNS is confusing to customers. Every onboarding generates tickets. Budget real hours for it, and invest heavily in the DNS checker from architecture §3.4 — it is the highest-ROI feature in the product.
- **Zoho.** They are cheap, competent, Indian, and entrenched in exactly your target market. The stack does not differentiate you; ERP integration, local support, and being genuinely easier to onboard might.

None of that is a reason not to build it. It is what to build the plan around.

---

## Appendix — Repository Skeleton

```
tatvaos-mail/
├── apps/
│   ├── web/                  Next.js 16 — web + mobile web + PWA
│   ├── mobile/               Expo SDK 57 — iOS + Android
│   └── api/                  ASP.NET Core .NET 10 (modular monolith)
│       ├── Modules/
│       │   ├── Tenancy/
│       │   ├── Mail/
│       │   ├── Admin/
│       │   ├── Billing/
│       │   └── Search/
│       ├── Workers/          delivery, sync, push dispatch, jobs
│       └── Shared/           TenantContext, RLS plumbing
│
├── packages/
│   ├── api-client/           generated from OpenAPI
│   ├── core/                 ★ shared business logic
│   ├── types/                generated from C# (NSwag)
│   ├── ui-tokens/
│   └── validation/           Zod schemas
│
├── infra/
│   ├── postfix/              config + milters
│   ├── dovecot/              config + plugins
│   ├── rspamd/
│   ├── compose/              docker-compose per environment
│   └── terraform/            VMs, DNS, storage buckets
│
├── tests/
│   ├── isolation/            ★ cross-tenant access must fail — architecture §2.3
│   ├── e2e/                  Playwright
│   └── load/
│
└── docs/
    ├── architecture.md
    ├── tech-stack.md         ← this document
    └── runbooks/             ★ write these before GA, not after the first outage
```

---

*Two starred items carry more weight than the rest of the document: `packages/core` (extract it in phase 2, not later) and `tests/isolation` (it is the actual tenant-isolation guarantee — the RLS policy is only its implementation).*

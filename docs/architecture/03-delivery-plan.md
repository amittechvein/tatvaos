# TatvaOS Mail — Phase-Wise Development Plan

**Companion to:** Architecture v0.1 · Technology Stack
**Date:** 2 August 2026
**Team assumption:** **1 engineer (Amit) + Claude**
**Supersedes:** the phase tables in Architecture §15 and Tech Stack §10, which assumed a larger team

---

## 0. What Solo Actually Changes

Worth being direct about this up front, because every date and every scope decision below follows from it.

**What one person plus Claude can genuinely do:** write this codebase. That is not optimism. A multi-tenant mail platform is a large but well-understood body of code — schemas, APIs, sync logic, two clients, admin consoles. With heavy AI leverage, code output stops being the binding constraint.

**What one person plus Claude cannot do:** *operate* it. The list is short and non-negotiable:

| Solo does not scale to | Why |
|---|---|
| 24×7 on-call | A two-hour outage means a customer missed a contract. One person cannot hold a pager indefinitely, and email has no acceptable maintenance window |
| Deliverability operations | Months of IP warm-up, daily postmaster-tool monitoring, blocklist delisting, abuse-desk response. It is a part-time job that never ends |
| Support in customer hours | Every onboarding generates DNS tickets. Business customers expect a reply the same day |
| Compliance questionnaires | Enterprise deals arrive with 200-question security reviews |

This does not block the build. It blocks **selling with an SLA**, which is a different and later problem. The plan below is therefore structured so that everything up to and including a private beta is solo-feasible, and the hard hiring gate sits at Phase 4 — before the first paying customer who is entitled to be angry.

### The three decisions solo forces

**1. Relay-first outbound is now settled, not open.** Architecture §17 listed own-IPs vs relay as an open decision. Solo closes it: relay through SES/Postmark/Resend on your own domains and DKIM keys for the first 12–18 months. You give up some margin and control. You gain: no IP warm-up schedule, no blocklist firefighting, no reputation cliff caused by one spammy tenant, and roughly a full day a week back. Warm your own IPs in parallel, quietly, and migrate when there is someone to watch them.

**2. Scope shrinks to the smallest thing that is genuinely useful.** Cuts, applied throughout: no POP3 at v1 (IMAP only), no DLP, no archiving/legal hold, no white-label, no multi-domain-per-tenant until Phase 3, no AI features until post-GA. Each is defensible to a customer. Shipping late is not.

**3. Dogfooding starts in Phase 1, not Phase 4.** Your own mail on the platform is the only realistic substitute for a QA function. If it is not good enough for you, it is not good enough to sell — and you will find out in month five instead of month fifteen.

### Revised timeline

| Phase | Duration | Cumulative | Milestone |
|---|---|---|---|
| 0 — Spike | 6 wks | 1.5 mo | Real mail sent and received |
| 1 — Backend + web | 5 mo | 6.5 mo | You use it as your primary mail |
| 2 — Core extract + mobile | 3 mo | 9.5 mo | Apps on TestFlight / Play internal |
| 3 — Private beta | 3.5 mo | 13 mo | 5 design-partner tenants live |
| 4 — Hardening | 4 mo | 17 mo | Pentest closed, ops cover in place |
| 5 — GA | 2.5 mo | **~19.5 mo** | Public launch |

**Roughly 19–20 months to a credible GA, with a private beta at 13 months.** The Tech Stack doc's 12–16 month figure assumed two people; this is the honest solo adjustment. If that timeline is unacceptable, the lever is hiring, not compression — §8 lists what to cut and what it costs you.

---

## 1. How to Read the Phase Detail

Phases 0–2 are broken into two-week sprints, because they are near enough to plan concretely. Phases 3–6 are epic-level, because sprint-planning work 12 months out is fiction.

Every phase has an **exit gate**. Gates are not milestones to celebrate — they are questions with a "no" answer available. A gate that cannot fail is decoration.

---

# PHASE 0 — Spike

**Duration:** 6 weeks (3 sprints) · **Goal:** prove the mail edge before building anything on top of it

The purpose of Phase 0 is to fail cheaply. Every expensive mistake in this category of product is discoverable in six weeks, and almost nobody looks.

### Sprint 0.1 — Infrastructure reality check (weeks 1–2)

| # | Task | Note |
|---|---|---|
| 1 | **Verify outbound port 25 and PTR control with your hosting provider — in writing, before paying** | Hard go/no-go. Many providers block 25 outright or will not delegate rDNS. Discovering this in month eight is catastrophic |
| 2 | Register a **throwaway** test domain | Never experiment on `tatvaos.com` or `techvein.com` — a burned reputation is very slow to repair |
| 3 | Provision 2 VMs: `mail-edge`, `app` | Hetzner or OVH. Separate hosts from day one |
| 4 | Postfix installed, accepting on :25 | |
| 5 | Dovecot installed, IMAP login with a static file-backed user | |
| 6 | Connect Thunderbird, read a message | |

**Exit:** you have received a real email from the public internet and read it in a real client.

### Sprint 0.2 — Deliverability baseline (weeks 3–4)

| # | Task | Note |
|---|---|---|
| 1 | SPF, DKIM, DMARC on the test domain | DKIM signing via Rspamd |
| 2 | PTR / rDNS configured and verified | |
| 3 | Rspamd installed, scoring inbound | |
| 4 | **Send to Gmail, Outlook, Yahoo. Record inbox vs spam for each** | This is your reality baseline. Write the results down |
| 5 | mail-tester.com — target 10/10 | |
| 6 | Register Google Postmaster Tools, Microsoft SNDS | Free, and you want history before you need it |
| 7 | **Send the same test through SES or Postmark and compare** | This is the empirical input to the relay-vs-own-IP decision |

**Exit:** 10/10 on mail-tester, and a documented comparison of cold-IP vs relay delivery to the big three receivers. If cold-IP mail is landing in spam, you have learned the single most important fact about this business in four weeks rather than fourteen months.

### Sprint 0.3 — The integration seam (weeks 5–6)

| # | Task | Note |
|---|---|---|
| 1 | Postgres with a minimal `domains` / `mailboxes` schema | |
| 2 | Dovecot `userdb`/`passdb` backed by Postgres | Proves virtual users work — the whole multi-tenant model depends on it |
| 3 | Postfix → Dovecot delivery over LMTP | |
| 4 | Milter (or Rspamd Lua) calling a stub .NET endpoint for recipient validation | **Reject unknown recipients at SMTP time**, never accept-then-bounce |
| 5 | All config committed as code — `docker-compose` + config files in git | No hand-edited servers, ever |
| 6 | Teardown-and-rebuild test | Can you recreate the edge from git in under an hour? |

### ▣ PHASE 0 EXIT GATE

- [x] Mail delivered to a Postgres-backed virtual user *(locally — 26/26 green)*
- [ ] Outbound reaching Gmail **inbox**, verified  ← **the actual gate**
- [x] Mail edge rebuildable from git *(`local/` rebuilds from scratch)*
- [ ] **Decision recorded: relay-first (expected) or own IPs**
- [ ] Provider confirmed in writing on port 25 + rDNS

**Status: local half done, real half not started.**

What the local stack proved: the software works. Virtual domain and mailbox
lookups, alias resolution, reject-at-SMTP-time, LMTP handoff, IMAP auth against
Postgres, and tenant isolation under RLS.

What it cannot prove, and what Phase 0 actually exists to answer: **whether mail
from a new IP reaches a Gmail inbox.** That needs a real VM with a real address.
No amount of local green ticks substitutes for it, and it is the finding that
decides whether this business is viable — see §12 and §16.

Three defects found and fixed while getting here, all recorded in
`docs/runbooks/01-mail-edge-config-errors.md`:

| Defect | Why it mattered |
|---|---|
| Postfix trailing comments | `bad numerical configuration` — config silently invalid |
| Dovecot one-line blocks | `Garbage after '{'` — container crash-looped |
| **`permit_mynetworks` on port 25** | **Open relay.** Would have been found by scanners within hours of going live |

The third is the one worth remembering. It was caught by a test asserting that
something which *should* fail does. Keep writing those.

**Fail condition:** if you cannot get clean delivery and cannot get relay economics to work, stop here. That is a good outcome for six weeks of effort.

---

# PHASE 1 — Backend and Web Client

**Duration:** 5 months (10 sprints) · **Goal:** you use TatvaOS Mail as your primary mail account

### Sprint 1.1 — Foundations (weeks 1–2)

- Monorepo: pnpm workspaces + Turborepo, tooling configured once
- .NET 10 solution as a modular monolith — `Tenancy`, `Mail`, `Admin`, `Billing`, `Search` modules
- Postgres 17, EF Core 10, first migration
- **RLS enabled in the first migration, not retrofitted.** `FORCE ROW LEVEL SECURITY`, app role without `BYPASSRLS`
- `TenantContext` + `SET LOCAL app.tenant_id` on connection open
- Testcontainers harness — real Postgres in tests, since RLS cannot be tested against an in-memory provider
- **`tests/isolation` created with its first three cases**

> The isolation suite is started in week one and grows with every feature for the rest of the project. It is the actual tenant-isolation guarantee; the RLS policy is only its implementation.

### Sprint 1.2 — Identity and tenancy (weeks 3–4)

- Tenant signup → organization creation
- ASP.NET Identity, Argon2id hashing
- OIDC + JWT, refresh-token rotation, server-side revocation
- Role model from Architecture §4 (including `Support Engineer` and `Delegate`)
- Audit-log write path — append-only, wired in from the start rather than bolted on
- TOTP MFA for admin roles

### Sprint 1.3 — Users, mailboxes, admin skeleton (weeks 5–6)

- `users` and `mailboxes` as **separate entities** (Architecture §2.1)
- Admin API: create/suspend/delete users, provision mailboxes, reset passwords
- Quota fields, incremental `used_bytes` accounting
- Admin console shell in Next.js

### Sprint 1.4 — Domains and DNS (weeks 7–8)

- Add domain, TXT ownership token, polling verification with backoff
- Per-domain DKIM keypair generation, private key in a secrets store
- **The DNS checker** — every required record shown as pass / fail / *present-but-wrong*, with actual value beside expected

> The DNS checker is the highest-ROI feature in the entire product. Most support tickets in this business are DNS tickets, and solo, every deflected ticket is an hour you did not lose.

### Sprint 1.5 — Inbound mail path (weeks 9–10)

- Milter: recipient validation against Postgres, tenant resolution from recipient domain
- Delivery service: MIME body → object storage (R2/B2), metadata + headers → Postgres
- Attachment extraction, SHA-256 dedup **within tenant only**
- ClamAV scanning
- `messages` partitioned by tenant hash + `received_at` range
- Folder model with IMAP `UIDVALIDITY` / monotonic `UID` designed in now

### Sprint 1.6 — Outbound and jobs (weeks 11–12)

- Submission on :587, authenticated, STARTTLS
- Per-user and per-tenant rate limits
- DKIM signing with the tenant's domain key
- Relay integration (SES/Postmark) with bounce and complaint webhooks
- Suppression list
- Postgres job queue via `FOR UPDATE SKIP LOCKED`

### Sprint 1.7 — Sync API and search (weeks 13–14)

- **JMAP-shaped delta-sync API**: `/sync/changes?since=<cursor>` + batched get, tombstones for deletes
- Postgres FTS with `tsvector` + GIN
- SignalR channel for live updates

> Build the sync API *before* the web client, even though only one client exists. The web app is then your proof that the API is right, months before the mobile app depends on it.

### Sprints 1.8–1.9 — Web client core (weeks 15–18)

- Next.js app shell, auth flow, layout
- Message list with **TanStack Virtual** — non-negotiable at 50k messages
- Thread view and conversation grouping
- **HTML email rendering done properly the first time**: server-side sanitise on ingest, DOMPurify client-side, sandboxed iframe on a separate origin, strict CSP, remote content blocked until the user asks
- Folders, read/unread, archive, delete, star

### Sprint 1.10 — Compose and responsive (weeks 19–20)

- TipTap composer, draft autosave state machine, attachments
- Reply / reply-all / forward with correct quoting and headers
- Search UI
- Responsive: three-pane → two-pane → single-pane with swipe
- PWA manifest, service worker, installable
- Settings: signature, filters, aliases display

### ▣ PHASE 1 EXIT GATE

- [ ] **Your own mail runs on it, on a real domain, as your primary account**
- [ ] Isolation suite green, covering every endpoint added so far
- [ ] Send, receive, search, compose, attach — all working from the web app
- [ ] Two tenants coexisting with verified data separation
- [ ] Backup taken **and restored** at least once

**The dogfood criterion is the real gate.** If you are still keeping Gmail open in another tab, Phase 1 is not done, and no amount of feature checkboxes changes that.

---

# PHASE 2 — Shared Core and Mobile Apps

**Duration:** 3 months (6 sprints) · **Goal:** iOS and Android apps in testing, push working reliably

### Sprint 2.1 — Extract `packages/core` (weeks 1–2)

Threading, MIME helpers, search query parsing, draft state machine, sync reconciliation, date/quota formatting, validation schemas — pulled out of the web app into shared packages, with tests.

> **This is the sprint people skip and regret.** Extracting shared logic before the second client exists costs two weeks. Extracting it afterwards costs a rewrite, plus every bug you already fixed once and now get to fix twice. Do not let it slip.

### Sprint 2.2 — Mobile scaffolding (weeks 3–4)

- Expo SDK 57 app, Expo Router
- **EAS Build configured for both platforms on day one** — Apple Developer account, certificates, provisioning, Play Console setup. Signing eats a week and it is better spent now than during a release crunch
- Auth via PKCE, tokens in `expo-secure-store`
- SQLite + Drizzle local store, schema mirroring the sync API

### Sprint 2.3 — Mobile mail UI (weeks 5–6)

- Message list with FlashList, thread view
- WebView rendering with **JavaScript disabled**, remote content blocked
- Offline-first read: headers and recent bodies local, attachments on demand
- Swipe actions, pull-to-refresh

### Sprint 2.4 — Push pipeline (weeks 7–8)

- `devices` table and registration flow
- .NET push-dispatch worker: delivery event → device lookup → APNs / FCM
- **Minimal payloads** — identifier and change token only, never subject or body
- Notification Service Extension on iOS for fetch-on-wake
- **Test on real devices, real cellular networks, backgrounded, in low-power mode.** Simulator results mean nothing here
- APNs `.p8` rotation runbook; stale token pruning

> Users judge a mail app almost entirely on notification reliability. Budget the full sprint and expect it to be the fiddliest work in the project.

### Sprint 2.5 — Compose, offline, security (weeks 9–10)

- Compose with attachments, offline outbox with retry
- Biometric app lock, configurable auto-lock
- Certificate pinning with a documented rotation procedure
- Remote wipe endpoint and admin UI
- Sentry on all three surfaces

### Sprint 2.6 — Store submission (weeks 11–12)

- Store listings, screenshots, privacy and data-safety declarations
- **Sign-in only — no account creation, no in-app purchase** (Tech Stack §5.5)
- Background-mode justification written before submitting
- TestFlight and Play internal testing
- **Submit early and expect rejection.** A first-round rejection is routine; budget two weeks of round-trips

### ▣ PHASE 2 EXIT GATE

- [ ] Apps live on TestFlight and Play internal track
- [ ] **Push arriving in under 10 seconds, verified on real devices over cellular**
- [ ] Your phone's primary mail app is your own
- [ ] Offline read and queued send both working
- [ ] `packages/core` genuinely shared — not copy-pasted

---

# PHASE 3 — Private Beta

**Duration:** 3.5 months · **Goal:** five real organizations running production mail

Epic level from here.

| Epic | Detail | Weight |
|---|---|---|
| **Migration tooling** | Resumable IMAP sync from Gmail / M365 / Zoho / cPanel, with a delta pass at cutover. **The single largest epic in this phase** — no organization with five years of mail will switch without it. Do not underestimate it | XL |
| Aliases and multi-domain | Alias domains vs independent domains; address uniqueness per tenant | M |
| Distribution groups | Posting policy, moderation, nesting with cycle detection, **SRS sender rewriting** — forwarding unchanged breaks SPF/DKIM and lands the group in spam | L |
| Shared mailboxes | Delegate permissions, send-as / send-on-behalf, per-human audit attribution | M |
| Quotas and retention | Warning thresholds, `452` on full (never `552`), retention policies via partition drop | M |
| Billing | Razorpay + Stripe, plans, seat proration, GST invoicing, suspension grace periods | L |
| Admin console completion | Every §4 role, audit log views, device management | M |
| Support scaffolding | Help docs, ticket inbox, runbooks written as you go | M |

**Design partners:** Techvein first, then 4 organizations who know they are beta users, get it free, and are willing to call you. Bias toward one school and one clinic — the segments in Architecture §10 have requirements you want to discover now, not during an enterprise deal.

### ▣ PHASE 3 EXIT GATE

- [ ] 5 tenants on production mail for 30 consecutive days
- [ ] **Zero data-loss incidents.** Not "recovered" — zero
- [ ] At least 2 tenants successfully migrated from a previous provider
- [ ] Support load measured and written down (hours/week) — this number decides your hiring date
- [ ] Billing has charged a real card and issued a valid GST invoice

---

# PHASE 4 — Hardening

**Duration:** 4 months · **Goal:** earn the right to charge money with an SLA attached

This phase is mostly not coding, which is exactly why it tends to get skipped.

| Epic | Detail |
|---|---|
| **Own-IP warm-up** | If migrating off relay: 4–8 weeks of graduated volume per IP, running in parallel with relay. Do not cut over until metrics justify it |
| Egress IP tiering | Trusted / standard / probation pools, automatic demotion on complaint and bounce thresholds (Architecture §6.2) |
| Anti-spam tuning | Rspamd trained against real tenant traffic; per-tenant quarantine review |
| Commercial AV | Add a second engine alongside ClamAV |
| **Backup and restore drill** | Monthly, actually restored to a fresh host and verified. An untested backup is a hope |
| **DR drill** | Full region-loss rehearsal against the RPO ≤ 5 min / RTO ≤ 4 hr targets |
| **External penetration test** | Scope must include cross-tenant isolation and email HTML rendering. Budget for a retest |
| Observability | OpenTelemetry → Grafana, alerting on delivery latency, queue depth, blocklist status, certificate expiry |
| Runbooks | Written before the first outage, not during it |
| Status page | Email customers will ask for one on day one |
| Abuse desk | Monitored `abuse@` with a documented response SLA — ignoring it gets ranges delisted slowly and relisted fast |

### ▣ PHASE 4 EXIT GATE — the hard one

- [ ] Restore tested and verified within RTO
- [ ] Pentest findings closed and retested
- [ ] DR rehearsal completed
- [ ] Blocklist and postmaster monitoring alerting correctly
- [ ] **Operational cover in place: a second operator hired, a NOC contracted, or an explicitly limited SLA that you disclose honestly to customers**

That last item is a gate, not a preference. Taking money for business email with a 99.9% promise and one person on call is a commitment you cannot keep, and the first 3 a.m. outage during a family emergency is when everyone finds out. All three options are legitimate — including the honest limited SLA, which some customers will happily accept at the right price. Choosing none of them is not.

---

# PHASE 5 — General Availability

**Duration:** 2.5 months

| Epic | Detail |
|---|---|
| Self-serve signup | With the anti-abuse controls from Architecture §3.2 — phone OTP, no outbound until payment on file or a hard daily cap |
| Public pricing | Plans from Architecture §13; web checkout only |
| Documentation | Setup guides, registrar-specific DNS walkthroughs, migration guides |
| Marketing site | SSR'd, separate from the app |
| Onboarding automation | Registrar auto-configuration for GoDaddy, Cloudflare, BigRock, Namecheap — the largest single source of onboarding drop-off |
| SLA and legal | Terms, DPA, privacy policy, DPDP compliance statement |
| Launch | Soft launch to a waitlist before opening signups |

### ▣ PHASE 5 EXIT GATE

- [ ] Self-serve signup to working mailbox without human intervention
- [ ] Abuse controls verified by deliberate red-teaming of your own signup flow
- [ ] Support response times meeting the published SLA for 30 days

---

# PHASE 6 — Differentiation (post-GA, ongoing)

Sequenced by revenue impact, not by interest:

1. **TatvaOS ERP integration** — email-to-task, quotes and invoices from the inbox. This is the actual moat. Zoho is cheaper and more mature at plain email; being the mail client that already knows your business data is a thing they cannot easily copy for your customers
2. **Calendar and contacts** — CalDAV/CardDAV. The most-requested gap versus Workspace
3. **AI layer** — smart replies, classification, priority inbox, thread summarisation
4. **Enterprise compliance** — DLP, archiving, legal hold, SSO/SAML, SOC 2
5. **White-label / reseller** — strong GTM lever in the Indian channel, significant added complexity
6. **S/MIME, PGP** — checkbox items, near-zero real usage

---

## 8. If You Fall Behind — Cut In This Order

Ordered from cheapest to most painful. Cut from the top; never from the bottom.

| Order | Cut | Cost of cutting |
|---|---|---|
| 1 | POP3 | Almost none. IMAP covers every modern client |
| 2 | Multi-domain per tenant | Defer to post-GA. Most SMBs have one domain |
| 3 | Distribution groups | Workaround: aliases plus manual forwarding |
| 4 | Android app (ship iOS first) | iOS has the worse third-party mail story, so it is the app that must exist. Android users can use the PWA for a while |
| 5 | Shared mailboxes | Painful for the `support@` use case, survivable |
| 6 | Admin console polish | Do it via API and support requests initially |
| 7 | Migration tooling | **Expensive** — it blocks every switching customer, and switching customers are your market |
| — | **Never cut:** isolation tests, backups + restore drills, HTML sanitisation, push reliability | These are the failures you do not recover from |

---

## 9. Hiring Triggers

Solo works until specific, observable things happen. Watch for them rather than picking a date:

| Hire | Trigger | Latest acceptable |
|---|---|---|
| **Ops / support** | Support exceeds ~1 day/week (measure it in Phase 3) | **Phase 4 gate — before the first SLA customer** |
| Second engineer | You are context-switching between support and code daily and shipping nothing | Early Phase 5 |
| Deliverability contractor | Only if migrating to own IPs | Phase 4, part-time |
| Compliance consultant | First enterprise security questionnaire arrives | On demand |

The Phase 4 ops hire is the one that is genuinely load-bearing. Everything before it is a preference.

---

## 10. Standing Risks

| Risk | Phase it bites | Early warning |
|---|---|---|
| Deliverability never reaches parity | 0 and 4 | Spam placement in Sprint 0.2 — the reason that sprint exists |
| Solo burnout | 3–4 | Sprints slipping with no scope change; support crowding out build time |
| Migration tooling underestimated | 3 | First design partner cannot switch |
| Cross-tenant leak | Any | Isolation suite coverage falling behind new endpoints |
| Zoho undercuts you | 5 | Design partners citing price rather than capability |
| Scope creep into calendar/chat/AI | 2–3 | Any of these appearing in a sprint before Phase 6 |

---

## 11. The Weekly Rhythm

Solo, with no team to create structure, the calendar has to:

- **Mon–Thu:** build. Protect these — this is the only time the product moves forward
- **Fri AM:** support, tickets, customer DNS hand-holding
- **Fri PM:** ops — patching, backup verification, blocklist and postmaster check, metrics review
- **Sprint boundary:** demo to yourself against the exit criteria, honestly. Reforecast if a gate has slipped

From Phase 3 onward, support and ops expand. When Friday alone stops covering them, that is the hiring trigger in §9 arriving — treat it as data, not as a personal failure.

---

*Two gates carry more weight than everything else in this document: **Phase 0** (mail actually reaches Gmail's inbox) and **Phase 4** (someone other than you can answer the pager). The first decides whether the product is possible. The second decides whether the business is.*

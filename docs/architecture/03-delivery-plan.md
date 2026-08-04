# TatvaOS Mail — Phase-Wise Delivery Plan

**Companion to:** Architecture v0.1 · Technology Stack · Dev Environment
**Revision:** 2.0 — restructured for the manager / development-team model
**Date:** 4 August 2026

| Role | Who | Owns |
|---|---|---|
| **Engineering Manager** | Amit | Requirements, priorities, decisions, acceptance |
| **Development team** | Claude (~5 developers of throughput) | Design, implementation, tests, documentation, delivery |

---

## 0. The Working Contract

### What the development team delivers

Everything that is code, configuration, schema, test or written documentation. You do not need to read the implementation to accept it.

### What only the manager can decide

There are exactly four categories. Everything else is the team's problem.

| Category | Examples |
|---|---|
| **Product** | Which features, which segments, what ships in v1 |
| **Commercial** | Pricing, plans, which providers to pay, what the SLA promises |
| **Risk appetite** | Relay-first vs own IPs, when to accept paying customers, free tier or not |
| **External** | Anything requiring a human identity — Linode tickets, Apple enrolment, KYC, contracts, design-partner relationships |

### The honest constraint

**Five developers of throughput does not mean five times the delivery speed.** Code output stops being the bottleneck almost immediately, and three other things become the bottleneck instead.

| What genuinely compresses ~5× | What does not compress at all |
|---|---|
| Writing application code | **IP warm-up** — 4–8 weeks of graduated volume, physics of reputation |
| Schemas, migrations, API surfaces | **DNS propagation, provider tickets, KYC approvals** |
| Tests, fixtures, CI configuration | **Design-partner feedback** — real users need real weeks |
| Documentation and runbooks | **Penetration test + retest** — external, scheduled |
| Refactors and repayment of debt | **Your review and decision latency** |
| Investigation and debugging | **24×7 operations** — one pager, one person |

The consequence: **early phases compress a lot, late phases barely at all.** Phase 1 is nearly all code. Phase 4 is nearly all waiting, watching and process. A 5× team turns 19 months into roughly 12 — not into 4.

### The new bottleneck is you

With code no longer scarce, the rate-limiting step becomes **decisions and acceptance**. If a question sits for three days, the team stalls for three days regardless of capacity.

What that requires, concretely:

- **Decision turnaround inside 24 hours** on anything flagged `DECISION NEEDED`
- **Acceptance testing at each gate** — not code review; using the thing and confirming it does what you asked
- **One planning conversation per phase** to set priorities and scope

That is the whole ask. It is small, but it is not zero, and it is now on the critical path.

---

## 1. Requirements Format

The more precisely a requirement states its *outcome*, the less of your time it consumes later.

**Sufficient:**

> Organisation admins must be able to create a mailbox and have the user receive mail within a minute. Admins cannot read that user's mail.

**Not sufficient:**

> Add user management.

If a requirement is ambiguous the team will pick a sensible default, implement it, and flag the assumption in the delivery note. Reversing a flagged assumption is cheap; discovering an unflagged one at beta is not.

---

## 2. Timeline

| Phase | Solo estimate | **5× team** | Cumulative | Compression | Why |
|---|---|---|---|---|---|
| **0 — Spike** | 6 wks | **3 wks** | 3 wks | 2× | Mostly waiting on Linode, DNS and IP checks. *Local half already complete* |
| **1 — Backend + web** | 5 mo | **2 mo** | ~2.5 mo | 2.5× | Almost pure code. Compresses best of any phase |
| **2 — Core + mobile** | 3 mo | **6 wks** | ~4 mo | 2× | Code-heavy, but store review and device testing are fixed cost |
| **3 — Private beta** | 3.5 mo | **2.5 mo** | ~6.5 mo | 1.4× | Migration tooling compresses; **design-partner feedback does not** |
| **4 — Hardening** | 4 mo | **3.5 mo** | ~10 mo | 1.15× | IP warm-up, pentest, DR drills. Barely compresses at all |
| **5 — GA** | 2.5 mo | **2 mo** | **~12 mo** | 1.25× | Docs and launch compress; legal and support process do not |

**≈12 months to GA. Private beta at ~6.5 months.**

Assumptions this rests on, stated so they can be challenged:

1. Decisions returned within 24 hours
2. Scope held to §1.2 of the architecture doc — the deferral list is a commitment, not a wish list
3. Operational cover resolved before Phase 4 closes (§9)
4. Linode grants the SMTP unblock, or relay-first is accepted early rather than late

---

# PHASE 0 — Deliverability Spike

**3 weeks · Goal: prove mail from our IP reaches a Gmail inbox**

### Status

| | |
|---|---|
| ✅ Local mail platform | Postfix + Dovecot + Postgres, 26/26 tests green |
| ✅ Tenant isolation | RLS enforced and verified, 9/9 |
| ✅ Dev environment | Windows + WSL2 + Docker, fully provisioned |
| ✅ Repo, CI-ready structure, runbooks | 5 commits |
| ✅ DNS + DKIM for tatvaos.com | Records specified, 2048-bit key generated |
| ⏳ Linode SMTP unblock | **Submitted, awaiting response** |
| ⬜ Cold-IP delivery to Gmail / Outlook / Yahoo | **The actual gate** |

### Remaining work

| # | Task | Owner |
|---|---|---|
| 1 | Publish DNS records for tatvaos.com | **Manager** — registrar access |
| 2 | Set rDNS in Linode Cloud Manager | **Manager** — account access |
| 3 | Check IP against Spamhaus / MXToolbox | Team |
| 4 | Provision the Linode: Postfix, SPF/DKIM/DMARC signing | Team |
| 5 | Send to Gmail, Outlook, Yahoo — record inbox vs spam | Team |
| 6 | Send the same via SES/Postmark and compare | Team |
| 7 | mail-tester.com → 10/10 | Team |
| 8 | Register Google Postmaster Tools + Microsoft SNDS | **Manager** — identity |

### ▣ GATE

- [ ] Mail from `172.105.57.198` reaches a Gmail **inbox**, not spam
- [ ] mail-tester 10/10
- [ ] Relay comparison documented
- [ ] **DECISION NEEDED — relay-first or own IPs** (§17.1)

**This gate can fail, and failing it is a good outcome at week three.** If cold-IP delivery does not work, we learn it now for the price of a domain and a $5 server rather than after twelve months of building.

---

# PHASE 1 — Backend and Web Client

**2 months · Goal: a working multi-tenant mail platform you use as your own mail**

Delivered in two-week increments; each ends with something you can use.

| Increment | Delivered | You will be able to |
|---|---|---|
| **1.1** | Monorepo, .NET 10 API, Postgres + RLS from the first migration, isolation test suite, auth | Create an org and sign in |
| **1.2** | Users, mailboxes, roles, audit log, admin API | Provision mailboxes via the admin console |
| **1.3** | Domain onboarding, ownership verification, **DNS checker** | Add a domain and see exactly which records are wrong |
| **1.4** | Inbound mail path, delivery service, object storage, search indexing | Receive real mail into the platform |
| **1.5** | Outbound, DKIM signing, rate limits, job queue | Send real mail from the platform |
| **1.6** | Sync API (JMAP-shaped), full-text search, live updates | — foundation for both clients |
| **1.7** | Web client: message list, threads, sandboxed HTML rendering | Read your mail in a browser |
| **1.8** | Compose, attachments, search UI, responsive + PWA | Use it as your primary mail |

### Decisions needed during this phase

| When | Decision |
|---|---|
| 1.2 | Which roles ship in v1 — the full §4 table or a subset |
| 1.3 | Which registrars get auto-configuration first |
| 1.5 | Relay provider, if relay-first was chosen |
| 1.7 | Any brand direction, or a neutral default |

### ▣ GATE

- [ ] **You have closed the Gmail tab.** This is the gate; feature checklists are not
- [ ] Isolation suite green, covering every endpoint added
- [ ] Two tenants coexisting with verified separation
- [ ] A backup taken **and restored**

---

# PHASE 2 — Shared Core and Mobile Apps

**6 weeks · Goal: iOS and Android apps in testing with reliable push**

| Increment | Delivered |
|---|---|
| **2.1** | `packages/core` extracted — threading, MIME, sync reconciliation, shared by both clients |
| **2.2** | Expo app scaffold, EAS build pipeline, auth, offline SQLite store |
| **2.3** | Message list, thread view, sandboxed rendering, offline read |
| **2.4** | Push pipeline: APNs + FCM, device registry, remote wipe |
| **2.5** | Compose, attachments, offline outbox, biometric lock, cert pinning |
| **2.6** | Store listings, privacy declarations, TestFlight + Play internal |

### What the manager must do here

| When | Action | Lead time |
|---|---|---|
| **Before 2.1** | **Enrol in the Apple Developer Program** | **1–2 weeks, may need D-U-N-S** |
| Before 2.2 | Google Play Console account | Days |
| 2.6 | Approve store listing copy and screenshots | — |

**Apple enrolment gates the entire phase and cannot be compressed. Start it at the beginning of Phase 1, not Phase 2.**

### ▣ GATE

- [ ] Apps on TestFlight and Play internal track
- [ ] **Push arriving in under 10 seconds on real devices over cellular**
- [ ] Your phone's primary mail app is your own

---

# PHASE 3 — Private Beta

**2.5 months · Goal: five real organisations running production mail**

| Workstream | Notes |
|---|---|
| **Migration tooling** | Resumable IMAP sync from Gmail / M365 / Zoho. Largest single piece. Compresses well — it is pure code |
| Aliases, alias domains, multi-domain | |
| Distribution groups | Including SRS sender rewriting |
| Shared mailboxes and delegation | |
| Quotas, retention, warning thresholds | |
| Billing | Razorpay + Stripe, plans, proration, GST invoicing |
| Admin console completion | |
| Support scaffolding | Help docs, ticket flow, runbooks |

**The compression limit here is not code.** Five organisations need to actually use the product for thirty days. That is thirty days of calendar regardless of how fast it was built.

### Manager actions

| Action | Lead time |
|---|---|
| **Razorpay KYC** | **1–2 weeks** — start during Phase 2 |
| Recruit 5 design partners | Weeks. Bias to one school and one clinic — those segments have requirements worth discovering early |
| Approve pricing before billing is built | — |

### ▣ GATE

- [ ] 5 tenants on production mail for 30 consecutive days
- [ ] **Zero data-loss incidents.** Not "recovered" — zero
- [ ] At least 2 tenants migrated from a previous provider
- [ ] Support load measured in hours/week — this number sets the hiring date

---

# PHASE 4 — Hardening

**3.5 months · Goal: earn the right to charge with an SLA attached**

**This phase barely compresses, and that is worth understanding rather than resisting.** Most of it is not code.

| Workstream | Compresses? |
|---|---|
| **IP warm-up** | **No — 4–8 weeks of graduated volume. Physics of reputation** |
| Egress IP tiering, automatic demotion | Yes |
| Anti-spam tuning against real traffic | Partly — needs real traffic to tune against |
| **External penetration test + retest** | **No — external, scheduled** |
| **Backup restore drill, DR rehearsal** | **No — must run in real time to be meaningful** |
| Observability, alerting, runbooks | Yes |
| Status page, abuse desk | Yes |

### ▣ GATE — the hard one

- [ ] Restore tested and verified within RTO
- [ ] Pentest findings closed and retested
- [ ] DR rehearsal completed
- [ ] **DECISION NEEDED — operational cover: a second operator, a contracted NOC, or an explicitly limited SLA disclosed honestly**

**A five-developer team does not answer a pager.** Everything in this document assumes the software is excellent; none of it prevents a 3am outage during a family emergency. All three options are legitimate — including the honest limited SLA, which some customers will happily accept at the right price. Choosing none is not.

---

# PHASE 5 — General Availability

**2 months**

| Workstream | Notes |
|---|---|
| Self-serve signup with anti-abuse controls | Phone OTP, no outbound until payment or hard cap |
| Public pricing, web checkout | **Never in-app purchase** — see tech stack §5.5 |
| Documentation, registrar-specific DNS guides | |
| Marketing site | |
| **SLA, terms, DPA, privacy policy** | **Manager — needs legal review, allow 2–3 weeks** |
| Soft launch to a waitlist | |

### ▣ GATE

- [ ] Signup to working mailbox with no human intervention
- [ ] Abuse controls verified by deliberately attacking your own signup flow
- [ ] Support response times meeting the published SLA for 30 days

---

# PHASE 6 — Differentiation

Ongoing, sequenced by revenue impact rather than interest:

1. **TatvaOS ERP integration** — the actual moat. Zoho is cheaper and more mature at plain email; being the mail client that already knows the customer's business data is what they cannot easily copy
2. Calendar and contacts (CalDAV/CardDAV) — the most-requested gap versus Workspace
3. AI layer — smart replies, classification, priority inbox
4. Enterprise compliance — DLP, archiving, legal hold, SSO, SOC 2
5. White-label / reseller
6. S/MIME, PGP

---

## 8. If We Fall Behind — Cut In This Order

| Order | Cut | Cost |
|---|---|---|
| 1 | POP3 | Almost none |
| 2 | Multi-domain per tenant | Most SMBs have one domain |
| 3 | Distribution groups | Aliases plus manual forwarding |
| 4 | Android app (ship iOS first) | iOS has the worse third-party mail story, so it must exist. Android users get the PWA |
| 5 | Shared mailboxes | Painful for `support@`, survivable |
| 6 | Admin console polish | API plus support requests initially |
| 7 | Migration tooling | **Expensive — blocks every switching customer, and switchers are the market** |
| — | **Never cut:** isolation tests, backups + restore drills, HTML sanitisation, push reliability | The failures you do not recover from |

---

## 9. Hiring — What a Development Team Cannot Replace

| Role | Trigger | Latest acceptable |
|---|---|---|
| **Ops / support** | Support exceeds ~1 day/week — measured in Phase 3 | **Phase 4 gate. Before the first SLA customer** |
| Deliverability contractor | Only if migrating to own IPs | Phase 4, part-time |
| Compliance consultant | First enterprise security questionnaire | On demand |

Note what is absent: a second *developer*. That is the one role this model genuinely covers.

---

## 10. Risks

| Risk | Phase | Early warning |
|---|---|---|
| Deliverability never reaches parity | 0 and 4 | Spam placement in the Phase 0 gate — the reason that gate exists |
| **Decision latency stalls the team** | All | Any `DECISION NEEDED` item older than 48 hours |
| Scope expands because capacity feels free | 1–3 | Anything from the §1.2 deferral list appearing in a sprint |
| Migration tooling underestimated | 3 | First design partner cannot switch |
| Cross-tenant leak | Any | Isolation suite coverage falling behind new endpoints |
| Ops burden with no operator | 4–5 | Arrives on schedule and is not solved by code |
| Zoho undercuts on price | 5 | Design partners citing price rather than capability |

**The second row is new, and it is now the most likely cause of slippage.** When code is no longer scarce, the queue forms in front of decisions.

---

## 11. Cadence

| Rhythm | What happens |
|---|---|
| **Per increment (~2 weeks)** | Team delivers; manager accepts by using it |
| **Per phase** | One planning conversation to set scope and priorities |
| **As raised** | `DECISION NEEDED` items — target under 24 hours |
| **Continuous** | Team implements, tests, documents, and flags assumptions |

Delivery notes state what was built, what was assumed, what was deliberately left out, and what needs a decision. Reading one should take two minutes and should never require opening the code.

---

*Two gates decide the outcome and neither is a coding problem: **Phase 0** — does mail reach a Gmail inbox, and **Phase 4** — can someone other than you answer the pager. The first determines whether the product is possible. The second determines whether the business is.*

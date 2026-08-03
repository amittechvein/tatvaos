# TatvaOS Mail — Multi-Tenant Email Platform Architecture

**Version:** 0.1 (working draft)
**Owner:** Amit / Techvein
**Date:** 2 August 2026
**Status:** Internal design notes — not yet reviewed

---

## 0. Executive Summary

TatvaOS Mail is a multi-tenant, business-email hosting platform: one shared infrastructure serving many independent organizations, each on its own domain(s), with hard data isolation between them. Positioning is the Zoho Mail / Google Workspace / Microsoft 365 category, targeted initially at Indian SMBs, schools, hospitals and other price-sensitive segments where per-seat Workspace pricing is a real barrier.

**Core model:**

```
One TatvaOS platform
  → Multiple organizations (tenants)
    → Each with one or more verified domains
      → Unlimited mailboxes per domain
        → Completely isolated from every other tenant
```

**The three things that actually decide whether this succeeds** (expanded in §12 and §16):

1. **Deliverability.** Building the software is the easy half. Getting mail from a new IP range accepted by Gmail, Outlook and Yahoo — and keeping it accepted while hosting tenants you do not control — is the hard half.
2. **Isolation that is enforced, not conventioned.** A `TenantId` column is a naming convention. Row-Level Security, a tenant-scoped connection, and tests that prove cross-tenant reads fail are enforcement.
3. **Operational maturity.** Email is a 24×7, zero-data-loss, users-notice-in-90-seconds service. The SLA burden is closer to a bank than to a CRM.

---

## 1. Scope

### 1.1 In scope (v1)

- Multi-tenant mailbox hosting with custom domains
- Inbound and outbound SMTP, IMAP, POP3
- Web client (Next.js) for end users
- Organization admin console
- TatvaOS super-admin console
- Domain verification and DNS guidance
- Anti-spam, anti-virus, basic DLP
- Aliases, distribution groups, shared mailboxes
- Quotas, subscription plans, metering

### 1.2 Explicitly deferred

| Deferred | Rationale |
|---|---|
| JMAP *as a public protocol* | Almost no client support; IMAP is the compatibility floor. **But** your own web and mobile apps need a delta-sync API regardless — so shape that API on JMAP's object model and `changes`/`get` semantics from day one. Exposing real JMAP later then becomes an adapter rather than a rewrite. Cost now: near zero. |
| Calendar / contacts / chat / meetings | Each is a product in its own right. CalDAV/CardDAV in v2 at the earliest. |
| S/MIME, PGP | Enterprise checkbox item; near-zero real usage in target segment. |
| Multi-region active-active | Single region + DR is the correct v1 posture. Active-active mail is genuinely hard. |
| White-label / reseller | Powerful GTM lever, but it multiplies the DNS, branding and billing surface. v2. |
| AI drafting / classification | High demand, but it must sit on a working mail platform. Post-GA. |

### 1.3 Non-goals

- Not a transactional/bulk email API (that is SendGrid/SES territory and has an opposite reputation profile — do **not** mix it with business mail on the same IPs).
- Not a mailing-list manager.
- Not an on-premise product in v1.

---

## 2. Tenancy Model

### 2.1 Hierarchy

```
TatvaOS Platform
    │
    └── Organization (Tenant)          ← billing + isolation boundary
            │
            ├── Domain (1..n, verified)
            │
            ├── User (identity, auth)
            │       │
            │       └── Mailbox (1 primary + n shared/delegated)
            │               │
            │               ├── Folder
            │               │      └── Message
            │               │             └── Attachment (blob ref)
            │               ├── Alias
            │               └── Label / Filter Rule
            │
            ├── Group (distribution list)
            ├── Policy (retention, quota, security)
            └── AuditLog
```

**Key correction to the original draft:** the draft treats `User` and `Mailbox` as effectively the same row. Separate them. A user is an *identity that authenticates*; a mailbox is a *store that receives mail*. Shared mailboxes, delegated access, and departing-employee mailbox retention all require a mailbox to exist without a user, and a user to reach mailboxes beyond their own.

### 2.2 Isolation strategy

Three options, in ascending order of isolation and cost:

| Model | Isolation | Cost/tenant | Noisy-neighbour risk | Verdict |
|---|---|---|---|---|
| Shared schema, `tenant_id` column | Logical | Lowest | High | **Chosen for v1** |
| Schema-per-tenant | Strong logical | Medium | Medium | Migration pain at 1000+ tenants |
| Database-per-tenant | Physical | Highest | None | Reserve for enterprise/regulated tier |

**Decision: shared schema + PostgreSQL Row-Level Security, with a documented promotion path to database-per-tenant for enterprise customers.** Sell that promotion as a premium "Dedicated" tier rather than treating it as an architectural failure.

### 2.3 Enforcing isolation (the part the draft skips)

Putting `TenantId` on every table is necessary but nowhere near sufficient. One forgotten `WHERE` clause is a cross-tenant data breach. Enforce at four layers:

**Layer 1 — Database (primary control).** PostgreSQL RLS on every tenant-scoped table:

```sql
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;   -- applies to table owner too

CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

The application connects as a role that is **not** the table owner, **not** superuser, and does **not** have `BYPASSRLS`. Note the asymmetry: `FORCE ROW LEVEL SECURITY` makes policies apply to the table owner, but superusers and `BYPASSRLS` roles skip policies regardless — so the application role must be neither. Every request sets `app.tenant_id` at the start of the transaction (use `SET LOCAL` so it cannot leak across pooled connections).

**Layer 2 — Data access.** A `TenantContext` resolved once from the authenticated principal, injected into the EF Core `DbContext`, applied as a global query filter, and used to open the connection with the correct `SET LOCAL app.tenant_id`. No code path may construct a `DbContext` without it.

**Layer 3 — Object storage.** Blob keys are tenant-prefixed and non-guessable: `s3://tatvaos-mail/{tenant_id}/{yyyy}/{mm}/{message_id}/{sha256}`. Access is only ever via short-lived presigned URLs generated after an authorization check — never via a bucket path derived from user input.

**Layer 4 — Search.** OpenSearch index-per-tenant for large tenants; shared index with a mandatory `tenant_id` filter injected server-side for small ones. Never accept a raw query string that could carry its own filter clause.

**Test it.** A CI suite that authenticates as tenant A and asserts a 404/empty result for every tenant B resource — mailbox, message, attachment, search hit, presigned URL, admin endpoint. This suite is the isolation guarantee; the RLS policy is just its implementation.

---

## 3. Organization Onboarding

### 3.1 Flow

```
Sign up → Add domain → Verify DNS → Create mailboxes → Cut over MX
   │           │            │              │                │
 ~2 min     ~1 min    ~15 min–48 hr     ~10 min        planned window
```

Total realistic time to a working mailbox: **same day**, gated almost entirely by DNS propagation and the customer's ability to access their registrar.

### 3.2 Step 1 — Sign-up

| Field | Required | Notes |
|---|---|---|
| Organization name | Yes | |
| Country / region | Yes | Drives data residency and tax |
| Address | Yes | Required for GST invoicing |
| Phone | Yes | Verified via OTP — anti-abuse signal |
| Admin name | Yes | |
| Admin email | Yes | Must be a *working, external* address — cannot be on the domain being onboarded |
| GSTIN | Optional | India; validate checksum format |

**Anti-abuse from day one.** Spammers will sign up on day one; they always do. Free-trial tenants get: no outbound sending until a payment method is on file, or a hard cap (e.g. 50 messages/day) plus rate limits. This is the single cheapest protection for your IP reputation.

### 3.3 Step 2 — Add domain

Validate the domain is a registrable public-suffix domain, is not already claimed by another tenant, and is not on a blocklist of disposable/parked domains.

### 3.4 Step 3 — Verify

Verification is a two-phase process, and the draft collapses them:

**Phase A — Ownership (must pass before mailboxes can be created):**

```
TXT  @  tatvaos-verification=<random-32-char-token>
```

Poll with backoff; expire the token after 14 days.

**Phase B — Mail routing (must pass before the domain goes live):**

| Record | Host | Value | Notes |
|---|---|---|---|
| MX (10) | `@` | `mx1.tatvaos.mail` | Primary |
| MX (20) | `@` | `mx2.tatvaos.mail` | Secondary, different AZ |
| TXT (SPF) | `@` | `v=spf1 include:_spf.tatvaos.mail ~all` | Warn loudly if an SPF record already exists — **two SPF records is a hard fail**, they must be merged |
| TXT (DKIM) | `tatvaos._domainkey` | `v=DKIM1; k=rsa; p=…` | 2048-bit. Generate a unique key **per domain**, not per platform |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=none; rua=mailto:…` | Start at `p=none`, guide to `quarantine` then `reject` over ~30 days |
| CNAME | `autodiscover` | `autodiscover.tatvaos.mail` | Outlook |
| SRV | `_autodiscover._tcp` | `0 0 443 autodiscover.tatvaos.mail` | Outlook fallback |
| TXT | `_mta-sts` | `v=STSv1; id=…` | Optional, meaningful trust signal |
| CNAME | `mail` | `mail.tatvaos.mail` | Vanity webmail URL |

Ship a **DNS checker** that reports each record as pass / fail / *misconfigured-but-present*, with the exact current value alongside the expected one. Most support tickets in this business are DNS tickets; every one you deflect with a good diff view is margin.

**Registrar shortcuts.** Auto-configuration for GoDaddy, Cloudflare, BigRock, Namecheap, Route 53 removes the largest single source of onboarding drop-off. Worth building by v1.5.

### 3.5 Step 4 — Create mailboxes

Three paths, all needed: single create, CSV bulk import, and **migration from an existing provider** (IMAP sync from Gmail / M365 / Zoho / cPanel). Migration is not a nice-to-have — an organization with five years of mail will not switch without it. Budget real effort here: incremental IMAP sync, resumable, with a delta pass at cutover.

---

## 4. Roles and Permissions

| Role | Scope | Can |
|---|---|---|
| **Super Admin** (TatvaOS) | Platform | All tenants, plans, infra, global policy |
| **Support Engineer** (TatvaOS) | Platform, restricted | Tenant metadata + delivery logs. **Cannot read message bodies** without a break-glass, tenant-notified, time-boxed grant |
| **Organization Owner** | One tenant | Everything in tenant, incl. billing and ownership transfer |
| **Organization Admin** | One tenant | Users, domains, groups, policies — not billing |
| **IT Admin** | One tenant | DNS, routing, security settings — not user data |
| **Manager** | Group subset | Manage own group membership |
| **Employee** | Own mailbox | Personal mail |
| **Delegate** | Named mailbox(es) | Read/send-as on assigned shared mailboxes |
| **Auditor** | One tenant, read-only | Audit logs and reports only |

**Two additions to the draft's table.** *Support Engineer* is missing but will exist in practice — define it deliberately so support staff are not handed super-admin. *Delegate* is missing and is the role that makes shared mailboxes work.

**Principle:** administrative power over an account never implies read access to its mail. An Org Admin can reset a user's password but should not silently read their inbox; if the product allows mailbox access delegation, it must be explicit, logged, and (ideally) visible to the mailbox owner. This is both an ethical and a legal position, and in several jurisdictions the second one matters.

---

## 5. Domains, Aliases, Groups, Shared Mailboxes

### 5.1 Multiple domains per tenant

```
Techvein (tenant)
  ├── techvein.com     (primary)
  ├── techvein.in      (alias domain — mirrors every mailbox)
  ├── tatvaos.ai       (independent — own mailboxes)
  └── schoolos.in      (independent)
```

Distinguish **alias domains** (every address is mirrored automatically) from **independent domains** (mailboxes created individually). The draft treats all extra domains as independent; alias domains are the more common real request (`.com` + `.in`).

### 5.2 Aliases

```
amit@techvein.com  ←  ceo@ , director@ , amit.d@
```

Rules: an alias resolves to exactly one mailbox; an address string is unique per tenant across mailboxes, aliases and groups; `send-as` for an alias requires explicit permission; catch-all is **off by default** (catch-all is a spam magnet and a backscatter risk).

### 5.3 Distribution groups

```
sales@company.com → Amit, Rohit, Pooja, Neha
```

Needs, at minimum: internal-only vs external-allowed posting, optional moderation, `Reply-To` behaviour, nested groups (with cycle detection), and — critically — **sender rewriting**. Forwarding a message unchanged breaks SPF and DKIM alignment and gets the group's mail sent to spam. Implement SRS (Sender Rewriting Scheme) or the equivalent for any address that re-sends externally-originated mail.

### 5.4 Shared mailboxes

A mailbox with no login of its own, accessed by named delegates with `read` / `send-as` / `send-on-behalf` permissions. Every action attributed to the human, not the mailbox, in the audit log.

---

## 6. Mail Flow

### 6.1 Inbound

```
Internet
   │
   ▼  MX lookup → mx1/mx2.tatvaos.mail
┌──────────────────────────────────────────┐
│ Edge MTA (Postfix / Haraka)              │
│  • Connection-level: RBL, rate limit,    │
│    greylist, TLS                         │
│  • RCPT TO validation ─── reject unknown │
│    recipients at SMTP time (never accept │
│    then bounce — that is backscatter)    │
└───────────────┬──────────────────────────┘
                ▼
        Tenant resolution
        (recipient domain → tenant_id)
                ▼
        SPF / DKIM / DMARC evaluation
                ▼
        Anti-virus (ClamAV + commercial)
                ▼
        Anti-spam (Rspamd + reputation)
                ▼
        Tenant + user filter rules
                ▼
        ┌───────┴────────┐
        ▼                ▼
   Quarantine        Deliver
                         ▼
                 Store: metadata → PostgreSQL
                        body/attachments → object storage
                        index → OpenSearch
                         ▼
                 Push notification (IMAP IDLE / WebSocket)
```

**Reject, don't bounce.** Unknown recipients must be rejected during the SMTP transaction (`550 5.1.1`). Accepting and then generating a bounce makes you a backscatter source and will get your IPs blocklisted.

### 6.2 Outbound

The original draft has no outbound path. It is the higher-risk direction.

```
Web client / SMTP submission (587, STARTTLS, authenticated)
        ▼
  Per-user + per-tenant rate limit  ← abuse control
        ▼
  Outbound DLP / content policy
        ▼
  DKIM sign (tenant's domain key)
        ▼
  Queue (RabbitMQ) → sending pool
        ▼
  Egress IP selection by tenant reputation tier
        ▼
  Remote MTA  →  bounce / deferral / complaint handling
        ▼
  Feedback loops (Google Postmaster, Microsoft SNDS, Yahoo CFL)
```

**Egress IP tiering** is the mechanism that stops one bad tenant from poisoning everyone:

| Pool | Who | Effect |
|---|---|---|
| Trusted | Established, clean-history tenants | Best reputation, highest throughput |
| Standard | Default | Normal |
| Probation | New tenants, or those with elevated complaint rates | Isolated IPs, throttled |
| Dedicated IP | Paid add-on | Tenant owns its own reputation entirely |

Automatic demotion on complaint-rate or bounce-rate thresholds, with alerting. This is a v1 requirement, not a v2 refinement.

---

## 7. Data Model

Illustrative, not exhaustive. Every tenant-scoped table carries `tenant_id uuid NOT NULL` and has an RLS policy.

```sql
tenants
  id, name, status, plan_id, region, created_at, suspended_at, metadata

domains
  id, tenant_id, fqdn (unique globally), type (primary|alias|independent),
  ownership_verified_at, mx_verified_at, dkim_selector, dkim_private_key_ref,
  dmarc_policy, status

users
  id, tenant_id, primary_address, display_name, password_hash (argon2id),
  mfa_secret_ref, status, last_login_at, role

mailboxes
  id, tenant_id, address, type (user|shared|group), owner_user_id NULL,
  quota_bytes, used_bytes, status

mailbox_permissions
  mailbox_id, user_id, permission (read|send_as|send_on_behalf|full)

aliases
  id, tenant_id, address (unique per tenant), target_mailbox_id

groups / group_members
  id, tenant_id, address, posting_policy, moderation_mode …

folders
  id, tenant_id, mailbox_id, parent_id, name, special_use (\Inbox \Sent \Junk …)

messages
  id, tenant_id, mailbox_id, folder_id, message_id_header, thread_id,
  from_addr, to_addrs, subject, sent_at, received_at, size_bytes,
  flags (bitmask), blob_key, headers_jsonb, spam_score, auth_results

attachments
  id, tenant_id, message_id, filename, content_type, size_bytes,
  blob_key, sha256, scan_status

labels / message_labels
filter_rules

devices                          ← required by the mobile push pipeline
  id, tenant_id, user_id, platform (ios|android|web), push_token,
  app_version, os_version, created_at, last_seen_at, revoked_at

audit_logs
  id, tenant_id, actor_user_id, actor_ip, action, target_type,
  target_id, before_jsonb, after_jsonb, occurred_at
```

### 7.1 Notes that matter more than the schema

- **Message bodies do not belong in PostgreSQL.** Store MIME in object storage; keep metadata and headers in the database. A 10 GB mailbox is thousands of rows, not gigabytes of TOAST.
- **Attachment deduplication by SHA-256 is a large win** — a 5 MB deck sent to 40 colleagues should be stored once. Deduplicate *within a tenant only*; cross-tenant dedup is a data-leak and a side-channel.
- **Partition `messages` by `tenant_id` (hash) and `received_at` (range).** Retention deletion becomes a partition drop instead of a multi-hour `DELETE`.
- **`used_bytes` must be maintained incrementally**, not computed with `SUM()`. It is read on every delivery.
- **IMAP requires `UIDVALIDITY` and monotonic `UID` per folder.** Retro-fitting this is painful; design it in now.
- **Immutable audit logs** — append-only table or WORM storage. An audit log an admin can edit is not an audit log.

---

## 8. Storage and Quotas

| Level | Control |
|---|---|
| Plan | Total pooled storage per tenant |
| Mailbox | Per-mailbox quota, admin-adjustable within the pool |
| Message | Max message size (default 25 MB, matches Gmail; configurable to 50 MB) |
| Attachment | Max per-attachment size; blocked extension list |
| Retention | Per-folder policy; legal hold overrides deletion |

Storage tiering: hot (< 90 days) on standard object storage, cold (older) on infrequent-access. Transparent to the user, materially cheaper at scale.

**Quota-exceeded behaviour must be specified now:** reject inbound with `452 4.2.2` (temporary, sender retries) rather than `552` (permanent, mail lost), warn the user at 80/90/95%, and block outbound before blocking inbound.

---

## 9. Security

| Area | Position |
|---|---|
| Password hashing | Argon2id. Never MD5/SHA/bcrypt-with-low-cost |
| MFA | TOTP mandatory for all admin roles; optional-but-encouraged for users; WebAuthn in v2 |
| App passwords | Required for IMAP/POP clients that cannot do OAuth — scoped, revocable, listed |
| Transport | TLS 1.2+ everywhere. MTA-STS and DANE where possible. Opportunistic TLS on port 25 |
| At rest | Envelope encryption; per-tenant data key wrapped by a KMS master key. Enables cryptographic erasure on tenant deletion |
| DKIM keys | Per-domain, stored in a secrets manager, rotatable with dual-selector overlap |
| Admin access | Super-admin actions require MFA + are logged + alert the tenant where they touch tenant data |
| Session | Short-lived JWT access token + rotating refresh token; server-side revocation list |
| Rate limits | Per IP, per user, per tenant — on auth, submission, and API |

**Threat model — top risks, in order:**

1. **Cross-tenant data access** via a missing filter → RLS + isolation test suite (§2.3)
2. **Tenant account takeover** → MFA, anomalous-login detection, alert on forwarding-rule creation (the classic BEC persistence step)
3. **Platform used for spam** → onboarding friction, rate limits, outbound content scanning, IP tiering
4. **Insider access to customer mail** → break-glass workflow, no standing production data access, tenant notification
5. **Attachment-borne malware** → multi-engine scanning, detonation for high-risk types, extension blocking

---

## 10. Compliance

Depends heavily on target segments. Note where each bites:

- **India DPDP Act 2023** — consent, breach notification, data-principal rights. Data residency in India is the pragmatic default for the target market.
- **Schools** — if minors' data is involved, tighter handling and parental-consent considerations. `abcschool.edu.in` in the example is not a hypothetical detail.
- **Hospitals** — patient data over email is a real practice and a real liability. Encryption at rest, retention, and audit logging are table stakes; an explicit "we are not a HIPAA/DISHA-certified processor" statement may be needed until certification exists.
- **SOC 2 Type II** — expect it to be requested by any customer above ~200 seats. It takes 6–12 months of evidence collection; start the controls early even if the audit is later.

---

## 11. Technology Stack

Mostly agreeing with the draft, with the substantive changes marked.

| Layer | Choice | Note |
|---|---|---|
| Clients | Next.js (web + mobile web + PWA) · Expo/React Native (iOS + Android) | **Three targets, two codebases** — mobile web is the same responsive Next.js app, not a separate build |
| Backend API | **ASP.NET Core on .NET 10 LTS** | **Not .NET 9 — it reaches end of support on 10 Nov 2026.** .NET 10 is supported to Nov 2028 |
| Database | PostgreSQL 16+ | RLS is the reason this choice is right |
| Cache / sessions | Redis | |
| Search | OpenSearch | Index-per-tenant above a size threshold |
| Queue | RabbitMQ | |
| Object storage | S3-compatible (MinIO self-hosted, or S3) | |
| **Inbound MTA** | **Postfix, or Haraka if you want it in-process** | **Do not write an MTA. This is the single most important line in this document.** |
| **Anti-spam** | **Rspamd** | Mature, fast, actively maintained |
| Anti-virus | ClamAV + a commercial engine | ClamAV alone is not sufficient |
| **IMAP/POP** | **Dovecot** | Same reasoning as MTA — the protocol edge cases are endless |
| Auth | OAuth2 / OIDC, JWT | |
| Orchestration | Kubernetes | Except the MTA/IMAP tier, where static IPs and stable identity favour dedicated hosts |
| Ingress | Nginx or Traefik | HTTP only; SMTP/IMAP need L4 |

**On Postfix + Dovecot vs. writing it in C#:** a hand-rolled MTA will pass your tests and fail against the real internet — malformed MIME, 8BITMIME, pipelining, BDAT, weird TLS stacks, twenty years of interoperability bugs. Postfix and Dovecot have absorbed that. The differentiated product is the web client, the admin console, the AI layer and the ERP integration — not the SMTP state machine. Custom logic goes in Postfix milters / Dovecot plugins that call your API.

**On JMAP:** correct protocol, wrong decade — ship IMAP for third-party clients. But see §1.2: your own clients speak a delta-sync REST API, and shaping that API on JMAP's semantics costs nothing now and saves a rewrite later.

**See the companion document `TatvaOS-Mail-Tech-Stack.md`** for the full frontend/mobile stack, the monorepo layout, rejected alternatives, and a revised v1 infrastructure list that cuts OpenSearch, RabbitMQ, self-hosted MinIO and Kubernetes for a two-person team.

---

## 12. Deliverability

Treated separately because it is the most underestimated part of this build.

| Item | Requirement |
|---|---|
| IP warm-up | 4–8 weeks of gradually increasing volume per IP before full production traffic |
| PTR / rDNS | Every sending IP must have a matching forward+reverse record. Non-negotiable |
| IP acquisition | Clean ranges with no blocklist history — verify **before** purchase |
| Postmaster tools | Google Postmaster, Microsoft SNDS/JMRP, Yahoo CFL registered from day one |
| Blocklist monitoring | Spamhaus, Barracuda, SORBS, SpamCop — automated, alerting |
| Complaint rate | Keep below 0.1%. Above 0.3% and Gmail begins throttling |
| Bounce handling | Suppression list, automatic disabling of hard-bouncing recipients |
| Abuse desk | A monitored `abuse@` mailbox with a documented response SLA. Ignoring it gets ranges delisted slowly and relisted fast |

**Realistic assessment:** deliverability is the reason most self-hosted mail ventures fail, and it is a months-long operational effort, not a configuration step. Two mitigations worth considering seriously:

- **Relay outbound through an established provider** (SES, Postmark, SparkPost) for the first 6–12 months, on your own domains and DKIM keys. You give up margin and some control, you gain immediate deliverability and a working business while you warm your own IPs in parallel.
- **Sell dedicated IPs as a premium tier** early — it moves reputation risk to the tenants generating it.

---

## 13. Billing and Metering

Meter: active mailboxes (peak in period), storage consumed, outbound volume, AI credits, dedicated IPs, retention tier.

| Plan | Seats | Storage/user | Notes |
|---|---|---|---|
| Starter | 1–10 | 5 GB | Single domain, no dedicated IP |
| Business | 11–100 | 30 GB | Multi-domain, groups, shared mailboxes |
| Enterprise | 100+ | 100 GB+ | DLP, archiving, legal hold, dedicated IP option, SSO |
| Dedicated | Custom | Custom | Isolated database, custom region |

Billing edge cases to decide before writing the code: mid-cycle seat changes (proration), suspension vs deletion grace period (recommend 30 days read-only, then 60 days archived, then purge), storage overage (block new mail vs auto-charge), annual prepay discount, GST handling and invoice numbering, and reseller margin if white-label ships.

---

## 14. Non-Functional Requirements

| Attribute | Target |
|---|---|
| Availability | 99.9% v1 (≈ 43 min/month), 99.95% at GA |
| Inbound delivery latency | p95 < 30 s from remote MTA accept to inbox |
| Web client load | p95 < 1.5 s first meaningful paint |
| Search latency | p95 < 500 ms over a 50 GB mailbox |
| Durability | Zero accepted-message loss. Once you return `250 OK`, that message is yours forever |
| RPO | ≤ 5 minutes |
| RTO | ≤ 4 hours |
| Backups | Continuous WAL archiving + daily snapshots; object storage cross-region replication; **restore tested monthly** |
| Scale target | 10k tenants / 500k mailboxes / 50M messages per day at 3 years |

Durability deserves emphasis. Every other SaaS failure mode is recoverable; losing a customer's mail is not, and it is the one failure that ends the business.

---

## 15. Delivery Phases

> **Superseded.** This table assumed a small team. The authoritative plan is now **`TatvaOS-Mail-Delivery-Plan.md`**, which is built for a solo engineer plus Claude and carries sprint-level detail for phases 0–2, exit gates for every phase, cut-order, and hiring triggers.

| Phase | Duration | Outcome |
|---|---|---|
| **0 — Spike** | 6 wks | Postfix + Dovecot + PostgreSQL sending and receiving on one domain. Prove the edge before designing around it |
| **1 — Backend + web** | 5 mo | Multi-tenancy + RLS, onboarding, DNS verification, web client, admin console. **Dogfood starts here** |
| **2 — Core extract + mobile** | 3 mo | `packages/core` extracted, Expo apps on both platforms, push pipeline |
| **3 — Private beta** | 3.5 mo | Migration tooling, aliases, groups, shared mailboxes, quotas, billing. 5 design-partner tenants |
| **4 — Hardening** | 4 mo | Deliverability, pentest, DR drill, observability, runbooks. **Hard gate: operational cover** |
| **5 — GA** | 2.5 mo | Self-serve signup, pricing, docs, SLA, launch |
| **6 — Differentiation** | ongoing | ERP integration, calendar/contacts, AI layer, enterprise compliance |

**Roughly 19–20 months to a credible GA solo**, with a private beta at 13 months. A small team compresses this to 12–16. Anyone promising 3 months has not priced in deliverability or migration tooling.

Dogfood from Phase 1, not later. If your own mail does not run on it, it is not ready to sell.

---

## 16. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Deliverability never reaches parity | **Existential** | Relay-first strategy (§12); dedicated IP tier; hire or contract deliverability expertise |
| Cross-tenant data leak | **Existential** — one incident ends the brand | RLS + FORCE + isolation test suite + external pentest before GA |
| Data loss | **Existential** | Durability-first design, tested restores, no `250 OK` before durable write |
| Spam abuse by tenants | High | Onboarding friction, rate limits, IP tiering, monitored abuse desk |
| Underestimating migration tooling | High — blocks all switching customers | Treat IMAP migration as a first-class Phase 2 feature |
| Competing on price against Zoho | High | Zoho is very cheap and very good in this exact market. Differentiate on ERP integration and local support, not on price alone |
| Ops burden of 24×7 mail | Medium-High | On-call rotation and runbooks before GA, not after the first outage |
| Scope creep (calendar, chat, meetings, AI) | Medium | The deferral table in §1.2 is a commitment, not a wish list |

---

## 17. Open Decisions

1. **Own IPs vs. relay-first for outbound?** Largest single fork in the plan; decide before Phase 1 ends.
2. **Postfix + Dovecot (recommended) or a .NET mail stack?** Decide in Phase 0 based on the spike.
3. **Data residency** — India-only for v1, or multi-region from the start?
4. **Free tier?** It drives adoption and it attracts spammers. If yes, it must be credit-card-verified.
5. **Reseller/white-label timing** — strong GTM lever for the Indian channel, significant added complexity.
6. **Support model** — email-only, or phone support (which the target segment often expects and which changes the cost structure entirely)?
7. **Where does TatvaOS ERP integration sit** — v1 differentiator or v2 expansion?

---

## Appendix A — Terminology

| Term | Meaning |
|---|---|
| Tenant | An organization; the isolation and billing boundary |
| MTA | Mail Transfer Agent — moves mail between servers (SMTP) |
| MDA | Mail Delivery Agent — writes mail into a mailbox |
| MUA | Mail User Agent — the client |
| SPF | DNS record listing which servers may send for a domain |
| DKIM | Cryptographic signature proving a message came from the domain |
| DMARC | Policy telling receivers what to do when SPF/DKIM fail |
| MTA-STS | Enforces TLS for inbound mail to a domain |
| SRS | Sender Rewriting Scheme — preserves SPF validity when forwarding |
| Backscatter | Bounces sent to forged senders; a fast route to a blocklist |
| Warm-up | Gradually raising send volume on new IPs to build reputation |

---

*Working draft. Sections 12 (deliverability), 2.3 (isolation enforcement) and 17 (open decisions) are where the highest-value thinking still needs to happen.*

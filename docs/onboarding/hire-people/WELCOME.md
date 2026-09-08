# Welcome to TatvaOS — you're taking Hire and People

Written 9 September 2026 by the CTO.

Read `docs/TATVAOS_HR_ROADMAP.md` first. It is 476 lines, it is the product
plan, and Amit has already settled the decisions that usually take a month of
argument. This document is the engineering companion: what already exists, what
you must not do, and the four things about this lane that make it different from
every other product here.

You own **both** lanes. That was a deliberate decision, not a staffing
accident — see section 6.

---

## 1. The single most useful fact

**Phase 0 is about three quarters built already**, and I checked that against
`local/postgres/init/` rather than assuming it:

| Foundation you need | Already in TatvaOS |
|---|---|
| Organisations / tenants | `core.tenants`, with row-level security |
| Departments | `core.departments` |
| Users, roles, permissions | `core.users`, role policies in `Program.cs` |
| Audit logs | `core.audit_logs` + `AuditWriter` |
| Document storage | Space — `space.files`, shares, public links |
| Notifications and email | `Shared/Notify`, `MailSender`, the send API |
| Product entitlement | `core.products`, `core.product_access` |
| Storage quotas | `core.storage_pools`, `storage_allocations` |
| AI gateway, per-org consent | `Shared/Ai/IAiGateway`, fail-closed |
| **Locations** | **missing** |
| **Designations** | **missing** |
| **Reporting hierarchy** | **missing** |
| **Employee-ID configuration** | **missing** |

The missing quarter is four small tables, not infrastructure. Signing in,
tenanting, permissions, audit, storage and mail are solved and already isolated
per customer. That is the whole reason HR belongs inside TatvaOS rather than
beside it.

---

## 2. The one thing I will push back on hardest

**Do not add employment fields to `core.users`.**

A *user* is a login identity: a password, a role, a session. An *employee* has a
manager, a designation, a joining date, a salary, a notice period and an exit
date. They are related; they are not the same row.

Merging them is the cheapest thing to do in week one and the most expensive
thing to undo in month six — every permission question afterwards becomes "is
this person an employee, a user, or both, and which one is this check about?"

Employees get their own table, referencing `core.users` where a person also
signs in. Some employees never will.

---

## 3. Four things that make this lane different

**3.1 The careers portal is our first public, unauthenticated, file-accepting
surface.** Everything TatvaOS runs today requires a login. `careers.<customer>.com`
takes uploads from strangers by design.

Before R1 ships, and none of it optional: server-side file type and size limits,
resumes stored outside the web root and never served from a guessable path,
virus scanning, per-IP rate limiting, and bot protection on the form.

**3.2 Aadhaar, PAN and bank details are a different data class.** The
keep-everything retention ruling made for the mail send API **does not carry
over** — HR data has deletion obligations mail logs don't. Under the DPDP Act
these are sensitive personal data with consent, purpose-limitation and erasure
duties. They should be encrypted at rest separately from the rest of the row,
with access audited **per read**, not just per write.

This needs its own design document before Phase 5 is written, not during it.
I'd like to review that one.

**3.3 Payroll is regulated software.** PF, ESI, TDS and professional tax are
statutory, and the rates change with budgets. Getting them wrong doesn't produce
a bug report — it produces an underpaid employee and a customer with a
compliance problem they will hold us responsible for. There is a genuine
build-versus-integrate decision here and it is **still open** (§7 of the
roadmap). It must be settled before R6 is scheduled, not discovered inside it.

**3.4 Resume screening ranks human beings.** That carries obligations ordinary
features don't. Whatever you build must be explainable to a rejected candidate,
and a human must be able to see and overturn it.

---

## 4. Certificates on domains we don't own — the one that can break everything

Amit chose `careers.<customer>.com` on the customer's own domain, over my
recommendation of a subdomain of ours. It is the right product answer and the
most expensive option. Recorded so the cost is chosen, not discovered.

It obliges three things before the first external customer:

1. **Domain verification — reuse, don't rebuild.** `core.domains` already proves
   domain ownership for mail. Extend it.
2. **On-demand certificates**, issued by Caddy through an `ask` endpoint that
   answers "is this hostname a verified careers domain?"
   **This endpoint must fail closed.** If it ever fails open, anyone pointing a
   hostname at our IP triggers a certificate order, and we exhaust the
   certificate authority's rate limits — at which point issuance breaks for
   *every* TatvaOS domain, not just this feature. Read the CA's current limits
   at build time rather than assuming them.
3. **A self-service DNS screen** — the exact record to add and a "check now"
   button. Two DNS records took most of an afternoon between Amit and me on
   4 September, on a domain we control. Multiplied across customers and handled
   by email, that becomes the support cost of the product. The screen isn't
   polish; it's what keeps this option affordable.

---

## 5. Where to start, and the rule that applies from day one

**R1 is Hire's MVP.** My recommendation, and the roadmap's still-open question
1: **make Techvein our own first user.** We'd be the ones inconvenienced by
what's missing, which is the honest way to find out what's missing. And it lets
R1 ship before domain verification and on-demand certificates are finished,
because our own careers page can live on a domain we already control.

**The rule, in force since 5 September:** every new page uses Tailwind and
`components/ui/` only — `Kit.tsx`, `Form.tsx`, `Page.tsx`, `Modal.tsx`. Do not
use the YZEN Bootstrap template. It is being deleted; Hire and People will add
many screens, and on YZEN they'd grow that list faster than it shrinks.

There's a practical bonus, measured on 8 September: `/admin/plans`, migrated to
those components, came out **375px wide with zero overflow on a phone** with
nobody doing any mobile work on it. Pages built on the shared components are
mobile-correct for free. Pages built on Bootstrap are not.

---

## 6. Why you own both lanes

Amit's decision, 5 September. Hire and People are one hire, not two, because the
releases are sequential — R1–R4 are Hire, R5 onward is People — and it keeps the
lifecycle boundary in one head, which is where a Candidate→Employee conversion
is least likely to go wrong.

**The limit to watch:** from R5 you are maintaining a live Hire while building
People. That is the point at which one lane becomes two. It should be seen
coming rather than discovered — tell me when you feel it, and I'd rather hear it
early and be wrong than late and be right.

---

## 7. How we work

- `docs/HOUSE_RULES.md` is canonical. Anything contradicting it is out of date.
- Branch off `main`, push, PR, wait for CI, `gh pr merge --merge` — not squash,
  the commit messages are the record.
- **Every lane merges and deploys itself.** A deploy ships all of `main`, so a
  deploy that breaks someone else's work is still your deploy: roll back first,
  diagnose after, and say so immediately. Nobody is in trouble for a rollback;
  silence is the only wrong move.
- **Migrations are additive.** Rollback restores code, not schema — that is why.
  Run `verify-migrations.sh` if `main` holds a migration you haven't applied.
- **Never work in `C:\Users\amitd\Downloads\tatvaOS`.** That's the integration
  and deploy checkout. Work left there has needed rescuing more than once.
- Amit is not a developer. One command at a time, and tell him what success
  looks like. Windows PowerShell 5.1: **no `&&`**.

---

## 8. Your first week — a suggestion

1. Read the roadmap end to end, then tell me which of §7's three open questions
   you'd answer first. Your answer matters more than mine; you'll live in it.
2. Build the four missing Phase 0 tables — locations, designations, reporting
   hierarchy, employee-ID configuration. Small, unblocking, and it teaches you
   our migration conventions on something low-risk.
3. Write the sensitive-data design document for §3.2 before any code touches
   Aadhaar, PAN or bank details.
4. Do not start the careers portal until §4's three obligations have owners.

---

## 9. One thing I'd ask of you

This codebase's expensive failures have all been **quiet** ones: a check that
reported success while doing nothing, a setting that looked applied and wasn't,
a verifier that had never once gone red.

You are building the product that holds people's identity documents, salaries
and rejections. Quiet failure is far less acceptable here than anywhere else in
the suite.

So when you build a check, make it fail on purpose once and show me the red.
That's the standard here, and it's not a formality.

Welcome. Ask me anything, including whether I've got something wrong above.

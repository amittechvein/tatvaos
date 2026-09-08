# TatvaOS Hire → TatvaOS People

**Product roadmap, 5 September 2026.** Written up by the CTO from Amit's plan.

This is a **roadmap, not a commitment**. Nothing in it is scheduled, staffed, or
started. Sections 1–5 are the plan as agreed; section 6 is the engineering
reality that has to be settled before any of it is scheduled, and section 7 is
the short list of decisions that are Amit's alone.

---

## 1. The shape of it

Two products, one lifecycle.

```
Source → Apply → Screen → Interview → Select → Offer → Pre-Join → Join
                                                                    │
                    Employee → Develop → Retain → Exit ◄────────────┘
```

**The one product rule everything else follows from:**

> **Hire owns the candidate until joining. People owns the employee after joining.**

Candidate and Employee are **separate entities** with a built-in conversion at
the joining boundary. They are not the same row with a flag. A candidate who is
never hired must not become a half-employee, and an employee's record must not
be editable by anyone who can see the recruitment pipeline.

```
                         TATVAOS HR
                            │
             ┌──────────────┴──────────────┐
       TATVAOS HIRE                  TATVAOS PEOPLE
     Talent Acquisition             Employee Lifecycle
             │                             │
      ┌──────┼──────────┐         ┌────────┼────────┐
    Jobs  Candidates  Interviews  Employee Attendance Leave
      └──────┼──────────┘             │
             │                        ├── Payroll
          Selection                   ├── Performance
             │                        ├── Learning
           Offer                      ├── Assets
             │                        ├── Helpdesk
        Pre-Joining                   └── Exit
             │
      Employee Created ──────► TatvaOS People
```

---

## 2. Phase 0 — Foundation

Organisation, departments, locations, designations, reporting hierarchy,
employee-ID configuration, users, roles, permissions, audit logs,
notifications, document storage, activity timeline.

```
Organization
 ├── Departments
 ├── Locations
 ├── Designations
 ├── Users
 ├── Candidates
 └── Employees
```

**Most of this already exists in TatvaOS Core.** See §6.1 — that is the single
biggest reason to build HR here rather than as a separate product.

---

## 3. TatvaOS Hire

### Phase 1 — MVP

**Job openings.** Title, department, designation, location, employment type,
experience, qualification, skills, salary range, vacancies, description,
responsibilities, requirements, hiring manager, recruiter, opening and closing
dates.

**Careers portal** at `careers.<customer-domain>`:

```
View Jobs → Job Details → Apply → Upload Resume → Fill Application → Submit
```

**Candidate profile.** Name, photo, email, phone, location, resume,
experience, education, skills, current company and designation, expected
salary, notice period, source, tags, notes, documents.

**Applications, kept separate from candidates**, so one person can apply to
several roles:

```
Candidate → Application → Job Opening
```

**Recruitment pipeline**, customisable per organisation. Default:

```
Applied → Screening → Shortlisted → HR Interview → Assessment →
Technical Interview → Final Interview → Selected → Offer →
Offer Accepted → Pre-Joining → Joined
```

**Recruiter dashboard.** Open positions, new applications, candidates to
screen, interviews today, offers pending, joining this week, positions overdue,
time-to-hire, hiring funnel.

### Phase 2 — Interviews & assessments

Scheduling, interviewer assignment, candidate availability, calendar
integration, online interview with meeting link, reminders, reschedule, cancel,
history.

Per-interviewer evaluation form — technical skills, communication, problem
solving, culture fit, overall — with a recommendation of Strong Hire / Hire /
Hold / Reject.

Assessments: MCQ, coding tests, subjective questions, skill assessments, custom
tests, scoring, pass/fail, reports.

### Phase 3 — AI recruitment

```
Resume → AI Parsing → Skills → Experience → Qualification → Job Matching → Match Score
```

Recruiter assistant answering questions like *"show me the top 10 BDM
candidates"*, *"why is this person a good match"*, *"compare these five"*,
*"draft interview questions"*, *"summarise all interviews"*.

Interview summaries from recordings: transcription → summary → strengths →
concerns → score → recommendation.

**AI is assistive and never the sole basis for a hiring decision.** This is a
product rule, not a preference — see §6.5.

### Phase 4 — Offers

```
Candidate → Salary Structure → Offer Template → Offer Letter → Approval → Send
```

States: draft, pending approval, sent, viewed, accepted, rejected, expired.
Approval chain configurable, e.g. Recruiter → HR Manager → Department Head →
Management → Released.

### Phase 5 — Pre-joining and onboarding

The bridge between the two products.

```
Offer Accepted → Pre-Joining → Documents → Employee Details → Joining Date
                                                    │
                                            Employee Created → TatvaOS People
```

Candidate submits personal information, address, emergency contact, bank
details, PAN, Aadhaar or other required IDs, education and experience
documents, photograph, signed offer.

**This is the most sensitive data in either product.** See §6.3.

---

## 4. TatvaOS People

### Phase 6 — Employee MVP

```
Employee
├── Personal      ├── Contact     ├── Statutory
├── Employment    ├── Documents   └── Emergency Contact
├── Organization  └── Bank
```

Directory searchable by employee ID, name, department, designation, location,
manager, status.

### Phase 7 — Attendance

Daily attendance, check-in/out, shifts, late arrival, early leaving, overtime,
regularisation, attendance calendar, biometric integration, mobile attendance,
geofencing where appropriate, reports.

Techvein already does biometric and attendance integration work. That is
existing expertise, and it is the part of People a customer can see working on
day one.

### Phase 8 — Leave

Configurable types (casual, sick, earned, compensatory, maternity/paternity,
custom).

```
Employee → Apply Leave → Reporting Manager → Approve / Reject → Balance Updated
```

Balances, holiday calendar, policies, negative-balance rules, carry forward,
encashment, approval hierarchy.

### Phase 9 — Payroll

Only after employee, attendance and leave are stable.

```
Employee → Attendance → Leave → Salary Structure → Payroll Processing →
Deductions → Net Salary → Approval → Payslip
```

Salary structure, earnings, deductions, PF, ESI, TDS, professional tax,
bonuses, incentives, loans and advances, payslips, reports. Statutory rules
configurable and validated against current requirements before production use.

**Payroll is the highest-risk module in this roadmap.** See §6.4.

### Phase 10 — Performance

```
Goal Setting → KPI/OKR → Quarterly Review → Manager Feedback →
Self Assessment → Final Rating → Appraisal
```

Goals, KPIs, KRAs, self and manager appraisal, 360° feedback, ratings, PIP,
promotion, increment, appraisal history.

### Phase 11 — Learning

Training catalogue, courses, internal and external training, assignments,
certifications, skill matrix, training calendar, completion tracking. AI can
recommend courses against identified skill gaps.

### Phase 12 — Assets

```
Employee → Asset → Serial Number → Issue Date → Condition → Return
```

Laptops, desktops, mobiles, ID cards, SIMs, vehicles, accessories, software
licences.

### Phase 13 — Helpdesk

```
Employee → Ticket → Department → Assigned Person → Resolution →
Employee Confirmation → Closed
```

IT, HR, payroll, attendance, leave, asset and general requests.

### Phase 14 — Exit

```
Resignation → Manager Approval → Notice Period → Knowledge Transfer →
Asset Return → Clearance → Payroll Settlement → Experience Letter →
Relieving Letter → Deactivated
```

**The employee record is never deleted.** Status becomes `Exited` and the
history stays. Payroll, tax and employment records have retention obligations
that outlive the employment.

### Phase 15 — AI and analytics across both products

Hire: resume matching, candidate ranking, interview questions, interview
summaries, job description generation, candidate communication, recruitment
analytics.

People: HR assistant, leave assistant, payroll and policy Q&A, performance
insights, training recommendations, attrition-risk signals, workforce
analytics.

---

## 5. Release order

Not everything at once. Each release is sellable on its own.

| Release | Contents |
|---|---|
| **R1 — Hire MVP** | Job openings, careers portal, candidates, applications, pipeline, recruiter dashboard |
| **R2** | Interviews, assessments, email/notifications, recruitment automation |
| **R3** | AI resume screening, candidate matching, interview summaries |
| **R4** | Offers, approvals, pre-joining, onboarding |
| **R5 — People MVP** | Employee profile, directory, attendance, leave |
| **R6** | Payroll, performance |
| **R7** | Learning, assets, helpdesk, exit |
| **R8** | AI HR assistant, workforce analytics, advanced automation |

Hire before People is the right order: **Hire sells on its own**, People does
not become worth paying for until payroll works.

---

## 6. The engineering view

This section is the CTO's, not the product plan's. None of it changes the
roadmap; all of it changes what the roadmap costs.

### 6.1 How much of Phase 0 already exists

Genuinely good news. Checked against `local/postgres/init/`, not assumed:

| Phase 0 need | Status in TatvaOS today |
|---|---|
| Organisations / tenants | `core.tenants` — exists, with row-level security |
| Departments | `core.departments` — exists |
| Users, roles, permissions | `core.users`, role policies in `Program.cs` — exists |
| Audit logs | `core.audit_logs` + `AuditWriter` — exists |
| Document storage | Space (`space.files`, shares, public links) — exists |
| Notifications / email | `Shared/Notify`, `MailSender`, the send API — exists |
| Product entitlement | `core.products`, `core.product_access` — exists |
| Storage quotas | `core.storage_pools`, `storage_allocations` — exists |
| AI gateway with per-org consent | `Shared/Ai/IAiGateway` — exists, fail-closed |
| **Locations** | **Does not exist** |
| **Designations** | **Does not exist** |
| **Reporting hierarchy** | **Does not exist** |
| **Employee-ID configuration** | **Does not exist** |

So Phase 0 is roughly three quarters built, and the missing quarter is small
tables rather than infrastructure. HR belongs inside TatvaOS for exactly this
reason: signing in, tenanting, permissions, audit, storage and mail are already
solved and already isolated per customer.

**But:** `core.users` is a login identity, not an employee. Do not extend it
with employment fields. An employee has a manager, a designation, a joining
date and a salary; a user has a password and a role. They are related, not the
same, and merging them makes every future permission question harder.

### 6.2 Public careers portal — a new class of exposure

`careers.<customer-domain>` is the first **unauthenticated, public,
file-accepting** surface TatvaOS will have run. Everything we operate today
requires a login. This one takes uploads from strangers by design.

That means, before R1 ships: file type and size limits enforced server-side,
resumes stored outside the web root and never served from a path an attacker
can guess, virus scanning, rate limiting per IP, and spam/bot protection on the
application form. None of this is optional and none of it is quick.

### 6.3 Aadhaar, PAN, bank details — a different data class

Pre-joining collects government identifiers and bank details. This is
categorically different from anything in TatvaOS today.

- The **keep-everything retention ruling** made for the mail send API does
  **not** carry over. HR data has deletion obligations mail logs don't.
- Under the DPDP Act these are sensitive personal data with consent, purpose
  limitation and erasure duties.
- They should be **encrypted at rest separately from the rest of the row**,
  with access audited per read, not just per write.

This needs its own design document before Phase 5 is written, not during.

### 6.4 Payroll is regulated software

PF, ESI, TDS and professional tax are statutory. Getting them wrong doesn't
produce a bug report — it produces an underpaid employee and a customer with a
compliance problem they will hold us responsible for. Rates and slabs change
with budgets.

There is a real build-versus-integrate decision here (§7), and it should be
made before R6 is scheduled rather than discovered halfway through it.

### 6.5 AI making decisions about people

Resume screening ranks human beings. That carries obligations ordinary features
don't:

- **Assistive only**, as the plan already says. Keep it that way in the code,
  not just the document — no automatic rejection, ever.
- Every AI score must be **explainable and logged**: which model, which
  version, what it saw, what it said. When a candidate or a regulator asks why,
  "the model said 43%" is not an answer.
- Training or prompting on historical hiring data reproduces historical bias.
- Interview recordings are biometric-adjacent data and need explicit consent
  from the candidate, not a line in the terms.

We already have the right foundation for this — `IAiGateway` enforces
per-organisation consent fail-closed — but the audit trail for scoring
decisions does not exist yet.

### 6.6 Capacity, honestly

Fifteen phases, two products. The current team is Core, Mail, Connect, and me
not writing feature code. All three are fully committed: the bounce pipeline,
the api-keys constraint work, the mobile app, `verify-migrations.sh`.

**R1 alone is a lane.** Someone owns Hire end to end or it doesn't happen —
that is how every other product here got built, and it is why they work.

Nothing in this document should be read as a date. What it does say is that
the foundation is genuinely there, the sequencing is sound, and the cost is a
new lane and a new developer.

---

## 7. Decisions

### Settled — Amit, 5 September 2026

**One developer owns both lanes.** Hire and People are one hire, not two. That
works because the releases are sequential — R1–R4 are Hire, R5 onward are
People — and it keeps the lifecycle boundary in one head, which is where a
Candidate→Employee conversion is least likely to go wrong.

The limit to watch: from R5 the same person is maintaining a live Hire while
building People. That is the point at which one lane becomes two, and it should
be seen coming rather than discovered.

**Addresses, following the existing product convention:**

| | |
|---|---|
| `hire.tatvaos.com` | Recruiters, hiring managers, HR — signed in |
| `people.tatvaos.com` | Employees, managers, HR — signed in |

Both sit behind the same Caddy and the same sign-in as every other product, and
both get a `core.products` code and `product_access` rows like Mail and Space.

**Careers portal: `careers.<customer>.com`, on the customer's own domain.**
Amit's call, taken over my recommendation of a subdomain of ours. It is the
right product answer — a school's candidates should see the school's name, and
it is what every serious ATS offers — and it is the most expensive of the three
options to build and to run. Recorded here so the cost is chosen rather than
discovered.

What it obliges us to build, before the first external customer:

**1. Domain verification, reused not rebuilt.** A customer must prove they own
the domain before we will serve or certify anything on it. `core.domains`
already does this for mail; extend it rather than writing a second one.

**2. Certificates on domains we do not own.** Caddy issues these on demand,
gated by an `ask` endpoint that answers "is this hostname a verified careers
domain?" That endpoint is a **check with a real failure mode**: if it ever
fails open, anyone who points a hostname at our IP triggers a certificate
order, and we exhaust the certificate authority's rate limits — at which point
issuance breaks for *every* TatvaOS domain, not just this feature. It must fail
closed, and the rate limits should be read from the CA's current documentation
at build time rather than assumed.

**3. A self-service DNS screen.** The customer needs the exact record to add
and a "check now" button that tells them whether it worked. Two DNS records
took most of an afternoon between Amit and the CTO on 4 September, on a domain
we control. Multiplied across customers and handled by email, this becomes the
support cost of the product. The screen is not polish; it is the thing that
keeps this option affordable.

**Effect on R1:** the careers portal is no longer just a page. Domain
verification, on-demand certificates and the DNS screen all land before the
first external customer can use it. Techvein's own hiring can run without them
(§7, still open) — which is a further argument for being our own first user.

### Still open

1. **Who is R1 for?** Techvein's own hiring first, or a paying customer? Our own
   is the safer first user and the honest one — we'd be the ones inconvenienced
   by what's missing.

2. **Payroll: build or integrate?** Building means owning statutory correctness
   forever. Integrating means a partner and a revenue share, and a faster,
   safer R6. This decides the shape of R6 and should be settled long before it.

3. **Do we take interview recordings at all?** Phase 3's interview summaries
   depend on them. They are the most sensitive artefact in the product and
   Connect already has the recording machinery — which makes it easy to do, and
   easy to do without thinking.

---

*Related: `docs/HOUSE_RULES.md`, `docs/MOBILE_LANE_BRIEF.md`. This document is
the plan of record for TatvaOS HR until superseded.*

# TatvaOS Personal — free signup, paid plans, and pricing

**Status: PROPOSAL for Amit's review, 23 August 2026.** Nothing here is built.
Prices are recommendations with reasoning attached; every number is Amit's to
change. Once agreed, the build order at the bottom is the work plan.

---

## 1. What this is, and what it is not

Today TatvaOS signs up **organisations**: a school or clinic registers, brings
its own domain, and buys seats (the existing catalogue: Starter ₹49/user,
Business ₹99/user, Institution, Enterprise).

This document adds a second front door: **personal accounts**. Anyone visits
tatvaos.com, registers, and gets a free `name@tatvaos.com` address with mail,
files, calendar and meetings — the Gmail model. They pay only if they outgrow
the free tier.

These are two different products sharing one platform:

| | Organisation (exists) | Personal (this document) |
|---|---|---|
| Who signs up | A school, clinic, business | One person |
| Domain | Their own | `@tatvaos.com`, shared |
| Who pays | The organisation, per seat | The person, for themselves |
| Why it exists | Revenue | Funnel, brand, and small revenue |

The personal free tier is a **marketing expense that pays for itself**: a
teacher who uses TatvaOS personally is the person who later proposes it to
their school. Every serious competitor (Google, Microsoft, Zoho) runs exactly
this funnel.

---

## 2. The plans

### Free — ₹0

For trying it, and for people whose needs are genuinely small.

- 1 GB storage (shared across mail and files)
- `name@tatvaos.com` mail, calendar, files
- Meetings: up to **5 participants, 60 minutes**, no recording, no AI minutes
- Live captions work (they cost us nothing)

*Why 5/60 and not more:* the free tier must be useful enough to love and
limited enough to outgrow. A 60-minute cap is generous against Google Meet's
free 60 and Zoom's free 40; five participants covers a family call or a
tuition group but not a class.

### Basic — ₹49/month or ₹490/year

For an individual who works with others: a tutor, a freelancer, a shop.

- **5 GB** storage
- Meetings: up to **20 participants**, no time limit
- **No recording, no AI minutes** (Amit's ruling — this is the Premium hook)
- Captions and attendance-based notes still work
- Custom "from" name, mail signatures, the everyday features

### Premium — ₹99/month or ₹990/year

Everything switched on.

- **10 GB** storage
- Meetings: up to **50 participants**
- **Recording** (audio and video — video counts hard against storage: ~1.4
  GB/hour, and recordings auto-delete after 30 days)
- **AI meeting minutes** — summary, decisions, action items, in English,
  whatever language the meeting was held in
- Priority support

### Add-ons (any paid plan)

| Add-on | Price | Note |
|---|---|---|
| +10 GB storage | ₹25/month | Stackable |
| +50 GB storage | ₹99/month | Better rate at volume |
| Big meetings (up to 100 participants) | ₹49/month | Premium only |

*Not offered as add-ons:* recording and AI minutes stay Premium-only rather
than becoming à-la-carte. One clean reason to upgrade beats four ₹20 toggles
nobody understands — and support for "which switches do I have?" costs more
than the toggles earn.

---

## 3. Why these prices

**The anchor is what India already pays.** Google One is ₹130/month for 100
GB but no meetings product; Google Workspace starts around ₹160/user/month;
Zoho around ₹99. A personal plan from an Indian company at **₹49** undercuts
everything with a real feature set, and **₹99** lands exactly on "one decent
chai a week" — under the psychological ₹100 line.

**The margins are real because our costs are now known, not guessed:**

- AI minutes cost ~₹1 per hour of meeting (measured 22 Aug). A Premium user
  holding 20 hours of meetings a month costs ~₹20 of AI against ₹99 collected.
- Captions (the transcript source) cost ₹0.
- Storage is our own disk. 10 GB of quota costs pennies; the real protection
  is that recordings count against the user's own quota (shipped 23 Aug) and
  age off after 30 days (shipped 23 Aug).
- The current box handles ~200 meeting participants total. The 50-person
  Premium cap and 100-person add-on are set well inside that, deliberately.

**Yearly = ten months.** Two months free for paying up front. Cash earlier,
churn lower, and simple to say.

**All prices need a GST decision** (see Open Decisions). Recommendation:
advertise inclusive — a personal buyer sees ₹99, not ₹99 + 18%.

---

## 4. Free-tier abuse, faced now rather than after launch

Anyone-can-register means bots can register. Minimum defences, all before
launch, not after:

1. **Phone or email OTP at signup** — the OTP machinery already exists
   (login OTP, signup OTP tables shipped in August).
2. **One free account per phone number.**
3. **Outbound mail limits on free accounts** — e.g. 50 recipients/day —
   or tatvaos.com becomes a spam domain and every customer's mail lands in
   junk. This is the existential one: sender reputation is shared.
4. **Username rules** — reserve `admin@`, `support@`, `billing@`, product
   names, and obvious impersonations before someone else does.
5. Storage on abandoned free accounts: inactive 12 months → warning mail →
   90 days later, delete. Free storage nobody visits is pure cost.

---

## 5. What exists vs what must be built

**Already on the platform** (this is why the plan is achievable):

- Signup flow with OTP (built for orgs — needs a personal variant)
- Plans, subscriptions and quota tables (`core.plans`,
  `core.subscriptions`, per-user quotas, storage meters)
- Storage counted correctly across mail + files + recordings (fixed 23 Aug)
- Meeting infrastructure incl. participant caps, recording, AI minutes,
  30-day retention
- Feature gating precedent: recording already refuses by meeting mode and
  server settings — plan gating follows the same shape

**To build:**

1. A `tatvaos.com` **house tenant** that personal accounts live in, with
   per-user (not org-level) plan attachment
2. **Personal signup page** — pick a username, OTP, in
3. **Plan enforcement** — participant caps, recording/minutes gating, and
   storage quota driven by the person's plan
4. **Billing** — payment gateway integration (PayU is already familiar),
   subscription lifecycle: pay, renew, fail, downgrade
5. **Upgrade screens** — plan chooser, add-on management, invoices
6. Abuse defences from §4

**Suggested build order** — each phase shippable on its own:

- **Phase 1: free tier only.** Personal signup, house tenant, 1 GB quota,
  free meeting limits, abuse defences. No payments at all. This proves
  signup, isolation and quotas with zero billing complexity.
- **Phase 2: payments.** PayU, Basic and Premium, upgrade screen, invoices.
- **Phase 3: add-ons** and the yearly billing option.

---

## 6. Open decisions (Amit)

1. **GST**: prices inclusive (recommended) or plus-tax?
2. **Free meeting limits**: 5 participants / 60 minutes — confirm or adjust.
3. **Payment gateway**: PayU (familiar) vs Razorpay (better subscription
   APIs). Needs deciding before Phase 2 starts.
4. **Refund policy**: recommendation — 7-day money-back on first purchase,
   none on renewals; simple and defensible.
5. **Yearly-only launch discount?** e.g. first 1,000 Premium accounts at
   ₹790/year. Cheap to offer, creates urgency, caps exposure.
6. Does the **org catalogue** (Starter/Business/…) stay as-is alongside
   this? Recommendation: yes, untouched — different buyers.

---

## 7. The one risk worth stating plainly

The free tier's real cost is not storage, it is **mail reputation**. A
thousand bots on `@tatvaos.com` sending spam gets the domain blacklisted, and
then *paying* customers' mail bounces. §4 item 3 is not optional hardening —
it is the difference between a funnel and a self-inflicted outage. It ships
in Phase 1 or Phase 1 does not ship.

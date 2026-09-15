# 0002 — Entitlement is derived from the plan, not copied into rows

**Status:** proposed — ready for review, every product question answered
**Date:** 2026-09-13; revised 2026-09-15 before review, with Amit's answers, and with his answers to the two questions they raised

## Context

Today a person's products are the live rows in `core.product_access`
(`revoked_at IS NULL`). Those rows are copies of what the plan said at the
moment somebody wrote them, and nothing keeps them equal to
`core.plans.included_products`. The CTO ruled on 9 Sept that entitlement is
**derived**: plan products, plus grants, minus revokes; on 13 Sept that an
organisation-level revoke is an **absolute veto** over a user-level grant.
`core.entitlement_overrides` (20260910) exists for the exceptions; nothing
reads it yet.

**Revised 15 Sept, before the CTO read it.** The first version joined
`core.tenants.plan_id`, a column that does not exist: a tenant reaches its
plan through `core.subscriptions`. It named "create and update" and "delete
and suspend" as the product-access sites; the real ones are create, bulk
create, offboard and delete. And it assumed the switch would change nothing a
person sees. Measured on production, it would have changed every active
person's products.

**Revised again 15 Sept, with Amit's four answers.** Every organisation gets
a subscription; Connect and Calendar are available; the plans stay as they
are; a cancelled subscription grants nothing from the plan. Measured again
under those answers, nobody loses a product. Two questions followed from
them — whether a trial subscription grants products, and what existing
people get on the day of the switch — and Amit answered both the same day:
trial grants, and everyone gets their organisation's plan.

Every place that consumes entitlement today, from a grep of `apps/api` on
15 Sept:

| Site | Today |
|---|---|
| `Modules/Auth/Endpoints/AuthEndpoints.cs`, `MeAsync` | returns `products` for the signed-in person from `product_access`; the mobile dashboard tiles read this |
| `Modules/Admin/Endpoints/UserEndpoints.cs`, `ListAsync` | reads `product_access` per user for the user list |
| `UserEndpoints.cs`, `CreateAsync` and `BulkCreateAsync` | **write** `product_access` rows from a `products` array; `products.Contains("mail")` decides whether a mailbox is created |
| `UserEndpoints.cs`, `OffboardAsync` and `DeleteAsync` | set `revoked_at` on the person's rows |
| `Modules/Core/Endpoints/SignupEndpoints.cs`, the org-owner insert | writes one `mail` row for the new owner — the copy the 13 Sept list says to delete |

`UpdateAsync` and `SuspendAsync` do not touch product access. The web app's
launcher does not read entitlement at all: it shows a fixed list of live
products from `apps/web/lib/nav.tsx` to everyone. The mobile app filters its
own fixed tile list by the `products` that `MeAsync` returns
(`apps/mobile/theme.js`). Neither has a tile for Hire or People.

**Tenant to plan.** `core.subscriptions (tenant_id, plan_id, status,
started_at, cancelled_at)`, status one of `trial`, `active`, `past_due`,
`cancelled`. A tenant may hold several rows; the console takes the latest by
`started_at` (`Modules/Admin/Endpoints/OrganisationEndpoints.cs`). The one
place a subscription changes behaviour today is the seat limit in
`Modules/Admin/StorageAllocator.cs`, which reads the plan behind a
subscription whose status is `active` or `trial`.

There is no per-request gate: no endpoint refuses a call because the caller
lacks a product. Entitlement only decides what is shown and whether a mailbox
exists. That keeps this change small.

## What the switch would change — measured on production, 15 Sept

Read-only, counts only, no identities. 13 active people across four
organisations. Two organisations have no subscription: one suspended with one
active person, and one school on trial with one active person. Of the two
with a subscription, one is `active` and one is `trial`.

- Live `product_access` rows: `mail` 15, `connect` 6.
- Every plan's `included_products` on production is
  `{mail, family, drive, connect, calendar, hire, people}`. Enterprise adds
  `payroll`, `sheet`, `word`, which are not rows in `core.products`. No
  organisation is on Enterprise.

| Derived from | People whose products change | Gained (person-product pairs) | Lost |
|---|---|---|---|
| plan only, before Amit's answers | 13 of 13 | calendar 11, connect 5, drive 11, family 11, hire 11, people 11 | mail 2 |
| plan, available products only, before the answers | 13 of 13 | drive 11, family 11 | connect 6, mail 2 |
| **Amit's answers applied** | 13 of 13 | calendar 13, drive 13, family 13, hire 13, people 13, connect 7 | **none** |

The last row was first computed assuming the two organisations without a
subscription were on Starter and that a `trial` subscription grants
products. Both are now true — Starter was added on 15 Sept and Amit confirmed
trial — and the same query run on the real data afterwards gives the same
row.

## Amit's answers, 15 Sept

1. **Every organisation needs a subscription; the two without one get
   Starter.** Done on 15 Sept through the console's change-plan action. It
   wrote `platform:organisation.plan_changed` to the audit log for each, with
   the acting admin recorded, and created a `trial` Starter subscription
   with ten seats, because neither organisation is active. It changed only
   the seat limit: each has one person, and both storage pools were checked
   unchanged afterwards. No organisation on production is now without a
   subscription.
2. **Connect and Calendar are available.** A separate migration,
   `20260915-b-catalogue-connect-calendar-available.sql`, flips both flags.
   Nothing reads the flag today, so it changes nothing a person sees.
3. **Every plan includes `mail`, `family`, `drive`, `connect`,
   `calendar`, `hire`, `people`** — already true on production. Whether
   Enterprise sells `payroll`, `sheet` and `word` is undecided; no
   organisation is on Enterprise and nothing in the repository records a
   request, and the function below leaves them out regardless, because they
   are not products in the catalogue. Hire and People are included on
   purpose, to be shown as coming soon. **Today no tile exists for either on
   the web or on mobile**, so including them shows nothing until a
   coming-soon tile is added. That tile is a separate UI change, not part of
   this record.
4. **A cancelled subscription grants nothing from the plan.** A user-level
   or organisation-level grant still stands after cancellation. Past-due is
   treated as active until the finance rules exist.

## Options

1. **Keep `product_access` as the truth and sync it from the plan.** A job or
   trigger rewrites rows when a plan changes. Pros: no read-site changes.
   Cons: a second copy of one fact with a sync that can be down, behind, or
   never have run — rule 10, and the exact shape that produced the drift.
2. **Derive at read time from plan + overrides; `product_access` becomes
   history.** Pros: one implementation of the fact, no sweeper, the override
   table's own contract ("expiry is evaluated in the read query") already
   assumes this. Cons: the read and write sites change, and the switch
   changes what people see unless a backfill freezes it.
3. **Derive, and also materialise a view for reporting.** Pros: reporting
   convenience. Cons: a view is still a copy if anyone writes to it; deferred
   until somebody asks for a report.

## Decision

Option 2.

**Which subscription grants products — one definition.** The latest row by
`started_at`, and then its status: `trial`, `active` and `past_due` grant the
plan; `cancelled` grants nothing. It is the latest row's status, not the
latest row that happens to be active, so a newer cancellation beats an older
active row. This is one SQL function, used by the entitlement function and
by the seat limit in `StorageAllocator.cs`, which today counts only `active`
and `trial` — rule 10, so past-due cannot mean "has products" in one place
and "has no seats" in another:

```sql
CREATE OR REPLACE FUNCTION core.granting_plan_id(p_tenant uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN s.status IN ('trial', 'active', 'past_due') THEN s.plan_id END
      FROM core.subscriptions s
     WHERE s.tenant_id = p_tenant
     ORDER BY s.started_at DESC
     LIMIT 1
$$;
```

**`trial` grants — confirmed by Amit, 15 Sept:** "A trial subscription is
still active, not cancelled." One organisation on production is on a `trial`
subscription with three active people, and they keep their products through
the switch.

**The derived query**, as a `STABLE` SQL function
`core.effective_products(p_tenant uuid, p_user uuid) RETURNS SETOF text`,
RLS-visible like every other read (the caller already has `app.tenant_id`
set; no definer needed):

```sql
WITH live AS (
    SELECT user_id, product_code, mode
      FROM core.entitlement_overrides
     WHERE tenant_id = p_tenant
       AND withdrawn_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND (user_id IS NULL OR user_id = p_user)
),
plan AS (
    SELECT unnest(p.included_products) AS product_code
      FROM core.plans p
     WHERE p.id = core.granting_plan_id(p_tenant)
),
granted AS (
    SELECT product_code FROM plan
    UNION
    SELECT product_code FROM live WHERE mode = 'grant'
)
SELECT g.product_code
  FROM granted g
 WHERE EXISTS (SELECT 1 FROM core.products pr               -- a real product
                WHERE pr.code = g.product_code)
   AND NOT EXISTS (SELECT 1 FROM live r                       -- org revoke: final
                    WHERE r.user_id IS NULL AND r.mode = 'revoke'
                      AND r.product_code = g.product_code)
   AND NOT EXISTS (SELECT 1 FROM live r                       -- user revoke
                    WHERE r.user_id = p_user AND r.mode = 'revoke'
                      AND r.product_code = g.product_code);
```

A cancelled subscription makes `plan` empty, and `granted` still carries any
live `grant` rows, which is Amit's rule 4.

**Why existence, not availability.** Availability is a catalogue flag — what
the console offers for new grants and whether a product has shipped — not a
reason to hide a product someone's plan includes. The `EXISTS` keeps codes
that are not products at all (`payroll`, `sheet`, `word`) out. Hire and
People stay derivable while unavailable, which is what lets a coming-soon
tile read them. `MeAsync` returns each product with its availability, so a
client shows an unavailable product as coming soon instead of opening it.

**How "org revoke is final" is expressed:** the first `NOT EXISTS` removes a
product whenever an organisation-level revoke is live, and it runs against
`granted`, which already includes user-level grants. A user grant therefore
never re-adds what an org revoke removed. The second `NOT EXISTS` is the
user-level revoke. A user-level grant and a user-level revoke for the same
product cannot both be live: the unique index `ux_entitlement_overrides_live`
covers `(tenant, user, product)` for un-withdrawn rows, so the second one is
refused at insert. That index ignores `expires_at`, so an expired row must be
withdrawn before a new one is written for the same product; the admin write
path does that in the same transaction. Revoke beats grant only across
scopes, and only downward.

**Day one — decided by Amit, 15 Sept: everyone gets their plan (B).** Under
his answers nobody loses a product, and all 13 active people gain the
products their plan includes but they do not hold today. The two ways that
were weighed:

- *(A) Freeze today.* The backfill writes a user-level `revoke` for every
  gain: 72 rows for 13 people. Day one changes nothing anyone sees. Existing
  people keep today's products until an admin grants more; anyone added
  afterwards gets the full plan, so two people in one organisation can
  differ only because of when they joined.
- *(B) Give everyone their plan.* The backfill writes a user-level `grant`
  only for products held today that the function would not give — none,
  measured. Day one, the 13 people's product lists grow. The web launcher
  already shows every live product to everyone, so the web does not change;
  the mobile dashboard shows new tiles (Space, Contacts and Calendar for
  everyone, and Connect for seven more people), and the admin user list
  shows the fuller lists. Hire and People appear nowhere until a tile
  exists.

**Chosen: (B).** In Amit's words it is simpler than freezing and avoids two
people in one organisation differing only by when they joined. It leaves no
rows whose only purpose is to record the past, and its visible change is
small: nothing on the web, and new mobile tiles only for products that
already have a tile. The backfill stays as the guard against losses: it
writes a user-level `grant` for any product a person holds on the day that
the function would not give them, and it is measured to write none.

Every backfilled row carries `reason = '0002 backfill: access as it was when
entitlement became derived'` and `granted_by` set to a fixed system-actor id
named in the migration. Inserts use `ON CONFLICT ... DO NOTHING` against the
live-row unique index, and a second run inserts nothing, because after the
first run the function already agrees with what the backfill preserved.

**The read and write sites.** `MeAsync` returns the function's result, with
availability. The admin user list calls it once per page (a lateral join,
not per user). `CreateAsync` and `BulkCreateAsync` stop writing
`product_access`; when the operator ticks a product the plan does not include
they write a `grant` override, and when they untick one it does include they
write a `revoke`, both with `granted_by` and `reason`. `OffboardAsync` and
`DeleteAsync` write user-level revokes instead of setting `revoked_at`, so the
record of what was taken away survives. The signup copy in
`SignupEndpoints.cs` is deleted: every plan includes `mail`, so the owner
derives it. `StorageAllocator.cs` reads its seat limit through
`core.granting_plan_id`. `product_access` stops being written; it is not
dropped (rule 2, additive).

**The shadowed-grant warning.** When the create path is about to write a
user-level `grant` and a live org-level `revoke` exists for the same product,
the API still writes the row (the operator may be preparing for the hold to
lift) but returns `shadowedBy: ["<product>"]` in the response, and the admin
user screen renders a warning beside that product: *"Granted, but the
organisation has this product on hold. The person will not see it until the
hold is withdrawn."* The user list shows the same product with a "held"
marker, so the state is visible on every screen that shows the grant, not
only at the moment of granting.

**Order of work.**

1. Starter for the two organisations without a subscription — done 15 Sept,
   through the console, audited.
2. The catalogue migration (Connect and Calendar available) merges and
   deploys.
3. `core.granting_plan_id` and `core.effective_products` land as an additive
   migration; `StorageAllocator.cs` reads the seat limit through the first.
4. The backfill and the switch of the read and write sites land
   together; the migrations run before the new API starts, as `deploy.sh`
   already orders them. The proof below runs first against a restored copy
   of production.

## What proves it

**The function.** A psql check under `tests/isolation/`, run by CI, against
scratch tenants arranged as follows.

| Arrangement | Expected `effective_products` |
|---|---|
| `active` subscription to a plan `{mail, drive}`; org-level `revoke` on `drive`; owner has no user rows | `{mail}` — drive removed by the org revoke |
| the same tenant, a person with a user-level `grant` on `connect` | `{mail, connect}` |
| the same tenant, a person with a user-level `revoke` on `mail` | `{}` |
| the same tenant, after a user-level `grant` on `drive` | still no `drive` — the org revoke is final |
| the same tenant, after `withdrawn_at` is set on the org revoke | `drive` returns |
| a grant whose `expires_at` is in the past | the grant does not count |
| latest subscription `past_due` | the plan's products |
| latest subscription `trial` | the plan's products |
| latest subscription `cancelled`, a person with a user-level `grant` on `connect` | `{connect}` only |
| an older `active` row and a newer `cancelled` row | grants only — the newer row wins |
| no subscription at all | grants only |

Red first: run the check against a function with the first `NOT EXISTS`
deleted, and watch the fourth row fail; and against a `granting_plan_id`
that picks the latest *active* row, and watch the tenth row fail.

**The switch.** The measurement query behind "What the switch would change",
run after the backfill on a restored copy of production and then on
production:

- "people who lose any product" must answer 0, and the gains must equal the
  last row of that table.

It has been seen red and then green on production: "people who lose any
product" answered 2 before the two organisations had a subscription, and 0
after Starter was added on 15 Sept.

## Consequences

Easier: one place answers "what does this person have"; a plan change takes
effect on the next request; the shadowed-grant case cannot be silent; seats
and products agree on what a past-due subscription means.

Harder, and customer-facing: **a cancelled subscription now removes the
plan's products**, which it does not do today — today nothing touches
`product_access` when a subscription is cancelled. That is Amit's rule, and
because it changes what a customer experiences on cancellation, its wording
to customers is Amit's and the CTO's. Every plan edit immediately changes
what every person on that plan gets. The admin screens must express "on hold" states they never
had to. `product_access` history stops growing, so a report that reads it
needs the function instead.

Accepted: two extra `NOT EXISTS` per read, on tables with a covering partial
index.

## Revisit when

A product needs a per-request gate (an endpoint that must refuse a call
rather than hide a tile), or finance defines what past-due should cost a
customer. Then this record is superseded.

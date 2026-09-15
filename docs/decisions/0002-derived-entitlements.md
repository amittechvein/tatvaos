# 0002 — Entitlement is derived from the plan, not copied into rows

**Status:** proposed
**Date:** 2026-09-13, revised 2026-09-15

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
person's products. All three are corrected below, and the measurement is the
section "What the switch would change".

Every place that consumes entitlement today, from a grep of `apps/api` on
15 Sept:

| Site | Today |
|---|---|
| `Modules/Auth/Endpoints/AuthEndpoints.cs`, `MeAsync` | returns `products` for the signed-in person from `product_access`; the web dashboard and the mobile tiles read this |
| `Modules/Admin/Endpoints/UserEndpoints.cs`, `ListAsync` | reads `product_access` per user for the user list |
| `UserEndpoints.cs`, `CreateAsync` and `BulkCreateAsync` | **write** `product_access` rows from a `products` array; `products.Contains("mail")` decides whether a mailbox is created |
| `UserEndpoints.cs`, `OffboardAsync` and `DeleteAsync` | set `revoked_at` on the person's rows |
| `Modules/Core/Endpoints/SignupEndpoints.cs`, the org-owner insert | writes one `mail` row for the new owner — the copy the 13 Sept list says to delete |

`UpdateAsync` and `SuspendAsync` do not touch product access.

**Tenant to plan.** `core.subscriptions (tenant_id, plan_id, status,
started_at, cancelled_at)`. A tenant may hold several rows; the console takes
the latest by `started_at`, whatever its status
(`Modules/Admin/Endpoints/OrganisationEndpoints.cs`).

There is no per-request gate: no endpoint refuses a call because the caller
lacks a product. Entitlement only decides what is shown and whether a mailbox
exists. That keeps this change small.

## What the switch would change — measured on production, 15 Sept

Read-only, counts only, no identities. 13 active people: 11 in organisations
with a subscription, 2 in organisations with none. Two of the four
organisations have no subscription row.

- Live `product_access` rows: `mail` 15, `connect` 6.
- `core.products`: `mail`, `family`, `drive` available; `calendar`,
  `connect`, `hire`, `people` marked not available.
- Every plan's `included_products` on production is
  `{mail, family, drive, connect, calendar, hire, people}`. Enterprise adds
  `payroll`, `sheet`, `word`, which are not rows in `core.products` at all.

Deriving from the latest subscription's plan, compared with what each person
holds today:

| Derived from | People whose products change | Gained (person-product pairs) | Lost |
|---|---|---|---|
| plan only | 13 of 13 | calendar 11, connect 5, drive 11, family 11, hire 11, people 11 | mail 2 |
| plan, available products only | 13 of 13 | drive 11, family 11 | connect 6, mail 2 |

So the switch as first designed would have shown Hire, People, Calendar,
Drive and Family to people who do not have them. Filtering on availability
would have taken Connect away from the six people using it. And the two
people in organisations without a subscription would have lost Mail.

## Options

1. **Keep `product_access` as the truth and sync it from the plan.** A job or
   trigger rewrites rows when a plan changes. Pros: no read-site changes.
   Cons: a second copy of one fact with a sync that can be down, behind, or
   never have run — rule 10, and the exact shape that produced the drift.
2. **Derive at read time from plan + overrides; `product_access` becomes
   history.** Pros: one implementation of the fact, no sweeper, the override
   table's own contract ("expiry is evaluated in the read query") already
   assumes this. Cons: the read and write sites change, and without a
   backfill the switch changes what every person sees.
3. **Derive, and also materialise a view for reporting.** Pros: reporting
   convenience. Cons: a view is still a copy if anyone writes to it; deferred
   until somebody asks for a report.

## Decision

Option 2, with a backfill that makes the day of the switch change nothing
anyone can see.

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
      FROM (SELECT plan_id
              FROM core.subscriptions
             WHERE tenant_id = p_tenant
             ORDER BY started_at DESC
             LIMIT 1) s
      JOIN core.plans p ON p.id = s.plan_id
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

**Why existence, not availability.** On production `is_available` says
Connect is not available while six people use it. Availability is a
catalogue flag — what the console offers for new grants — not a reason to
take a product away from someone who holds it. The `EXISTS` keeps codes that
are not products at all (`payroll`, `sheet`, `word`) out. Whether `connect`
and `calendar` should read "available" is a data correction for Amit,
separate from this record.

**Which subscription.** The latest by `started_at`, whatever its status —
what the console does today. Whether a cancelled or past-due subscription
still grants products is a product decision for Amit; this function is the
one place that changes when he makes it.

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

**Day one changes nothing: the backfill.** Before any read site switches, one
idempotent data migration writes, for every active person:

- a user-level `revoke` for each product the function would give them that
  they do not hold today, and
- a user-level `grant` for each product they hold today that the function
  would not give them,

with `reason = '0002 backfill: access as it was when entitlement became
derived'` and `granted_by` set to a fixed system-actor id named in the
migration. Inserts use `ON CONFLICT ... DO NOTHING` against the live-row
unique index, and a second run inserts nothing, because after the first run
the function already agrees with today. Every backfilled row is an ordinary
override: visible, attributable, and withdrawable one at a time.

People in the two organisations without a subscription keep Mail through
their backfilled grants, but anyone added there after the switch gets
nothing. Those two organisations need a subscription, and which plan is
Amit's decision.

**Plan arrays become the promise.** After the switch a new person gets their
organisation's plan. Every plan on production includes Hire and People today,
and the Hire & People lane is on hold. Amit decides what each plan includes
before the switch; the backfill protects only the people who exist on the
day.

**The read and write sites.** `MeAsync` returns the function's result. The
admin user list calls it once per page (a lateral join, not per user).
`CreateAsync` and `BulkCreateAsync` stop writing `product_access`; when the
operator ticks a product the plan does not include they write a `grant`
override, and when they untick one it does include they write a `revoke`,
both with `granted_by` and `reason`. `OffboardAsync` and `DeleteAsync` write
user-level revokes instead of setting `revoked_at`, so the record of what was
taken away survives. The signup copy in `SignupEndpoints.cs` is deleted:
every plan on production includes `mail`, so the owner derives it.
`product_access` stops being written; it is not dropped (rule 2, additive).

**The shadowed-grant warning.** When the create path is about to write a
user-level `grant` and a live org-level `revoke` exists for the same product,
the API still writes the row (the operator may be preparing for the hold to
lift) but returns `shadowedBy: ["<product>"]` in the response, and the admin
user screen renders a warning beside that product: *"Granted, but the
organisation has this product on hold. The person will not see it until the
hold is withdrawn."* The user list shows the same product with a "held"
marker, so the state is visible on every screen that shows the grant, not
only at the moment of granting.

## What proves it

**The function.** A psql check under `tests/isolation/`, run by CI, against a
scratch tenant arranged to have: a subscription to a plan `{mail, drive}`; an
org-level `revoke` on `drive`; a user-level `grant` on `connect` for one
person; a user-level `revoke` on `mail` for another.

| Person | Expected `effective_products` |
|---|---|
| owner (no user rows) | `{mail}` — drive removed by the org revoke |
| the person with the connect grant | `{mail, connect}` |
| the person with the mail revoke | `{}` |
| anyone, after a user-level `grant` on `drive` | still no `drive` — the org revoke is final |
| anyone, after `withdrawn_at` is set on the org revoke | `drive` returns |
| anyone, with a grant whose `expires_at` is in the past | the grant does not count |

Red first: run the check against a function with the first `NOT EXISTS`
deleted, and watch the fourth row fail.

**The switch is a no-op.** The measurement query behind the table above, run
after the backfill on a restored copy of production and then on production,
must answer "people whose products change: 0". Before the backfill it
answers 13, so the check has already been seen red.

## Consequences

Easier: one place answers "what does this person have"; a plan change takes
effect on the next request; the shadowed-grant case cannot be silent.
Harder: every plan edit immediately changes what every new person in every
organisation on that plan gets; the admin screens must express "on hold"
states they never had to; `product_access` history stops growing, so a
report that reads it needs the function instead. Accepted: two extra
`NOT EXISTS` per read, on tables with a covering partial index.

## Revisit when

A product needs a per-request gate (an endpoint that must refuse a call
rather than hide a tile). Then the function moves behind a cached
per-request claim, and this record is superseded.

# 0002 — Entitlement is derived from the plan, not copied into rows

**Status:** proposed
**Date:** 2026-09-13

## Context

Today a person's products are the live rows in `core.product_access`
(`revoked_at IS NULL`). Those rows are copies of what the plan said at the
moment somebody wrote them, and nothing keeps them equal to
`core.plans.included_products`. The CTO ruled on 9 Sept that entitlement is
**derived**: plan products, plus grants, minus revokes; on 13 Sept that an
organisation-level revoke is an **absolute veto** over a user-level grant.
`core.entitlement_overrides` (20260910) exists for the exceptions; nothing
reads it yet.

Every place that consumes entitlement today, from a grep of `apps/api` on
13 Sept (file, what it does):

| Site | Today |
|---|---|
| `Modules/Auth/Endpoints/AuthEndpoints.cs`, `MeAsync` | returns `products` for the signed-in person from `product_access`; the web dashboard and the mobile tiles read this |
| `Modules/Admin/Endpoints/UserEndpoints.cs`, the user list | joins `product_access` per user to show who has what |
| `Modules/Admin/Endpoints/UserEndpoints.cs`, create and update user | **writes** `product_access` rows from a `products` array; `wantsMailbox = products.Contains("mail")` decides whether a mailbox is created |
| `Modules/Admin/Endpoints/UserEndpoints.cs`, delete and suspend | sets `revoked_at` on the person's rows |
| `Modules/Core/Endpoints/SignupEndpoints.cs`, the org-owner insert | writes one `mail` row for the new owner — the copy the 13 Sept list says to delete |

There is no per-request gate: no endpoint refuses a call because the caller
lacks a product. Entitlement only decides what is shown and whether a mailbox
exists. That keeps this change small.

## Options

1. **Keep `product_access` as the truth and sync it from the plan.** A job or
   trigger rewrites rows when a plan changes. Pros: no read-site changes.
   Cons: a second copy of one fact with a sync that can be down, behind, or
   never have run — rule 10, and the exact shape that produced the drift.
2. **Derive at read time from plan + overrides; `product_access` becomes
   history.** Pros: one implementation of the fact, no sweeper, the override
   table's own contract ("expiry is evaluated in the read query") already
   assumes this. Cons: three read sites change, two write sites change, and
   the plan arrays must be right first.
3. **Derive, and also materialise a view for reporting.** Pros: reporting
   convenience. Cons: a view is still a copy if anyone writes to it; deferred
   until somebody asks for a report.

## Decision

Option 2. One SQL function is the single implementation, called from every
read site.

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
      FROM core.tenants t JOIN core.plans p ON p.id = t.plan_id
     WHERE t.id = p_tenant
),
granted AS (
    SELECT product_code FROM plan
    UNION
    SELECT product_code FROM live WHERE mode = 'grant'
)
SELECT g.product_code
  FROM granted g
  JOIN core.products pr ON pr.code = g.product_code AND pr.is_available
 WHERE NOT EXISTS (SELECT 1 FROM live r                       -- org revoke: final
                    WHERE r.user_id IS NULL AND r.mode = 'revoke'
                      AND r.product_code = g.product_code)
   AND NOT EXISTS (SELECT 1 FROM live r                       -- user revoke
                    WHERE r.user_id = p_user AND r.mode = 'revoke'
                      AND r.product_code = g.product_code);
```

**How "org revoke is final" is expressed:** the first `NOT EXISTS` removes a
product whenever an organisation-level revoke is live, and it runs against
`granted`, which already includes user-level grants. A user grant therefore
never re-adds what an org revoke removed. The second `NOT EXISTS` is the
user-level revoke. A user-level grant and a user-level revoke for the same
product cannot both be live: the unique index `ux_entitlement_overrides_live`
covers `(tenant, user, product)` for un-withdrawn rows, so the second one is
refused at insert. Revoke beats grant only across scopes, and only downward.

**The read sites** call the function: `MeAsync` returns its result;
the admin user list calls it once per page (a lateral join, not per user);
the admin create/update path stops writing `product_access` and instead
writes an override row when the operator ticks a product the plan does not
include (mode `grant`, `granted_by`, `reason`) or unticks one it does
(mode `revoke`). The signup copy in `SignupEndpoints.cs` is deleted:
`mail` is in every plan's `included_products`, so the owner derives it.
`product_access` stops being written; it is not dropped (rule 2, additive).

**The shadowed-grant warning.** When the create/update path is about to
write a user-level `grant` and a live org-level `revoke` exists for the same
product, the API still writes the row (the operator may be preparing for the
hold to lift) but returns `shadowedBy: ["<product>"]` in the response, and
the admin user screen renders a warning beside that product: *"Granted, but
the organisation has this product on hold. The person will not see it until
the hold is withdrawn."* The user list shows the same product with a
"held" marker, so the state is visible on every screen that shows the grant,
not only at the moment of granting.

**Plan arrays first.** `Enterprise` still carries `payroll`, `sheet` and
`word` from the 0000 seed; 0028 removed the products, nothing corrected the
plans. Whether Enterprise still promises those products is Amit's decision
(product), and the one-line migration that fixes the array waits on it. The
function above already hides them (the `is_available` join), so the read
path is safe either way.

## What proves it

A psql check under `tests/isolation/` run by CI, against a scratch tenant
arranged to have: plan `{mail, drive}`; an org-level `revoke` on `drive`; a
user-level `grant` on `connect` for one person; a user-level `revoke` on
`mail` for another.

| Person | Expected `effective_products` |
|---|---|
| owner (no user rows) | `{mail}` — drive removed by the org revoke |
| the person with the connect grant | `{mail, connect}` |
| the person with the mail revoke | `{}` |
| anyone, after a user-level `grant` on `drive` | still no `drive` — the org revoke is final |
| anyone, after `withdrawn_at` is set on the org revoke | `drive` returns |
| anyone, with a grant whose `expires_at` is in the past | the grant does not count |

And the red first: run the check against a function with the first
`NOT EXISTS` deleted, and watch the fourth row fail.

## Consequences

Easier: one place answers "what does this person have"; a plan change takes
effect on the next request; the shadowed-grant case cannot be silent.
Harder: the admin screens must express "on hold" states they never had to;
`product_access` history stops growing, so a report that reads it needs the
function instead. Accepted: two extra `NOT EXISTS` per read, on tables with
a covering partial index.

## Revisit when

A product needs a per-request gate (an endpoint that must refuse a call
rather than hide a tile). Then the function moves behind a cached
per-request claim, and this record is superseded.

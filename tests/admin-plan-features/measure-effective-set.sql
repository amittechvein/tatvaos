-- ============================================================================
--  Mr. Singh, 26 Sept 2026 (decision 0002's terms): count the organisations
--  whose EFFECTIVE set of features differs before 20260926-plan-features.sql
--  and after it. It must be zero.
--
--  BEFORE the migration nothing gates a feature on a plan: no code reads
--  plans.included_products (checked 26 Sept), so every organisation's
--  effective set is every feature, limited only by its own switches, which
--  the migration does not touch. AFTER, the set is what PlanEntitlements
--  derives; this query mirrors its switch rule exactly:
--    live revoke -> no; live grant -> yes; keeps_everything -> yes;
--    no plan -> no; included_features NULL -> product in plan (or
--    platform-wide); else listed AND product in plan.
--
--  Run AFTER the migration. Every organisation that existed before it must
--  show zero lost features.
-- ============================================================================
WITH sub AS (
    SELECT DISTINCT ON (s.tenant_id) s.tenant_id, s.plan_id
      FROM core.subscriptions s
     ORDER BY s.tenant_id, s.started_at DESC
),
eff AS (
    SELECT t.id AS tenant_id, f.code,
           CASE
             WHEN o.mode = 'revoke' THEN false
             WHEN o.mode = 'grant'  THEN true
             WHEN t.keeps_everything THEN true
             WHEN p.id IS NULL THEN false
             WHEN p.included_features IS NULL
               THEN f.product_code IS NULL OR f.product_code = ANY (p.included_products)
             ELSE (f.product_code IS NULL OR f.product_code = ANY (p.included_products))
                  AND f.code = ANY (p.included_features)
           END AS included_after
      FROM core.tenants t
      CROSS JOIN core.features f
      LEFT JOIN sub ON sub.tenant_id = t.id
      LEFT JOIN core.plans p ON p.id = sub.plan_id
      LEFT JOIN core.feature_overrides o
             ON o.tenant_id = t.id AND o.feature_code = f.code
            AND o.withdrawn_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now())
     WHERE f.kind = 'switch'
)
SELECT count(*) FILTER (WHERE lost > 0) AS organisations_whose_set_changed,
       count(*)                          AS organisations_checked,
       coalesce(sum(lost), 0)            AS features_lost_in_total
  FROM (SELECT tenant_id, count(*) FILTER (WHERE NOT included_after) AS lost
          FROM eff GROUP BY tenant_id) x;

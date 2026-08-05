-- ============================================================================
--  One-off: remove demo seed data from a CLOUD database
-- ============================================================================
--
--  The early deploys applied local/postgres/init/*.sql wholesale, which
--  included the demo seed - so staging's real database contains ABC School,
--  demo mailboxes on techvein.local, and a demo message, all with development
--  password hashes. deploy.sh now skips seed files; this removes what those
--  earlier runs left behind.
--
--  WHAT IT KEEPS, DELIBERATELY:
--    - the Techvein tenant row     the platform administrator belongs to it
--    - tech_ai2@techvein.com       the bootstrap admin
--    - Techvein's subscription and storage pool
--
--  Deleting the Techvein tenant would cascade away the only account that can
--  sign in.
--
--  Run once per cloud environment. Idempotent - re-running deletes nothing
--  that is already gone.
-- ============================================================================

BEGIN;

-- The demo second tenant, whole. Domains, users, mailboxes, folders, messages
-- and subscriptions all cascade from the tenant row.
DELETE FROM core.tenants
 WHERE id = '22222222-2222-2222-2222-222222222222'   -- ABC School
   AND name = 'ABC School';                          -- belt and braces: never
                                                     -- delete a real customer
                                                     -- who somehow got this id

-- Techvein's DEMO domain. Cascades its mailboxes (amit@, hr@, support@) and
-- the demo message. The tenant itself stays.
DELETE FROM core.domains
 WHERE fqdn = 'techvein.local';

-- The seeded people. Fixed UUIDs from the seed file, so a real person created
-- later can never be caught by this.
DELETE FROM core.users
 WHERE id IN ('d1111111-1111-1111-1111-111111111111',   -- seeded amit@
              'd1111111-1111-1111-1111-111111111112',   -- seeded hr@
              'd1111111-1111-1111-1111-111111111199');  -- seeded former.employee@

-- Tester-seed tenants, if seed-testers.sql ever ran here.
DELETE FROM core.tenants
 WHERE id IN ('33333333-3333-3333-3333-333333333333',   -- City Clinic
              '44444444-4444-4444-4444-444444444444')   -- Rival Corp
   AND name IN ('City Clinic', 'Rival Corp');

COMMIT;

-- What remains: it should be the operator tenant, the platform admin, and any
-- REAL organisations created since.
SELECT t.name AS tenant, t.status, t.origin,
       (SELECT count(*) FROM core.users u WHERE u.tenant_id = t.id)   AS users,
       (SELECT count(*) FROM core.domains d WHERE d.tenant_id = t.id) AS domains
  FROM core.tenants t
 ORDER BY t.created_at;

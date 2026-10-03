-- ============================================================================
--  LOCAL AND CI ONLY — the filename contains "seed", so deploy.sh skips it.
--  Depends on 20260926-a-personal-join.sql (core.tenants.kind), which sorts
--  before it.
--
--  A personal house to sign up into, on a .local domain nobody can own. On
--  production the house is created deliberately, at switch-on, on whatever
--  domain Mr. Singh rules personal addresses live on — never by a file.
--
--  1 GB each, per_user: the Free figure from the build plan §2.3, until
--  Part A's per-person plans replace this pool-wide default.
-- ============================================================================

INSERT INTO core.tenants (id, name, type, kind, status, origin, country) VALUES
    ('99999999-9999-9999-9999-999999999999', 'TatvaOS Personal', 'other',
     'personal_house', 'active', 'onboarded', 'India')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.domains (id, tenant_id, fqdn, type, is_active,
                          ownership_verified_at, mx_verified_at) VALUES
    ('a9999999-9999-9999-9999-999999999999',
     '99999999-9999-9999-9999-999999999999',
     'personal.local', 'primary', true, now(), now())
ON CONFLICT (fqdn) DO NOTHING;

INSERT INTO core.storage_pools (tenant_id, storage_model, total_bytes, per_user_quota_bytes) VALUES
    ('99999999-9999-9999-9999-999999999999', 'per_user', 0, 1073741824)  -- 1 GB each
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO core.storage_allocations (tenant_id, product_code, allocated_bytes)
SELECT '99999999-9999-9999-9999-999999999999', 'mail', NULL
WHERE NOT EXISTS (SELECT 1 FROM core.storage_allocations
                  WHERE tenant_id = '99999999-9999-9999-9999-999999999999'
                    AND product_code = 'mail');

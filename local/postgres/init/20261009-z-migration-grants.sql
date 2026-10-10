-- ============================================================================
--  migration.grants - an organisation's grant of Google access to TatvaOS
--  (decision 0019 §1, proposed)
-- ============================================================================
--
--  Depends on 20261009-migration-jobs.sql (same date, sorts first: "m" < "z").
--
--  THE MODEL (0019 §1). TatvaOS owns ONE Google service account. A customer's
--  admin authorises its client ID, with read-only scopes, in their own Google
--  Admin console, and removes it when the migration is done. No customer key
--  is ever handled. This table records, per organisation, that access was
--  granted (and checked - the API lists the customer's directory as the admin
--  named before recording it) and when the admin says it was removed.
--
--  A migration job is only ever claimed for an organisation with an ACTIVE
--  grant: migration.job_tenants() below - which REPLACES the version in
--  20261009-migration-jobs.sql on every deploy, because it now reads this
--  table, which that file cannot see - and the credential provider both
--  check. Removing the grant here also cancels the organisation's unfinished
--  jobs (the API does that in the same transaction).
--
--  Only the synthetic (Development-only) source is exempt: it reads nothing.
--
--  Additive and re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS migration.grants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    source          text NOT NULL DEFAULT 'google_workspace' CHECK (source IN ('google_workspace')),

    -- The customer's Google domain, and the admin the grant was checked as.
    google_domain   text NOT NULL CHECK (length(btrim(google_domain)) BETWEEN 1 AND 253),
    google_admin    text NOT NULL CHECK (length(btrim(google_admin)) BETWEEN 3 AND 320),
    -- Which of OUR service accounts was authorised (its client ID), so a key
    -- rotation that changes it is visible as "this grant is for the old one".
    client_id       text NOT NULL CHECK (length(client_id) <= 64),

    granted_at      timestamptz NOT NULL DEFAULT now(),
    granted_by      uuid,
    -- When the admin told us the grant was removed in Google's console. Ours
    -- to record; Google's to enforce.
    revoked_at      timestamptz,
    revoked_by      uuid,

    CONSTRAINT fk_migration_grant_granted_by FOREIGN KEY (tenant_id, granted_by)
        REFERENCES core.users (tenant_id, id) ON DELETE SET NULL (granted_by),
    CONSTRAINT fk_migration_grant_revoked_by FOREIGN KEY (tenant_id, revoked_by)
        REFERENCES core.users (tenant_id, id) ON DELETE SET NULL (revoked_by),
    -- Who revoked it, only once it is revoked (revoked_by may later be NULL:
    -- that person deleted, ON DELETE SET NULL above).
    CONSTRAINT ck_migration_grant_revoked CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

-- One ACTIVE grant per organisation; old ones stay as the record.
CREATE UNIQUE INDEX IF NOT EXISTS ux_migration_grants_active
    ON migration.grants (tenant_id, source) WHERE revoked_at IS NULL;

COMMENT ON TABLE migration.grants IS
    'Decision 0019 §1: an organisation''s grant of read-only Google access to TatvaOS''s service account. Holds no key.';

GRANT SELECT, INSERT, UPDATE ON migration.grants TO tatvaos_app;

ALTER TABLE migration.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.grants;
CREATE POLICY tenant_isolation ON migration.grants
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- migration.job_tenants(), now requiring an active grant ----------------
--  Supersedes the definition in 20261009-migration-jobs.sql (this file runs
--  after it on every deploy). Same contract: organisation ids only.
CREATE OR REPLACE FUNCTION migration.job_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, migration, core, pg_temp
AS $$
    SELECT DISTINCT j.tenant_id
      FROM migration.jobs j
      JOIN core.tenants t ON t.id = j.tenant_id
     WHERE t.status IN ('active', 'trial')
       AND j.target_user_id IS NOT NULL
       AND (   (j.state = 'pending' AND j.next_attempt_at <= now())
            OR (j.state = 'running' AND j.lease_expires_at <  now()))
       AND (   j.source = 'synthetic'
            OR EXISTS (SELECT 1 FROM migration.grants g
                        WHERE g.tenant_id = j.tenant_id AND g.source = j.source AND g.revoked_at IS NULL))
$$;

REVOKE ALL ON FUNCTION migration.job_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION migration.job_tenants() TO tatvaos_app;

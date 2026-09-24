-- ============================================================================
--  TatvaOS Hire — automatic deletion of candidates (retention)
-- ============================================================================
--
--  Depends on 20260924-d-hire-candidates.sql (same date, sorts after it).
--
--  Amit's decision, 24 September 2026:
--    * rejected and withdrawn candidates are kept SIX MONTHS after the
--      decision, then deleted automatically;
--    * each organisation may SHORTEN that period, never lengthen it;
--    * keeping someone longer (a talent pool) needs that candidate's
--      recorded consent;
--    * this must exist before the public careers portal opens (0010).
--  A lawyer is to confirm the six months (through Mr. Singh) before the
--  portal goes public.
--
--  Mr. Singh's rulings on this file, 24 September 2026 (PR 271):
--    * SHORTENING STATES WHAT IT WILL DESTROY FIRST. The API shows how many
--      candidates a shorter period will delete, and refuses to schedule it
--      unless the caller confirms that exact number — hire.due_candidates()
--      below is the one definition both the preview and the sweep use, so
--      the number shown is the number deleted.
--    * SHORTENING WAITS SEVEN DAYS, visibly and cancellably:
--      pending_retention_days / pending_effective_at. The sweep promotes a
--      pending period only once its date has passed. Lengthening (the safe
--      direction) applies at once and cancels any pending shortening.
--    * THE DELETION IS LOGGED — not the data, the event: how many, when,
--      under which period, and who set that period when.
--    * THE CLOCK IS NOT RESTARTED BY SYSTEM ACTIVITY. A candidate never put
--      forward is measured from last_edited_at, which ONLY a person saving
--      their profile writes (the API's create and update). updated_at stays
--      a plain "row changed" column that a re-index, a migration or a bulk
--      job may touch without keeping anyone's data alive.
--
--  WHO IS ERASED — a candidate is due when ALL of these hold:
--    1. no application of theirs is active;
--    2. EITHER they have applications, and the latest decision (rejected /
--       withdrawn, decided_at) is older than the organisation's period;
--       OR they have none, and last_edited_at is older than the period;
--    3. no talent-pool consent is running (talent_pool_until null or past).
--
--  HOW: hire.sweep_expired_candidates(), SECURITY DEFINER, called by
--  HireRetentionWorker. Same DELETE as an admin's erase (#267): applications
--  and history go by cascade.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

-- ---- per-organisation Hire settings -----------------------------------------
CREATE TABLE IF NOT EXISTS hire.settings (
    tenant_id       uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- Days after the last decision. 180 is the ceiling: an organisation may
    -- shorten, never lengthen (longer needs the candidate's consent). 30 is
    -- the floor: a slip must not erase last week's candidates.
    retention_days  integer NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 180),
    updated_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- A shortening waits seven days (Mr. Singh). All four set together or none.
ALTER TABLE hire.settings ADD COLUMN IF NOT EXISTS pending_retention_days integer;
ALTER TABLE hire.settings ADD COLUMN IF NOT EXISTS pending_effective_at   timestamptz;
ALTER TABLE hire.settings ADD COLUMN IF NOT EXISTS pending_requested_by   uuid;
ALTER TABLE hire.settings ADD COLUMN IF NOT EXISTS pending_requested_at   timestamptz;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_settings_pending_whole'
                      AND conrelid = 'hire.settings'::regclass) THEN
        ALTER TABLE hire.settings ADD CONSTRAINT ck_settings_pending_whole CHECK (
            (pending_retention_days IS NULL) = (pending_effective_at IS NULL)
            AND (pending_retention_days IS NULL) = (pending_requested_at IS NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_settings_pending_shorter'
                      AND conrelid = 'hire.settings'::regclass) THEN
        -- Only a SHORTENING is ever pending; lengthening applies at once.
        ALTER TABLE hire.settings ADD CONSTRAINT ck_settings_pending_shorter CHECK (
            pending_retention_days IS NULL
            OR (pending_retention_days BETWEEN 30 AND 180 AND pending_retention_days < retention_days));
    END IF;
END $$;
COMMENT ON TABLE hire.settings IS
    'Per-organisation Hire settings. retention_days 30..180, default 180 (Amit, 24 Sept 2026); '
    'a shorter period waits in pending_* for seven days (Mr. Singh, 24 Sept 2026).';

GRANT SELECT, INSERT, UPDATE ON hire.settings TO tatvaos_app;
ALTER TABLE hire.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire.settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hire.settings;
CREATE POLICY tenant_isolation ON hire.settings
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- when the decision was made ---------------------------------------------
ALTER TABLE hire.applications ADD COLUMN IF NOT EXISTS decided_at timestamptz;
UPDATE hire.applications SET decided_at = updated_at
 WHERE outcome <> 'active' AND decided_at IS NULL;
UPDATE hire.applications SET decided_at = NULL
 WHERE outcome = 'active' AND decided_at IS NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_application_decided_at'
                      AND conrelid = 'hire.applications'::regclass) THEN
        ALTER TABLE hire.applications ADD CONSTRAINT ck_application_decided_at
            CHECK ((outcome = 'active') = (decided_at IS NULL));
    END IF;
END $$;

-- ---- when a PERSON last edited the profile ----------------------------------
-- Written only by the API's candidate create and update. Nothing else may
-- write it; tests/hire/test-retention.sh proves a system touch to updated_at
-- does not save anyone.
ALTER TABLE hire.candidates ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;
UPDATE hire.candidates SET last_edited_at = updated_at WHERE last_edited_at IS NULL;
ALTER TABLE hire.candidates ALTER COLUMN last_edited_at SET DEFAULT now();
ALTER TABLE hire.candidates ALTER COLUMN last_edited_at SET NOT NULL;

-- ---- talent-pool consent ----------------------------------------------------
-- Written only with the candidate's own recorded consent (0010 §7). Nothing
-- in R1 writes it; the sweep honours it so the portal can.
ALTER TABLE hire.candidates ADD COLUMN IF NOT EXISTS talent_pool_until date;
ALTER TABLE hire.candidates ADD COLUMN IF NOT EXISTS talent_pool_consent_at timestamptz;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_candidate_talent_pool_consent'
                      AND conrelid = 'hire.candidates'::regclass) THEN
        ALTER TABLE hire.candidates ADD CONSTRAINT ck_candidate_talent_pool_consent
            CHECK (talent_pool_until IS NULL OR talent_pool_consent_at IS NOT NULL);
    END IF;
END $$;

-- ---- the one definition of "due" --------------------------------------------
-- SECURITY INVOKER: called by the API inside a tenant (row-level security
-- limits it to that organisation) to preview a change, and by the sweep as
-- the owner across all of them. p_at is the moment to judge at (the preview
-- asks about the day a pending change would apply); p_days, when given,
-- replaces the organisation's period for every row (the preview's "what if").
CREATE OR REPLACE FUNCTION hire.due_candidates(p_at timestamptz, p_days integer DEFAULT NULL)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, hire, pg_temp
AS $$
    SELECT c.id, c.tenant_id
      FROM hire.candidates c
      LEFT JOIN hire.settings s ON s.tenant_id = c.tenant_id
     WHERE (c.talent_pool_until IS NULL OR c.talent_pool_until < p_at::date)
       AND NOT EXISTS (SELECT 1 FROM hire.applications a
                        WHERE a.candidate_id = c.id AND a.outcome = 'active')
       AND (
             (EXISTS (SELECT 1 FROM hire.applications a WHERE a.candidate_id = c.id)
              AND (SELECT max(a.decided_at) FROM hire.applications a WHERE a.candidate_id = c.id)
                  < p_at - make_interval(days => coalesce(p_days, s.retention_days, 180)))
          OR
             (NOT EXISTS (SELECT 1 FROM hire.applications a WHERE a.candidate_id = c.id)
              AND c.last_edited_at < p_at - make_interval(days => coalesce(p_days, s.retention_days, 180)))
           );
$$;
REVOKE ALL ON FUNCTION hire.due_candidates(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hire.due_candidates(timestamptz, integer) TO tatvaos_app;

-- ---- the sweep ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION hire.sweep_expired_candidates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hire, core, pg_temp
AS $$
DECLARE
    total integer := 0;
    r record;
BEGIN
    -- 1. Pending shortenings whose seven days are up take effect now — and
    --    say so, naming who asked and when.
    FOR r IN
        UPDATE hire.settings s
           SET retention_days = s.pending_retention_days,
               updated_by     = s.pending_requested_by,
               updated_at     = now(),
               pending_retention_days = NULL, pending_effective_at = NULL,
               pending_requested_by = NULL, pending_requested_at = NULL
          FROM (SELECT tenant_id, retention_days AS old_days, pending_retention_days AS new_days,
                       -- Not "by"/"at": BY is reserved, and the record field
                       -- could not be read (found by the first test run).
                       pending_requested_by AS req_by, pending_requested_at AS req_at
                  FROM hire.settings
                 WHERE pending_effective_at IS NOT NULL AND pending_effective_at <= now()
                 FOR UPDATE) p
         WHERE s.tenant_id = p.tenant_id
        RETURNING s.tenant_id, p.old_days, p.new_days, p.req_by, p.req_at
    LOOP
        INSERT INTO core.audit_logs (tenant_id, product_code, actor_user_id, action, target_type, before_state, after_state)
        VALUES (r.tenant_id, 'hire', r.req_by, 'hire_settings.retention_applied', 'hire_settings',
                jsonb_build_object('retentionDays', r.old_days),
                jsonb_build_object('retentionDays', r.new_days, 'requestedAt', r.req_at));
    END LOOP;

    -- 2. Erase whoever is due, and log the EVENT per organisation: how many,
    --    under which period, set by whom and when. Never who was erased.
    FOR r IN
        WITH gone AS (
            DELETE FROM hire.candidates c
             USING hire.due_candidates(now()) d
             WHERE c.id = d.id
            RETURNING c.tenant_id
        )
        SELECT g.tenant_id, count(*)::int AS n,
               coalesce(s.retention_days, 180) AS days, s.updated_by AS set_by, s.updated_at AS set_at
          FROM gone g LEFT JOIN hire.settings s ON s.tenant_id = g.tenant_id
         GROUP BY g.tenant_id, s.retention_days, s.updated_by, s.updated_at
    LOOP
        INSERT INTO core.audit_logs (tenant_id, product_code, action, target_type, after_state)
        VALUES (r.tenant_id, 'hire', 'candidate.retention_erased', 'candidate',
                jsonb_build_object(
                    'erased', r.n,
                    'retentionDays', r.days,
                    'policy', CASE WHEN r.set_by IS NULL AND r.days = 180 THEN 'default' ELSE 'organisation' END,
                    'periodSetBy', r.set_by,
                    'periodSetAt', r.set_at));
        total := total + r.n;
    END LOOP;
    RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION hire.sweep_expired_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hire.sweep_expired_candidates() TO tatvaos_app;

DO $$
DECLARE
    pol int;
    fn  int;
BEGIN
    SELECT count(*) INTO pol FROM pg_policies
     WHERE schemaname = 'hire' AND tablename = 'settings' AND policyname = 'tenant_isolation';
    SELECT count(*) INTO fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'hire' AND p.proname = 'sweep_expired_candidates' AND p.prosecdef;
    RAISE NOTICE '';
    RAISE NOTICE '  hire.settings tenant_isolation: %; hire.sweep_expired_candidates security definer: %',
        CASE WHEN pol = 1 THEN 'present' ELSE 'MISSING' END,
        CASE WHEN fn = 1 THEN 'present' ELSE 'MISSING' END;
    IF pol <> 1 OR fn <> 1 THEN
        RAISE WARNING '  Hire retention is not set up as intended (policy %, function %)', pol, fn;
    END IF;
    RAISE NOTICE '';
END $$;

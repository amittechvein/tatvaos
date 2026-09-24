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
--    * this must exist before the public careers portal opens (decision
--      0010, proposed) — erasure on request alone was acceptable only while
--      there were no applicants from the public.
--  A lawyer is to confirm the six months (through Mr. Singh) before the
--  portal goes public. If the answer differs, the number to change is
--  DEFAULT_DAYS below and the check on hire.settings, together.
--
--  WHO IS ERASED, precisely — a candidate goes when ALL of these hold:
--    1. no application of theirs is active;
--    2. EITHER they have applications, and the most recent decision
--       (rejected / withdrawn) is older than the organisation's period;
--       OR they have none at all, and their profile has not been touched for
--       the period (added by hand, never put forward: nothing is being
--       considered, so there is no purpose to keep them for);
--    3. they have no talent-pool consent running (talent_pool_until is null
--       or already past).
--  Point 2's second half is this lane's reading of "not needed any longer",
--  flagged to Amit and Mr. Singh in the PR rather than assumed silently.
--
--  HOW: hire.sweep_expired_candidates(), SECURITY DEFINER, called daily by
--  HireRetentionWorker. The erasure is the same DELETE as an admin's erase
--  (#267): applications and history go by cascade. It writes one
--  core.audit_logs row per organisation per run with HOW MANY were erased —
--  never who — so the audit log cannot undo the erasure it records.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

-- ---- per-organisation Hire settings -----------------------------------------
CREATE TABLE IF NOT EXISTS hire.settings (
    tenant_id       uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- Days after the last decision. 180 is the ceiling: an organisation may
    -- shorten, never lengthen (longer needs the candidate's consent).
    retention_days  integer NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 180),
    updated_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hire.settings IS
    'Per-organisation Hire settings. retention_days: 30..180, default 180 (Amit, 24 Sept 2026).';

GRANT SELECT, INSERT, UPDATE ON hire.settings TO tatvaos_app;
ALTER TABLE hire.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire.settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hire.settings;
CREATE POLICY tenant_isolation ON hire.settings
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- when the decision was made ---------------------------------------------
-- updated_at moves on any edit; the clock that matters starts at the
-- decision. Set on reject/withdraw, cleared on reopen, by the API — and held
-- by a CHECK so an application cannot be decided without a date.
ALTER TABLE hire.applications ADD COLUMN IF NOT EXISTS decided_at timestamptz;
-- Rows that existed before this column (local databases only; nothing of
-- Hire is deployed) take their last update as the decision time.
UPDATE hire.applications SET decided_at = updated_at
 WHERE outcome <> 'active' AND decided_at IS NULL;
UPDATE hire.applications SET decided_at = NULL
 WHERE outcome = 'active' AND decided_at IS NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_application_decided_at'
                      AND conrelid = 'hire.applications'::regclass) THEN
        ALTER TABLE hire.applications ADD CONSTRAINT ck_application_decided_at
            CHECK ((outcome = 'active') = (decided_at IS NULL));
    END IF;
END $$;

-- ---- talent-pool consent ----------------------------------------------------
-- Written only with the candidate's own recorded consent (the careers
-- portal's optional tick, decision 0010 §7). Nothing in R1 writes it; the
-- sweep honours it so the portal can.
ALTER TABLE hire.candidates ADD COLUMN IF NOT EXISTS talent_pool_until date;
ALTER TABLE hire.candidates ADD COLUMN IF NOT EXISTS talent_pool_consent_at timestamptz;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'ck_candidate_talent_pool_consent'
                      AND conrelid = 'hire.candidates'::regclass) THEN
        -- No "keep until" without the moment consent was given.
        ALTER TABLE hire.candidates ADD CONSTRAINT ck_candidate_talent_pool_consent
            CHECK (talent_pool_until IS NULL OR talent_pool_consent_at IS NOT NULL);
    END IF;
END $$;

-- ---- the sweep ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION hire.sweep_expired_candidates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned, mandatory on SECURITY DEFINER.
SET search_path = hire, core, pg_temp
AS $$
DECLARE
    -- The organisation default. Amit, 24 Sept 2026; lawyer to confirm.
    default_days CONSTANT integer := 180;
    total integer := 0;
    r record;
BEGIN
    FOR r IN
        WITH due AS (
            SELECT c.id, c.tenant_id
              FROM hire.candidates c
              LEFT JOIN hire.settings s ON s.tenant_id = c.tenant_id
             WHERE (c.talent_pool_until IS NULL OR c.talent_pool_until < current_date)
               AND NOT EXISTS (SELECT 1 FROM hire.applications a
                                WHERE a.candidate_id = c.id AND a.outcome = 'active')
               AND (
                     -- decided, and the latest decision is past the period
                     (EXISTS (SELECT 1 FROM hire.applications a WHERE a.candidate_id = c.id)
                      AND (SELECT max(a.decided_at) FROM hire.applications a WHERE a.candidate_id = c.id)
                          < now() - make_interval(days => coalesce(s.retention_days, default_days)))
                  OR
                     -- never put forward, untouched for the period
                     (NOT EXISTS (SELECT 1 FROM hire.applications a WHERE a.candidate_id = c.id)
                      AND c.updated_at < now() - make_interval(days => coalesce(s.retention_days, default_days)))
                   )
        ),
        gone AS (
            DELETE FROM hire.candidates c USING due
             WHERE c.id = due.id
            RETURNING c.tenant_id
        )
        SELECT tenant_id, count(*)::int AS n FROM gone GROUP BY tenant_id
    LOOP
        -- How many, never who: the audit log must not undo the erasure.
        INSERT INTO core.audit_logs (tenant_id, product_code, action, target_type, after_state)
        VALUES (r.tenant_id, 'hire', 'candidate.retention_erased', 'candidate',
                jsonb_build_object('erased', r.n));
        total := total + r.n;
    END LOOP;
    RETURN total;
END;
$$;

REVOKE ALL ON FUNCTION hire.sweep_expired_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hire.sweep_expired_candidates() TO tatvaos_app;

-- Report what is here rather than assert it (house rule 6).
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

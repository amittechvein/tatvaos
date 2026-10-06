-- ============================================================================
--  Personal accounts, part D: limits in each product, the per-person AI
--  switch, and the trial (build plan personal-plans-build-plan.md §4, §5).
--
--  DEPENDS ON (sorts after, hence "zzz-"):
--    0031-user-storage.sql            core.user_storage() — REDEFINED here
--    20260926-z-personal-plans.sql    plans.audience, subscriptions.user_id,
--                                     core.ai_trials
--    20260926-zz-personal-isolation   (nothing directly; ordering only)
-- ============================================================================
--
--  1. STORAGE FOLLOWS THE PLAN. Every storage check on the platform — the
--     mail edge's policy service, Space uploads, attachments saved to Space —
--     asks core.user_storage(person) for the allowance. For a personal
--     account the allowance is now the person's PLAN (per_user_quota_bytes:
--     Free 1 GB, Basic 5, Premium 10), derived on every call, so an upgrade
--     or a downgrade is the answer at the very next check (§5) with nothing
--     copied and nothing to keep in step (decision 0002).
--
--     For everyone else it is EXACTLY what it was: core.personal_plan_quota
--     returns NULL for anyone outside the house, and COALESCE falls through
--     to users.storage_quota_bytes as before.
--
--     0031 defines core.user_storage() and re-runs on every deploy BEFORE
--     this file, so the definition that stands after a deploy is this one.
--     0031 carries a comment saying so. If this file is ever removed, 0031's
--     definition returns by itself — the fallback is the old behaviour.
--
--  2. core.personal_ai — a person's OWN AI switch (D3). The house can never
--     have organisation-level AI (20260926-zz-..., a CHECK); for a personal
--     account this row is the consent, confirmed by the person, and part of
--     what MeteredAiGateway asks.
--
--  3. core.ai_trials gains the two notices §5 promises: a reminder on day 12
--     and a note when it ends. The worker marks them so each is sent once.
--
--  Additive; re-runs on every deploy.
-- ============================================================================

-- ---- 1. Storage follows the plan -------------------------------------------
CREATE OR REPLACE FUNCTION core.personal_plan_quota(p_user uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    -- The person's live personal plan, or Personal Free when they have none
    -- (no row = Free, as EffectiveSettings derives it). NULL for anyone not
    -- in the personal house — the caller then uses the stored allowance.
    SELECT p.per_user_quota_bytes
      FROM core.users u
      JOIN core.tenants t ON t.id = u.tenant_id AND t.kind = 'personal_house'
      JOIN core.plans p
        ON p.audience = 'personal'
       AND p.id = COALESCE(
             (SELECT s.plan_id FROM core.subscriptions s
               WHERE s.user_id = u.id AND s.status IN ('trial', 'active', 'past_due')
               ORDER BY s.started_at DESC LIMIT 1),
             'b0000000-0000-0000-0000-000000000001'::uuid)
     WHERE u.id = p_user;
$$;
REVOKE ALL ON FUNCTION core.personal_plan_quota(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.personal_plan_quota(uuid) TO tatvaos_app;

CREATE OR REPLACE FUNCTION core.user_storage(p_user uuid)
RETURNS TABLE (quota_bytes bigint, used_bytes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, mail, space, pg_temp
AS $$
    SELECT COALESCE(core.personal_plan_quota(u.id), u.storage_quota_bytes),
           (SELECT COALESCE(SUM(x.used_bytes), 0)::bigint
              FROM core.user_storage_usage(p_user) x)
      FROM core.users u
     WHERE u.id = p_user;
$$;
REVOKE ALL ON FUNCTION core.user_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.user_storage(uuid) TO tatvaos_app;

COMMENT ON FUNCTION core.user_storage(uuid) IS
    'A person''s whole allowance (mail and files together) and what they use. '
    'Personal accounts: their plan''s per_user_quota_bytes (core.personal_plan_quota); '
    'everyone else: users.storage_quota_bytes. Redefined by 20260926-zzz-personal-limits.sql.';

-- ---- 2. A person's own AI switch --------------------------------------------
CREATE TABLE IF NOT EXISTS core.personal_ai (
    user_id       uuid PRIMARY KEY REFERENCES core.users(id) ON DELETE CASCADE,
    enabled       boolean NOT NULL DEFAULT false,
    -- When they confirmed that content goes to a service in the United States
    -- (§4.2). Kept when they switch off, so switching on again later is the
    -- same informed person, and the record of consent survives.
    confirmed_at  timestamptz,
    changed_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON core.personal_ai TO tatvaos_app;
COMMENT ON TABLE core.personal_ai IS
    'A personal account''s own AI consent (build plan D3). The house has no '
    'organisation-level AI (tenants_house_no_org_ai); this is the only switch.';

-- ---- 3. Trial notices ----------------------------------------------------------
ALTER TABLE core.ai_trials ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE core.ai_trials ADD COLUMN IF NOT EXISTS ended_notice_at timestamptz;

-- ---- 4. "Someone couldn't join: your plan allows N people" (§4.5) ----------
--  One row per person turned away because a personal host's meeting was
--  full. The host's lobby poll reads the recent ones and says so. Its own
--  table rather than a new meeting_events kind: widening that CHECK is a
--  constraint change, and this needs nothing but an insert.
CREATE TABLE IF NOT EXISTS connect.capacity_refusals (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id  uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    allowed     integer NOT NULL,          -- the host's limit at the time
    refused_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_connect_capacity_refusals_meeting
    ON connect.capacity_refusals (meeting_id, refused_at DESC);
ALTER TABLE connect.capacity_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.capacity_refusals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON connect.capacity_refusals;
CREATE POLICY tenant_isolation ON connect.capacity_refusals
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON connect.capacity_refusals TO tatvaos_app;

DO $$
DECLARE on_ai int; trials int;
BEGIN
    SELECT count(*) INTO on_ai  FROM core.personal_ai WHERE enabled;
    SELECT count(*) INTO trials FROM core.ai_trials WHERE ends_at > now();
    RAISE NOTICE 'personal limits: storage follows the plan; % person(s) with AI on; % trial(s) running.',
        on_ai, trials;
END $$;

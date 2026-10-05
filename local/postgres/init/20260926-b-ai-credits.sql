-- ============================================================================
--  AI credits — an organisation's AI allowance, decided by its plan.
--  Amit, 26 September 2026: "token count able to select plan wise and no of
--  user or pool token"; then: the plan decides, either way; customers see
--  AI CREDITS, not tokens; warn at 80%, stop at 100%.
-- ============================================================================
--
--  SAME SHAPE AS STORAGE. A plan already chooses storage per user or pooled
--  (core.plans.storage_model); AI credits choose the same way, so the plan
--  builder has one model to explain, not two:
--
--    ai_credit_model      'pooled'   → ai_credits_pooled for the organisation
--                         'per_user' → ai_credits_per_user × the organisation's
--                                      users, shared as one pool
--    NULL amount          → the plan sets no AI credit limit (the platform's
--                           token ceiling from PR 280 still applies)
--
--  core.tenants.ai_credits_override — the operator's exception for ONE
--  organisation: exactly this many credits a month, whatever the plan says.
--  NULL = follow the plan. 0 = none. (Entitlement is derived from the plan,
--  CTO 9 Sept; this is the one number that needs a per-organisation
--  exception, and it is audited where it is set.)
--
--  WHAT A CREDIT IS lives in code (AiCredits.CostOf), not here: Help me write
--  1, suggested replies 1, a summary 2, sorting one email 1, meeting minutes 5.
--  Tokens are still recorded underneath (core.ai_usage) — that is our cost;
--  credits are what a customer is sold and sees.
--
--  core.ai_credit_alerts — the 80 % / 100 % warnings about CREDITS. Its own
--  table rather than rows in ai_usage_alerts: that table is keyed by the
--  ceiling's number, so a credit allowance that happened to equal the token
--  ceiling would silently swallow one of the two warnings. Same RLS, same
--  append-only grants as its sibling.
--
--  Additive; re-runs are no-ops.
-- ============================================================================

ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS ai_credit_model text NOT NULL DEFAULT 'pooled';
ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS ai_credits_per_user integer;
ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS ai_credits_pooled integer;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_ai_credit_model_check'
                   AND conrelid = 'core.plans'::regclass) THEN
        ALTER TABLE core.plans ADD CONSTRAINT plans_ai_credit_model_check
            CHECK (ai_credit_model IN ('per_user', 'pooled'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_ai_credits_nonneg_check'
                   AND conrelid = 'core.plans'::regclass) THEN
        ALTER TABLE core.plans ADD CONSTRAINT plans_ai_credits_nonneg_check
            CHECK (coalesce(ai_credits_per_user, 0) >= 0 AND coalesce(ai_credits_pooled, 0) >= 0);
    END IF;
END $$;

ALTER TABLE core.tenants ADD COLUMN IF NOT EXISTS ai_credits_override integer;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_ai_credits_override_check'
                   AND conrelid = 'core.tenants'::regclass) THEN
        ALTER TABLE core.tenants ADD CONSTRAINT tenants_ai_credits_override_check
            CHECK (ai_credits_override IS NULL OR ai_credits_override >= 0);
    END IF;
END $$;

COMMENT ON COLUMN core.tenants.ai_credits_override IS
    'The operator''s exception: exactly this many AI credits a month for this organisation, '
    'whatever its plan says. NULL = follow the plan; 0 = none. Audited where it is set.';

CREATE TABLE IF NOT EXISTS core.ai_credit_alerts (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    month       date NOT NULL,              -- first day of the month, India time
    level       smallint NOT NULL CHECK (level IN (80, 100)),
    -- The allowance the warning was about; raising it mid-month warns again.
    allowance   integer NOT NULL CHECK (allowance > 0),
    sent_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, month, level, allowance)
);

ALTER TABLE core.ai_credit_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ai_credit_alerts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.ai_credit_alerts;
CREATE POLICY tenant_isolation ON core.ai_credit_alerts
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON core.ai_credit_alerts TO tatvaos_app;
REVOKE UPDATE, DELETE ON core.ai_credit_alerts FROM tatvaos_app;

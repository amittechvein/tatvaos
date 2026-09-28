-- ============================================================================
--  AI credit top-ups — extra credits for one organisation for ONE month.
--  Amit, 26 September 2026: "add on credit cost" → "build the top-up credits".
-- ============================================================================
--
--  A top-up is a pack sold on top of the plan: it adds credits to the month
--  it was added in (India time) and ends with that month, unused or not —
--  the way a pack is understood, and the only way the monthly 80 % / 100 %
--  rule stays simple. Allowance = (operator override, else the plan) + this
--  month's live top-ups. When neither plan nor override sets a limit there is
--  nothing to top up; the row is still kept (it records a sale).
--
--  A RECORD OF A SALE, so nothing is deleted. A mistaken top-up is WITHDRAWN
--  (withdrawn_at, withdrawn_by, withdraw_reason) and stops counting; the row
--  stays, which is what answers "we paid for 5,000 credits — where are they?"
--  added_by and reason are NOT NULL for the reason entitlement_overrides gives:
--  an exception nobody can attribute becomes permanent by default.
--
--  RLS like every AI table (tenant_isolation on app.tenant_id). The app may
--  insert and read, and update ONLY to withdraw — no DELETE.
--  Additive; re-runs are no-ops.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.ai_credit_topups (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    month            date NOT NULL,           -- first day of the month, India time
    credits          integer NOT NULL CHECK (credits > 0),
    price_inr        numeric(10,2) CHECK (price_inr IS NULL OR price_inr >= 0),
    reason           text NOT NULL CHECK (length(btrim(reason)) > 0),
    added_by         uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    withdrawn_at     timestamptz,
    withdrawn_by     uuid,
    withdraw_reason  text
);

CREATE INDEX IF NOT EXISTS ix_ai_credit_topups_tenant_month ON core.ai_credit_topups (tenant_id, month);

ALTER TABLE core.ai_credit_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ai_credit_topups FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.ai_credit_topups;
CREATE POLICY tenant_isolation ON core.ai_credit_topups
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON core.ai_credit_topups TO tatvaos_app;
REVOKE DELETE ON core.ai_credit_topups FROM tatvaos_app;

COMMENT ON TABLE core.ai_credit_topups IS
    'Extra AI credits for one organisation for one month (India time), on top of its plan or override. '
    'Withdrawn, never deleted: each row records a sale.';

-- ============================================================================
--  Decision 0009 - an administrator sets a person's recovery email
-- ============================================================================
--
--  Mr. Singh's rulings of 24 and 27 Sept 2026 (docs/decisions/0009). An
--  administrator who can write another person's recovery address can point it
--  at themselves, send a sign-in link, and own the account. So:
--
--    * the new address is CONFIRMED by a link mailed to it before it counts;
--    * replacing an existing address is HELD for 48 hours after confirmation:
--      the new address is not the recovery address until the hold ends, so
--      every emailed credential link (reset, sign-in link, invitation) still
--      goes to the confirmed OLD address - or is refused if there is none;
--    * empty -> value is the only change that is not held;
--    * the person gets a "this was not me" link valid for 30 days, which
--      reverts the change, never signs anyone in, and suspends that
--      administrator's ability to change recovery addresses until an owner
--      reviews it.
--
--  core.users.recovery_email changes ONLY when a change is applied. Until then
--  it holds the old address, so every existing reader (the three credential
--  paths, forgot-recovery's match) sees the old one without being taught
--  about holds.
--
--  Forced RLS on both tables. Three paths have no tenant - the confirmation
--  link, the "not me" link, and the job that ends holds - and each goes
--  through a SECURITY DEFINER function below (search_path pinned, pg_temp
--  last, EXECUTE for tatvaos_app only). Additive; re-runs harmlessly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.recovery_email_changes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    set_by_user_id      uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    old_email           text,
    old_verified_at     timestamptz,
    new_email           text NOT NULL,
    --  pending    : waiting for the new address to be confirmed
    --  held       : confirmed, replacing an existing address, hold running
    --  applied    : the new address is the recovery address
    --  reverted   : undone by the person ("this was not me")
    --  superseded : overtaken - a later change, or the person's own change
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'held', 'applied', 'reverted', 'superseded')),
    confirm_token_hash  text,
    confirm_sent_at     timestamptz,
    confirmed_at        timestamptz,
    hold_until          timestamptz,
    applied_at          timestamptz,
    not_me_token_hash   text,
    not_me_expires_at   timestamptz,
    reverted_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_recovery_change_held_has_hold CHECK (status <> 'held' OR hold_until IS NOT NULL)
);

-- One change in flight per person: a new one supersedes the old in the API.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recovery_change_in_flight
    ON core.recovery_email_changes (user_id) WHERE status IN ('pending', 'held');
CREATE INDEX IF NOT EXISTS ix_recovery_change_confirm
    ON core.recovery_email_changes (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_recovery_change_not_me
    ON core.recovery_email_changes (not_me_token_hash) WHERE not_me_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_recovery_change_hold
    ON core.recovery_email_changes (hold_until) WHERE status = 'held';

CREATE TABLE IF NOT EXISTS core.recovery_admin_suspensions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    admin_user_id       uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    change_id           uuid NOT NULL REFERENCES core.recovery_email_changes(id) ON DELETE CASCADE,
    suspended_at        timestamptz NOT NULL DEFAULT now(),
    cleared_by_user_id  uuid REFERENCES core.users(id) ON DELETE SET NULL,
    cleared_at          timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recovery_suspension_active
    ON core.recovery_admin_suspensions (admin_user_id) WHERE cleared_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON core.recovery_email_changes    TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE ON core.recovery_admin_suspensions TO tatvaos_app;

ALTER TABLE core.recovery_email_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.recovery_email_changes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.recovery_email_changes;
CREATE POLICY tenant_isolation ON core.recovery_email_changes
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE core.recovery_admin_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.recovery_admin_suspensions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.recovery_admin_suspensions;
CREATE POLICY tenant_isolation ON core.recovery_admin_suspensions
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
--  The three tenantless lookups. Each returns ids only.
-- ---------------------------------------------------------------------------

-- The confirmation link: which change, in which organisation. Pending only.
CREATE OR REPLACE FUNCTION core.recovery_change_for_confirm(p_hash text)
RETURNS TABLE (change_id uuid, tenant_id uuid, sent_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, core, pg_temp
AS $$
    SELECT c.id, c.tenant_id, c.confirm_sent_at
      FROM core.recovery_email_changes c
     WHERE c.confirm_token_hash = p_hash AND c.status = 'pending'
$$;

-- The "this was not me" link: only while it is valid and the change stands.
CREATE OR REPLACE FUNCTION core.recovery_change_for_not_me(p_hash text)
RETURNS TABLE (change_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, core, pg_temp
AS $$
    SELECT c.id, c.tenant_id
      FROM core.recovery_email_changes c
     WHERE c.not_me_token_hash = p_hash
       AND c.not_me_expires_at > now()
       AND c.status IN ('pending', 'held', 'applied')
$$;

-- Ends every hold that is due. The address is applied only if the person's
-- recovery address is still the one the hold was protecting; if they changed
-- it themselves meanwhile, their change wins and this one is superseded.
-- Returns how many were applied (the job logs it).
CREATE OR REPLACE FUNCTION core.apply_due_recovery_changes()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, pg_temp
AS $$
DECLARE
    n integer := 0;
    c record;
BEGIN
    FOR c IN
        SELECT * FROM core.recovery_email_changes
         WHERE status = 'held' AND hold_until <= now()
         FOR UPDATE SKIP LOCKED
    LOOP
        IF EXISTS (SELECT 1 FROM core.users u
                    WHERE u.id = c.user_id
                      AND coalesce(lower(u.recovery_email), '') = coalesce(lower(c.old_email), '')) THEN
            UPDATE core.users
               SET recovery_email = c.new_email,
                   recovery_email_verified_at = c.confirmed_at,
                   recovery_email_token_hash = NULL,
                   recovery_email_token_sent_at = NULL
             WHERE id = c.user_id;
            UPDATE core.recovery_email_changes SET status = 'applied', applied_at = now() WHERE id = c.id;
            n := n + 1;
        ELSE
            UPDATE core.recovery_email_changes SET status = 'superseded' WHERE id = c.id;
        END IF;
    END LOOP;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION core.recovery_change_for_confirm(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.recovery_change_for_not_me(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.apply_due_recovery_changes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.recovery_change_for_confirm(text) TO tatvaos_app;
GRANT EXECUTE ON FUNCTION core.recovery_change_for_not_me(text) TO tatvaos_app;
GRANT EXECUTE ON FUNCTION core.apply_due_recovery_changes() TO tatvaos_app;

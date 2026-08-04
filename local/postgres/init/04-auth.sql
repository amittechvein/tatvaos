-- ============================================================================
--  Core authentication
-- ============================================================================
--
--  ONE sign-in for every product. That is the promise Core makes, and this is
--  where it is kept.
--
--  The design constraint that shapes everything below: suspending a person
--  must stop them immediately. A long-lived JWT cannot be withdrawn — it stays
--  valid until it expires, whatever the database says. So a departed employee
--  with an 8-hour token keeps their access for 8 hours, which is exactly the
--  failure Core exists to prevent.
--
--  Hence short access tokens (15 minutes, not checked against the database)
--  plus a refresh token that IS checked, on every renewal. Worst case a
--  suspended person keeps working for fifteen minutes rather than a day.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Columns on core.users
--
--  ADD COLUMN IF NOT EXISTS rather than editing the CREATE TABLE above,
--  because CREATE TABLE IF NOT EXISTS does nothing at all on a database that
--  already has the table — the new columns would silently never appear on any
--  server that had been deployed before today.
-- ----------------------------------------------------------------------------

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS locked_until       timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

-- Forces a password change on first sign-in. Set when an admin creates the
-- account with a temporary password they can read off a screen.
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
--  Refresh tokens
-- ----------------------------------------------------------------------------
--
--  Stored HASHED. A refresh token is a bearer credential valid for two weeks;
--  a database backup or a SELECT through some future reporting endpoint should
--  not hand over working sessions. The same reasoning as passwords, for the
--  same reason.
--
--  SHA-256 rather than Argon2 here on purpose: these are 256-bit random
--  values, not human-chosen passwords, so there is nothing to brute-force and
--  no benefit to a slow hash. A slow hash on every token refresh would just be
--  a self-inflicted rate limit.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,

    token_hash  text NOT NULL UNIQUE,

    -- Rotation. Every refresh issues a new token and revokes the old one, so a
    -- stolen token is usable at most once before the theft becomes visible.
    replaced_by uuid REFERENCES core.refresh_tokens(id) ON DELETE SET NULL,

    -- Tokens issued from one login share a family id. When a revoked token is
    -- presented — which means someone is replaying a token that was already
    -- used — the whole family is killed. That is the standard defence: either
    -- the thief or the real user will be stopped, and the real user simply
    -- signs in again while the thief has nothing.
    family_id   uuid NOT NULL,

    issued_at   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    revoke_reason text,

    -- Context, for showing someone their active sessions and for incident
    -- response. Not used for validation: both are attacker-controlled.
    user_agent  text,
    ip_address  text
);

CREATE INDEX IF NOT EXISTS idx_refresh_user   ON core.refresh_tokens(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON core.refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON core.refresh_tokens(expires_at);

-- ----------------------------------------------------------------------------
--  RLS
-- ----------------------------------------------------------------------------
--
--  Forced, like every other content table. Note this means the refresh
--  endpoint has to set the tenant context BEFORE it can look a token up — and
--  it cannot know the tenant until it has looked the token up. That circle is
--  broken by a SECURITY DEFINER function below, which is the only place in the
--  system allowed to resolve a token without a tenant.
-- ----------------------------------------------------------------------------

ALTER TABLE core.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.refresh_tokens FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.refresh_tokens;
CREATE POLICY tenant_isolation ON core.refresh_tokens
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ----------------------------------------------------------------------------
--  Token resolution — the one deliberate hole, kept as small as possible
-- ----------------------------------------------------------------------------
--
--  A refresh request arrives with a token and nothing else. To find the tenant
--  we must read a row we are not yet allowed to read. Rather than granting the
--  application a way to bypass RLS in general, this function does exactly one
--  thing: given a token hash, return the tenant and user it belongs to.
--
--  It returns no token contents, cannot be used to enumerate (the input is a
--  256-bit hash), and returns nothing for a revoked or expired token. An
--  attacker who could call it freely still learns only whether a hash they
--  already possess is valid.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.resolve_refresh_token(p_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid, token_id uuid, family_id uuid, was_revoked boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT t.tenant_id, t.user_id, t.id, t.family_id, (t.revoked_at IS NOT NULL)
      FROM core.refresh_tokens t
     WHERE t.token_hash = p_hash
       AND t.expires_at > now();
$$;

REVOKE ALL ON FUNCTION core.resolve_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_refresh_token(text) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Grants. The mail edge gets nothing here — Postfix has no business reading
--  session tokens or lockout state.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON core.refresh_tokens TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Core authentication ready';
    RAISE NOTICE '    access tokens  15 minutes, not checked against the database';
    RAISE NOTICE '    refresh tokens 14 days, hashed, rotated, revocable';
    RAISE NOTICE '';
END $$;

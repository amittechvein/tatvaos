-- ============================================================================
--  Organisation API keys — a customer's own software adding their people
-- ============================================================================
--
--  Amit, 18 September 2026: an organisation must be able to admit people into
--  TatvaOS from their own software — a school's student-information system, an
--  HR package — instead of typing them into the console.
--
--  A SECOND KEY TABLE, AND WHY IT IS NOT mail.api_keys. The mail key is a mail
--  credential: it carries allowed_sender_addresses and lives in the mail
--  schema, which is Mail's lane. A key that creates PEOPLE is a core
--  credential, and conflating the two would mean a key handed to a website
--  contact form could also create accounts. Two tables, two scopes of blast
--  radius. The shape is deliberately identical otherwise — hash with its
--  scheme, visible prefix, revoke-not-delete, SECURITY DEFINER resolver —
--  because that shape is already trusted here and a second pattern would be a
--  second thing to get wrong.
--
--  THE HIGHEST-PRIVILEGE CREDENTIAL IN THE PRODUCT. A stolen mail key sends
--  mail. A stolen key with people:admit creates sign-in identities inside a
--  customer's organisation. So:
--    * scopes are explicit and stored per key, never implied;
--    * the API refuses to create org_admin or org_owner whatever the scope
--      says — a key cannot manufacture an administrator, which is the
--      privilege-escalation path an attacker would reach for first;
--    * every creation is written to core.audit_logs naming the key;
--    * last_used_at is written at most once an hour, as the OIDC applications
--      column is, because it is otherwise a write per call.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.api_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- Display only ("Student information system"). Never part of authentication.
    label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),

    -- '{SHA256}<hex>'. The scheme travels WITH the hash, as mail.api_keys
    -- learned: a store that relied on a default scheme verified every hash
    -- against the wrong algorithm for weeks and nobody noticed.
    key_hash    text NOT NULL,

    -- The head of the key, 'tvk_a1b2c3d4'. So a person can tell two keys apart
    -- in a list. Not a secret and not sufficient to authenticate.
    key_prefix  text NOT NULL,

    -- What this key may do. Explicit, never implied: an empty array can do
    -- nothing at all, which is the right answer for a key whose scopes were
    -- not set rather than "everything".
    scopes      text[] NOT NULL DEFAULT '{}',

    created_by  uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz,

    -- Written by the API at most once an hour per key. NULL means never used.
    last_used_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_core_api_keys_hash ON core.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS ix_core_api_keys_tenant
    ON core.api_keys (tenant_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE core.api_keys IS
    'Organisation API keys for a customer''s own software (Amit, 18 Sept 2026). '
    'Separate from mail.api_keys on purpose: this one can create people.';
COMMENT ON COLUMN core.api_keys.scopes IS
    'What the key may do, e.g. {people:admit}. Empty means nothing — never treat an unset scope list as permission.';

GRANT SELECT, INSERT, UPDATE ON core.api_keys TO tatvaos_app;

ALTER TABLE core.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.api_keys FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.api_keys;
CREATE POLICY tenant_isolation ON core.api_keys
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- the pre-tenant resolver -----------------------------------------------
-- The same circle every credential here breaks: row-level security needs a
-- tenant, and the tenant is not known until the key is found. SECURITY DEFINER,
-- one row, by the hash the caller already holds — exactly what
-- mail.resolve_api_key and core.resolve_refresh_token do.
--
-- Revoked keys are returned WITH the flag rather than hidden, so the API can
-- answer a revoked key and an unknown key identically without a second query.
DROP FUNCTION IF EXISTS core.resolve_api_key(text);
CREATE OR REPLACE FUNCTION core.resolve_api_key(p_hash text)
RETURNS TABLE (key_id uuid, tenant_id uuid, was_revoked boolean, scopes text[])
LANGUAGE sql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT k.id, k.tenant_id, (k.revoked_at IS NOT NULL), k.scopes
      FROM core.api_keys k
     WHERE k.key_hash = p_hash;
$$;
REVOKE ALL ON FUNCTION core.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_api_key(text) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Organisation API keys ready — RLS on, one SECURITY DEFINER resolver';
    RAISE NOTICE '';
END $$;

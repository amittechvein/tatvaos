-- ============================================================================
--  OpenID Connect provider — the four provider tables (decision 0004, stage 1)
-- ============================================================================
--
--  TatvaOS becomes an identity provider: a customer's other software signs
--  its users in with their TatvaOS account. OpenIddict runs the protocol
--  inside the API; these are its tables, shaped to OpenIddict's EF Core
--  entities (apps/api/Shared/Auth/Oidc/OidcEntities.cs) and named by the
--  DbContext's snake_case convention. A column here that EF does not expect,
--  or one it expects that is missing, compiles perfectly and fails on the
--  first query — stage 1's test creates a row through OpenIddict's manager
--  and reads it back for exactly that reason.
--
--  TENANCY — option (b), decided by the CTO 15 Sept 2026. Every table that
--  holds a tenant's rows is FORCE ROW LEVEL SECURITY, like every other table
--  here. The two lookups the protocol must do BEFORE a tenant is known —
--  the client by its id (authorize, token) and a token by its reference
--  (userinfo, introspection, revocation) — go through the two SECURITY
--  DEFINER resolvers at the bottom, the mail.resolve_api_key pattern: each
--  takes the key the caller already holds and returns that ONE row's
--  identity and tenant. The API then sets the tenant and reads the row
--  again under RLS. Nothing else bypasses RLS.
--
--  oidc_scopes is the one table without a tenant: openid, profile, email and
--  offline_access are the same four for every organisation, registered in
--  code. The table exists because OpenIddict's EF integration expects the
--  entity. Reference data; readable by the app role, RLS on with an
--  everyone-may-read policy so the FORCE stays consistent.
--
--  Revoke, never delete, for applications (revoked_at) — the mail.api_keys
--  posture. Tokens and authorizations ARE deleted by OpenIddict's prune, so
--  the app role holds DELETE on those two.
--
--  Additive, re-runnable. The signing key is NOT in this file or any table:
--  it lives in the oidckeys volume (stage 2).
-- ----------------------------------------------------------------------------

-- ---- applications ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.oidc_applications (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- OpenIddict's columns
    application_type          text,
    client_id                 text NOT NULL,
    client_secret             text,
    client_type               text,
    concurrency_token         text,
    consent_type              text,
    display_name              text,
    display_names             text,
    json_web_key_set          text,
    permissions               text,
    post_logout_redirect_uris text,
    properties                text,
    redirect_uris             text,
    requirements              text,
    settings                  text,
    -- ours
    created_by                uuid,
    created_at                timestamptz NOT NULL DEFAULT now(),
    revoked_at                timestamptz,
    client_secret_prefix      text,
    allowed_for_everyone      boolean NOT NULL DEFAULT false
);
-- Client ids are random and platform-wide unique: the resolver finds the
-- tenant FROM the client id, so two tenants must never share one.
CREATE UNIQUE INDEX IF NOT EXISTS ix_oidc_applications_client_id ON core.oidc_applications (client_id);
CREATE INDEX IF NOT EXISTS ix_oidc_applications_tenant
    ON core.oidc_applications (tenant_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE core.oidc_applications IS
    'OpenID Connect relying parties registered by organisation admins (decision 0004). '
    'client_secret is hashed by OpenIddict; client_secret_prefix is the only readable part. '
    'Revoke-not-delete.';

-- ---- authorizations -------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.oidc_authorizations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    application_id     uuid REFERENCES core.oidc_applications(id) ON DELETE CASCADE,
    concurrency_token  text,
    creation_date      timestamptz,
    properties         text,
    scopes             text,
    status             text,
    subject            text,
    type               text
);
CREATE INDEX IF NOT EXISTS ix_oidc_authorizations_app_subject
    ON core.oidc_authorizations (application_id, status, subject, type);
COMMENT ON TABLE core.oidc_authorizations IS
    'A person''s consent to an application for a scope set (decision 0004). '
    'subject is the user id, never the email.';

-- ---- scopes (reference data, no tenant) -----------------------------------
CREATE TABLE IF NOT EXISTS core.oidc_scopes (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    concurrency_token  text,
    description        text,
    descriptions       text,
    display_name       text,
    display_names      text,
    name               text NOT NULL,
    properties         text,
    resources          text
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_oidc_scopes_name ON core.oidc_scopes (name);

-- ---- tokens ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.oidc_tokens (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    application_id     uuid REFERENCES core.oidc_applications(id) ON DELETE CASCADE,
    authorization_id   uuid REFERENCES core.oidc_authorizations(id) ON DELETE CASCADE,
    concurrency_token  text,
    creation_date      timestamptz,
    expiration_date    timestamptz,
    payload            text,
    properties         text,
    redemption_date    timestamptz,
    -- For reference tokens OpenIddict stores the SHA-256 of the token here,
    -- never the token: the same hashed-lookup shape as every credential
    -- store in this schema.
    reference_id       text,
    status             text,
    subject            text,
    type               text
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_oidc_tokens_reference_id
    ON core.oidc_tokens (reference_id) WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_oidc_tokens_authorization ON core.oidc_tokens (authorization_id);
CREATE INDEX IF NOT EXISTS ix_oidc_tokens_app_subject
    ON core.oidc_tokens (application_id, status, subject, type);
COMMENT ON TABLE core.oidc_tokens IS
    'Codes, access, refresh and ID token records (decision 0004). Reference tokens '
    'are found by reference_id, a hash; the token itself is never stored.';

-- ---- grants ---------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE         ON core.oidc_applications  TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.oidc_authorizations TO tatvaos_app;
GRANT SELECT                         ON core.oidc_scopes         TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.oidc_tokens         TO tatvaos_app;

-- ---- row-level security ---------------------------------------------------
ALTER TABLE core.oidc_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.oidc_applications  FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.oidc_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.oidc_authorizations FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.oidc_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.oidc_tokens         FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.oidc_scopes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.oidc_scopes         FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON core.oidc_applications;
CREATE POLICY tenant_isolation ON core.oidc_applications
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON core.oidc_authorizations;
CREATE POLICY tenant_isolation ON core.oidc_authorizations
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON core.oidc_tokens;
CREATE POLICY tenant_isolation ON core.oidc_tokens
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Reference data: everyone may read, nobody but the owner may write.
DROP POLICY IF EXISTS reference_read ON core.oidc_scopes;
CREATE POLICY reference_read ON core.oidc_scopes FOR SELECT USING (true);

-- ---- the two pre-tenant resolvers -----------------------------------------
-- SECURITY DEFINER runs as the owner and does not see RLS. Each takes the key
-- the caller already holds and answers with ONE row's identity and tenant,
-- nothing more; the API sets the tenant and reads the row under RLS. Routing
-- any other read through a definer would switch RLS off for it — the
-- opposite of why option (b) was chosen.

-- Authorize and the token endpoint: which organisation owns this client id,
-- and is it still live. A revoked application answers as if it did not
-- exist, so both endpoints say invalid_client from the revoking commit.
DROP FUNCTION IF EXISTS core.resolve_oidc_client(text);
CREATE OR REPLACE FUNCTION core.resolve_oidc_client(p_client_id text)
RETURNS TABLE (application_id uuid, tenant_id uuid, was_revoked boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT a.id, a.tenant_id, (a.revoked_at IS NOT NULL)
      FROM core.oidc_applications a
     WHERE a.client_id = p_client_id;
$$;
REVOKE ALL ON FUNCTION core.resolve_oidc_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_oidc_client(text) TO tatvaos_app;

-- Userinfo, introspection and revocation: which organisation owns the token
-- presented, by the hash OpenIddict stored as reference_id.
DROP FUNCTION IF EXISTS core.resolve_oidc_token(text);
CREATE OR REPLACE FUNCTION core.resolve_oidc_token(p_reference_id text)
RETURNS TABLE (token_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT t.id, t.tenant_id
      FROM core.oidc_tokens t
     WHERE t.reference_id = p_reference_id;
$$;
REVOKE ALL ON FUNCTION core.resolve_oidc_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_oidc_token(text) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  OpenID Connect provider tables ready — RLS on all four, two';
    RAISE NOTICE '  SECURITY DEFINER resolvers for the pre-tenant lookups (0004, stage 1)';
    RAISE NOTICE '';
END $$;

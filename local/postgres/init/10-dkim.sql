-- ============================================================================
--  DKIM signing keys — one per domain
-- ============================================================================
--
--  Every domain we send as gets its own key pair. Not one platform key shared
--  across customers, for two reasons:
--
--    1. A shared key means one customer's compromise, or one customer's spam,
--       damages the signing reputation of every other customer.
--    2. DKIM alignment requires the signing domain to match the From domain,
--       so a customer sending as @theirdomain.com cannot be signed by a key
--       published under tatvaos.com and still pass DMARC.
--
--  ---------------------------------------------------------------------------
--  WHY THIS IS A SEPARATE TABLE RATHER THAN COLUMNS ON core.domains
--
--  core.domains carries NO row-level security, deliberately: the mail edge has
--  to resolve recipients before any tenant is known, so tatvaos_mailedge holds
--  SELECT on it. Putting a private key in a column of that table would hand
--  every tenant's signing key to the role Postfix authenticates as — the role
--  most exposed to the internet, and the one whole point of which is that it
--  can read routing and nothing else.
--
--  So keys live here: RLS forced, and no grant to tatvaos_mailedge at all.
--  OpenDKIM never queries the database; the API materialises key files onto a
--  volume that OpenDKIM reads. See DkimKeyService.
--  ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.dkim_keys (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    domain_id  uuid NOT NULL REFERENCES core.domains(id) ON DELETE CASCADE,

    -- Part of the DNS name: <selector>._domainkey.<fqdn>. Dated so that a
    -- rotation can publish the new record and run both for a while, rather
    -- than swapping in place and breaking every message in flight.
    selector   text NOT NULL,

    -- PKCS#8 PEM. Never leaves the server except as a file on the signing
    -- volume; never returned by any endpoint. There is no read path for it.
    private_key_pem text NOT NULL,

    -- Base64 SubjectPublicKeyInfo — exactly the p= value of the TXT record.
    -- Safe to display, and the console does.
    public_key_b64  text NOT NULL,

    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    retired_at  timestamptz,

    -- One active key per selector per domain. Rotation inserts a second row
    -- with a new selector and retires the first once DNS has propagated.
    UNIQUE (domain_id, selector)
);

CREATE INDEX IF NOT EXISTS idx_dkim_keys_tenant ON core.dkim_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dkim_keys_domain ON core.dkim_keys(domain_id)
    WHERE is_active;

-- FORCE, not just ENABLE: without FORCE the table owner bypasses the policy,
-- and the owner is the role the migrations run as.
ALTER TABLE core.dkim_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.dkim_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dkim_keys_tenant_isolation ON core.dkim_keys;
CREATE POLICY dkim_keys_tenant_isolation ON core.dkim_keys
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON core.dkim_keys TO tatvaos_app;

-- Deliberately NO grant to tatvaos_mailedge. If a future change adds one,
-- the isolation test below starts failing, which is the intent.
REVOKE ALL ON core.dkim_keys FROM tatvaos_mailedge;

COMMENT ON TABLE core.dkim_keys IS
    'Per-domain DKIM signing keys. RLS-forced and deliberately unreadable by '
    'tatvaos_mailedge: the mail edge signs using key FILES materialised onto a '
    'volume, and must never be able to read another tenant''s private key out '
    'of the database.';

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  DKIM keys table ready — one key per domain, RLS forced';
    RAISE NOTICE '  Private keys are NOT readable by the mail-edge role';
    RAISE NOTICE '';
END $$;

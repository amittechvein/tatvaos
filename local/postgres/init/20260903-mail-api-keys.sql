-- ============================================================================
--  Mail — organisation API keys, and a row per send.
--  Built for Techvein's own app sending confirmation links, 3 September 2026.
-- ============================================================================
--
--  Shaped on 20260828-mail-app-passwords.sql deliberately: same shown-once
--  credential, same revoke-not-delete, same "the hash carries its own
--  {SCHEME} prefix" rule. Read that file before changing anything here.
--
--  ONE DELIBERATE DIFFERENCE FROM THAT STORE, AND IT IS THE HASH.
--
--  App passwords are verified by Dovecot, which is handed a username first
--  and looks the row up by it — so a SALTED {SSHA512} works there. An API
--  key arrives with no username at all: the key IS the identifier, so the
--  lookup must be BY THE HASH, which a salted hash makes impossible.
--
--  Hence {SHA256}, unsalted and deterministic, indexed. Safe here for the
--  reason the app-password file already gives about its own choice: the
--  secret is 32 characters of cryptographic randomness, so the entropy is
--  the defence and the work factor buys nothing. A slow hash on a value with
--  no dictionary to attack would only add latency to every request.
--
--  ROWS ARE REVOKED, NEVER DELETED — "when was this key issued and when did
--  it stop working" is what an incident asks, and a deleted row shrugs.
--
--  Real date, and it depends only on core.tenants and mail.mailboxes (0001),
--  so it is immune to the September-named sequence problem.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.api_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- Display only ("Website contact form"). Never part of authentication.
    label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),

    -- '{SHA256}<hex>'. The scheme travels WITH the hash: the one store that
    -- relied on a default scheme verified every hash against the wrong
    -- algorithm for weeks and nobody noticed.
    key_hash    text NOT NULL,

    -- The head of the key, 'tvos_a1b2c3d4'. Stored so a person can tell two
    -- keys apart in a list and match one to a support ticket. Not a secret
    -- and not sufficient to authenticate.
    key_prefix  text NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz,

    -- Written by THIS API on every accepted send, so unlike the app-password
    -- store's removed column it has a writer. A NULL here means "never used"
    -- and can be read that way.
    last_used_at timestamptz
);

-- Lookup is BY HASH, on every authenticated request. Unique because the
-- secret must be, and the index is what makes the read cheap.
CREATE UNIQUE INDEX IF NOT EXISTS ix_api_keys_hash ON mail.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS ix_api_keys_tenant
    ON mail.api_keys (tenant_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE mail.api_keys IS
    'Per-organisation API keys for POST /v1/mail/send. Shown once, stored as '
    '{SHA256} because the lookup is by hash. Revoke-not-delete.';

-- ----------------------------------------------------------------------------
--  One row per send. No retention limit — Amit''s decision, keep everything.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail.api_sends (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- Kept even after the key is revoked: the question "what did that key
    -- send before we killed it" is the whole reason this table exists.
    api_key_id  uuid REFERENCES mail.api_keys(id) ON DELETE SET NULL,

    from_address text NOT NULL,
    to_address   text NOT NULL,
    subject      text NOT NULL,

    -- 'accepted' — Postfix took it. 'refused' — it did not, and error says
    -- why, in Postfix's own words. There is deliberately NO 'delivered':
    -- nothing here can observe the receiving server, and a status column
    -- that is sometimes wrong is worse than one that is absent.
    outcome      text NOT NULL CHECK (outcome IN ('accepted','refused')),
    error        text,

    sent_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_api_sends_tenant_time
    ON mail.api_sends (tenant_id, sent_at DESC);

COMMENT ON TABLE mail.api_sends IS
    'One row per API send attempt. accepted = Postfix took it; refused = it '
    'did not. No delivery confirmation: nothing here can observe the '
    'receiving server. Kept indefinitely.';

GRANT SELECT, INSERT, UPDATE ON mail.api_keys  TO tatvaos_app;
GRANT SELECT, INSERT         ON mail.api_sends TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  RLS. Both tables carry tenant_id directly, so the policy is the plain one.
--
--  NOTE the authentication asymmetry, deliberately different from
--  app_passwords: that table needed a mailedge SELECT policy because Dovecot
--  authenticates before any tenant is known. Nothing outside this API ever
--  reads these tables, so no such escape hatch exists here. The key lookup
--  runs in platform scope inside the API before the tenant is set.
-- ----------------------------------------------------------------------------
ALTER TABLE mail.api_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.api_keys  FORCE  ROW LEVEL SECURITY;
ALTER TABLE mail.api_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.api_sends FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON mail.api_keys;
CREATE POLICY tenant_isolation ON mail.api_keys
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON mail.api_sends;
CREATE POLICY tenant_isolation ON mail.api_sends
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
    RAISE NOTICE 'mail.api_keys + mail.api_sends - shown once, revoke-not-delete, keep everything.';
END $$;

-- ---------------------------------------------------------------------------
--  Key resolution - the one deliberate hole, kept as small as possible
-- ---------------------------------------------------------------------------
--
--  A send request arrives carrying a key and nothing else. To learn the tenant
--  we must read a row we are not yet allowed to read: RLS needs app.tenant_id,
--  and app.tenant_id is not knowable until the key is found. That is a circle.
--
--  The first version of the endpoint tried to break it with
--  EnterPlatformScope(Guid.Empty, ...). That does NOT work and was never going
--  to - platform scope deliberately does not disable RLS, it sets a tenant per
--  operation - so every query ran with app.tenant_id all zeros, matched no
--  policy row, and told every VALID key that it was invalid. EF's
--  IgnoreQueryFilters() disguised it: that drops EF's own filter and leaves
--  the DATABASE policy completely in force.
--
--  So this function does exactly one thing, modelled on
--  core.resolve_refresh_token, which broke the identical circle for the
--  refresh endpoint: given a key hash, return who it belongs to. It reveals
--  nothing to a caller who does not already hold the key, and it is the only
--  place in Mail permitted to read an api_keys row without a tenant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mail.resolve_api_key(p_hash text)
RETURNS TABLE (key_id uuid, tenant_id uuid, was_revoked boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = mail, pg_temp
AS $$
    SELECT k.id, k.tenant_id, (k.revoked_at IS NOT NULL)
      FROM mail.api_keys k
     WHERE k.key_hash = p_hash;
$$;

REVOKE ALL ON FUNCTION mail.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mail.resolve_api_key(text) TO tatvaos_app;

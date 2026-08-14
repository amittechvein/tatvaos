-- ============================================================================
--  Two-step verification (TOTP)
-- ============================================================================
--
--  core.users has carried mfa_enabled and mfa_secret_ref since the first
--  schema, and nothing ever wrote them. The console showed "Two-step
--  verification: Off" for every user because it was off for every user, with
--  no way to turn it on. This is the flow that makes those columns mean
--  something.
--
--  TOTP, not SMS. The mobile OTP sign-in already exists and is the right
--  choice for a country where everyone has a phone and not everyone has a
--  password manager — but SMS is not a second FACTOR, it is a second channel,
--  and SIM-swap fraud is common enough in India that treating it as strong
--  authentication would be dishonest. An authenticator app is offline, free,
--  and works on the phone people already carry.
--
--  WHAT IS STORED, AND WHAT IS NOT.
--
--  mfa_secret_ref holds the TOTP secret ENCRYPTED (AES-GCM, key from config —
--  see TotpService). The column name says "ref" because the original design
--  imagined a pointer into a key store; there is no key store, so it holds the
--  ciphertext instead. Plaintext there would mean a database dump alone is
--  enough to generate valid codes forever, which defeats the point of the
--  second factor entirely.
--
--  Recovery codes are hashed, never stored readable, for the same reason a
--  password is not. They are single-use and there is no way to show them
--  again — losing them means an administrator has to reset the enrolment.

-- ----------------------------------------------------------------------------
--  Enrolment state
-- ----------------------------------------------------------------------------
--  A secret exists BEFORE it is confirmed: the user scans a QR code, then
--  types a code to prove the app is working. Enabling on scan alone would lock
--  people out of their own account whenever the scan silently failed — which
--  it does, when a camera reads the wrong code or the phone clock has drifted.
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS mfa_pending_secret text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;

-- Replay protection. TOTP codes stay valid for a 30-second step (plus the
-- drift window), so a code observed over someone's shoulder — or captured in a
-- phishing proxy — can be used again inside that window. Recording the last
-- step consumed makes each code single-use.
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;

-- ----------------------------------------------------------------------------
--  Recovery codes
-- ----------------------------------------------------------------------------
--  The answer to "I lost my phone" that does not require a support ticket.
--  Without these, MFA turns every lost handset into an administrator action,
--  and administrators respond by not enabling MFA.
CREATE TABLE IF NOT EXISTS core.mfa_recovery_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- SHA-256 of the code. Not Argon2: these are 80 bits of our own randomness,
    -- so there is nothing to brute-force and a slow hash would only add latency
    -- to a sign-in someone is already struggling with.
    code_hash  text NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user
    ON core.mfa_recovery_codes(user_id) WHERE used_at IS NULL;

-- Verified BEFORE the tenant is known — the same pre-auth path as the refresh
-- token lookup — so this table cannot be RLS-forced. It is safe because the
-- only lookup is by (user_id, code_hash), which is a 256-bit needle: knowing
-- one does not help you find another tenant's.
GRANT SELECT, INSERT, UPDATE, DELETE ON core.mfa_recovery_codes TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Two-step verification ready — TOTP secrets encrypted at rest,';
    RAISE NOTICE '  recovery codes hashed and single-use, replay window closed.';
    RAISE NOTICE '';
END $$;

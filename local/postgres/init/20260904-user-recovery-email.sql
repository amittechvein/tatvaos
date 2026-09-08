-- ============================================================================
--  Recovery email — a verified way back in when the primary mailbox is lost
-- ============================================================================
--
--  A recovery email is a SECONDARY address (typically personal) a person can
--  use to prove ownership of their account. Modelled on the mobile-OTP and
--  password-reset columns already on core.users: recovery is state OF a user,
--  so it lives here, not in a side table (same reasoning as 0011-login-otp.sql).
--
--  Design rules this schema encodes:
--   * VERIFIED-BEFORE-IT-COUNTS. recovery_email_verified_at stays NULL until
--     the owner clicks a verification link. An unverified address must never
--     be usable for recovery, or a hijacked session could add a backdoor
--     address. The API enforces it; this column records the proof.
--   * NON-UNIQUE ON PURPOSE. Like phone, the same recovery address MAY sit on
--     two accounts (one person, two mailboxes). Safety comes not from a unique
--     constraint but from the API's "exactly one live match, or refuse" rule
--     (the pattern already used for phone in AuthEndpoints). Hence a plain
--     lookup index, NOT a unique one.
--   * TOKEN NEVER STORED RAW. recovery_email_token_hash holds a SHA-256 of the
--     verification token, exactly like login_otp_hash / password_reset_hash.
--
--  Adds nullable columns only — no behaviour change. The API that reads and
--  writes them ships in later, separately-reviewed stages.
-- ----------------------------------------------------------------------------

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS recovery_email                text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS recovery_email_verified_at    timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS recovery_email_token_hash     text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS recovery_email_token_sent_at  timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS recovery_email_token_attempts int NOT NULL DEFAULT 0;

-- Recovery-email lookup runs on every recovery attempt. Partial: most rows
-- have no recovery address set, at least at first — mirrors the phone index.
CREATE INDEX IF NOT EXISTS idx_core_users_recovery_email
    ON core.users(recovery_email) WHERE recovery_email IS NOT NULL;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Recovery-email columns ready — verified-before-use,';
    RAISE NOTICE '  token hashed, non-unique (one-live-match rule in the API)';
    RAISE NOTICE '';
END $$;

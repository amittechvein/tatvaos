-- ============================================================================
--  Forgot password
-- ============================================================================
--
--  A person who cannot sign in must be able to recover WITHOUT an admin — the
--  usual cause is a forgotten password, and an admin ticket for that is a
--  waste of everyone's afternoon (the same reasoning behind the self-expiring
--  lockout in 11-login-otp.sql).
--
--  Two channels, one set of columns:
--
--    email  a long, high-entropy token mailed as a link. The token itself is
--           globally unique, so the reset endpoint finds the user BY the hash.
--    phone  a six-digit OTP, exactly like the login OTP — low entropy, so the
--           user is found by phone first and the code is salted with the user
--           id before hashing.
--
--  These live on core.users, not a separate table, for the same reason the
--  login OTP does: a reset is state OF a sign-in attempt FOR a user, and it
--  needs the same pre-auth, cross-tenant read path core.users already has (no
--  RLS by design — see 00-core-schema.sql). A separate table would buy a join
--  and nothing else.
--
--  The secret is NEVER stored — only a SHA-256 hex digest, so a database read
--  cannot recover a link or a code. The channel column pins which door the
--  secret was minted for, so an email token cannot be spent at the phone
--  endpoint or the reverse.

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS password_reset_hash     text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS password_reset_sent_at  timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS password_reset_attempts int NOT NULL DEFAULT 0;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS password_reset_channel  text;

-- The email path looks a user up BY the token hash (the token carries no
-- identity of its own), so that lookup needs an index or every reset scans the
-- whole table. Partial: all but a handful of rows have no reset in flight.
CREATE INDEX IF NOT EXISTS idx_core_users_password_reset_hash
    ON core.users(password_reset_hash) WHERE password_reset_hash IS NOT NULL;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Password-reset columns ready — email link (1-hour expiry)';
    RAISE NOTICE '  and phone OTP (5-minute expiry), both hashed, capped at 5';
    RAISE NOTICE '';
END $$;

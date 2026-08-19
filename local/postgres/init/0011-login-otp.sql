-- ============================================================================
--  Sign-in by mobile OTP
-- ============================================================================
--
--  The second tab on the login screen: enter the mobile number from signup,
--  receive a code, sign in. Modelled on what Indian users already do daily —
--  every bank here signs people in this way, so the flow needs no explaining.
--
--  Columns on core.users rather than a separate table: an OTP is state OF a
--  sign-in attempt FOR a user, exactly like failed_login_count and
--  locked_until, which already live here. A separate table would need the
--  same pre-auth, cross-tenant access path core.users already has (no RLS,
--  by design — see 00-core-schema.sql) and would buy nothing but a join.
--
--  The code itself is never stored — only a SHA-256 over (user id, code),
--  same shape as the signup OTPs. A database read cannot recover a code.

-- The number the person can sign in WITH. It has lived on core.tenants as the
-- organisation's contact number since signup was built — but a tenant is not
-- a person, and OTP login authenticates a person. Copied to the admin's user
-- row at signup completion, after it has been verified by SMS.
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS login_otp_hash     text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS login_otp_sent_at  timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS login_otp_attempts int NOT NULL DEFAULT 0;

-- Backfill: every signup-origin tenant verified its admin's number by SMS.
-- Without this, everyone who signed up BEFORE this migration could never use
-- the OTP tab — the exact people most likely to try it.
UPDATE core.users u
   SET phone = t.phone
  FROM core.tenants t
 WHERE t.id = u.tenant_id
   AND u.phone IS NULL
   AND t.phone IS NOT NULL
   AND u.email = t.admin_email;

-- Phone lookup happens on every OTP request. Partial: rows with no phone are
-- most rows in an org where only the admin signed up with one.
CREATE INDEX IF NOT EXISTS idx_core_users_phone
    ON core.users(phone) WHERE phone IS NOT NULL;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Login OTP columns ready — codes hashed, 5-minute expiry';
    RAISE NOTICE '  enforced in the API, attempts capped at 5';
    RAISE NOTICE '';
END $$;

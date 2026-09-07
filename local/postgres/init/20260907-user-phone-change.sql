-- ============================================================================
--  Recovery number change (account page)
-- ============================================================================
--
--  Changing the number is a two-step: the new number is held in pending_phone
--  until a code sent TO IT is entered, and only then replaces phone. The old
--  number keeps working throughout, so a mistyped number cannot lock anyone
--  out of OTP sign-in or the phone reset path.
--
--  Separate from the login_otp_* columns ON PURPOSE (same reasoning as the
--  password-reset columns): a login code minted for the old number must not
--  be able to verify the new one. The code is never stored — SHA-256 over
--  (user id, "phone-change:" + code), domain-separated from the login hash.

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS pending_phone               text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS pending_phone_otp_hash      text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS pending_phone_otp_sent_at   timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS pending_phone_otp_attempts  int NOT NULL DEFAULT 0;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Recovery-number change columns ready — 5-minute codes, 5 attempts';
    RAISE NOTICE '';
END $$;

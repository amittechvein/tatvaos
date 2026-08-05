-- ============================================================================
--  Signup: contact verification replaces domain verification
-- ============================================================================
--
--  The flow changed: an account is created after proving the EMAIL and PHONE
--  are real, and the domain is added later from inside the console. Domain
--  ownership still gates what it always gated — outbound mail — it just no
--  longer gates having an account.
--
--  Codes are stored hashed. A 6-digit OTP is small, but the table of open
--  drafts is readable by the sales queue, and a readable live code is a
--  takeover of the signup it belongs to.

ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS email_code_hash  text;
ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS email_code_sent_at timestamptz;
ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS email_verified_at  timestamptz;

ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS phone_code_hash  text;
ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS phone_code_sent_at timestamptz;
ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS phone_verified_at  timestamptz;

-- One shared counter, reset on resend. Five wrong guesses kills the codes,
-- not the draft - the person retries with fresh codes, the details stay.
ALTER TABLE core.signup_drafts ADD COLUMN IF NOT EXISTS code_attempts int NOT NULL DEFAULT 0;

DO $$ BEGIN
    RAISE NOTICE '  Signup OTP columns ready';
END $$;

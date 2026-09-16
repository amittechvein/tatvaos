-- ============================================================================
--  Invitations — new people set their own password (decision 0005)
-- ============================================================================
--
--  Until 16 September 2026 an admin adding a person with a blank password got
--  a GENERATED one, saw it once, and handed it over by chat, spreadsheet or
--  printed slip. For a school adding forty people that is a list of working
--  passwords on an admin's laptop — the weakest step in onboarding.
--
--  Amit's rule, 15 Sept 2026 (docs/decisions/0005): a person with a recovery
--  email gets an invitation link at that address and no password exists until
--  they set one; a person with no recovery info must be given a password the
--  admin TYPES. Nothing is generated for anyone to see.
--
--  These columns hold the invitation. They sit on core.users, not a side
--  table, for the same reason the login OTP and password reset do: an
--  invitation is state OF a user, read on the pre-auth, cross-tenant path
--  core.users already has (no RLS by design — see 0000-core-schema.sql).
--
--  SEPARATE from the password_reset_* columns ON PURPOSE. A "forgot password"
--  request must not overwrite a pending invitation, and an invitation must
--  not be spendable at the reset endpoint or the reverse.
--
--  The token is NEVER stored — invite_token_hash is its SHA-256 hex digest,
--  exactly like password_reset_hash. The link carries the token in the URL
--  FRAGMENT (decision 0003), so it never reaches a server log.
--
--  invite_delivered records what the mail edge said: NULL = not attempted
--  yet (a bulk import sends after the response), TRUE = accepted, FALSE = the
--  send failed. Today's welcome mail swallows its failures; an invitation is
--  how a person gets in, so its failure has to be visible to the admin.
--
--  There is no attempts counter here, unlike the reset columns: that counter
--  exists for the six-digit phone code, which is guessable. This token is
--  found BY its hash and is 256 bits of entropy; there is nothing to count.
--
--  Additive, nullable, re-runnable. Rollback restores code, not schema.
-- ----------------------------------------------------------------------------

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS invite_token_hash   text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS invite_sent_at      timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS invite_channel      text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS invite_delivered    boolean;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS invite_accepted_at  timestamptz;

-- The accept endpoint finds the user BY the token hash (the token carries no
-- identity of its own). Partial: only rows with an invitation in flight.
CREATE INDEX IF NOT EXISTS idx_core_users_invite_token_hash
    ON core.users(invite_token_hash) WHERE invite_token_hash IS NOT NULL;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Invitation columns ready — 72-hour link to the recovery email,';
    RAISE NOTICE '  token hashed, single-use; no generated passwords (decision 0005)';
    RAISE NOTICE '';
END $$;

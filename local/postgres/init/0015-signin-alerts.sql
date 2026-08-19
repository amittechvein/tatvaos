-- ============================================================================
--  New-device sign-in alerts
-- ============================================================================
--
--  "We noticed a new sign-in to your account." The mail every serious provider
--  sends, and the missing half of this platform's security story: recovery and
--  credentials were already strong, but a stolen password used from someone
--  else's machine produced NO signal to the real owner until the damage was
--  done. This closes that loop.
--
--  One column. The fingerprint of the browser and OS a session was issued to,
--  so "have we seen this device for this user before?" is an indexed lookup
--  rather than a scan-and-parse of every session the user has ever held.
--
--  WHY NOT KEY ON IP. A phone changes address every time it moves between wifi
--  and mobile data. An IP-keyed fingerprint would fire on nearly every sign-in,
--  and an alert that cries wolf is one people learn to delete unread — strictly
--  worse than no alert, because it also trains them to ignore the real one.
--  The user agent changes only when the person genuinely switches browser,
--  device or OS, which is exactly the event worth an email.
--
--  The value is a SHA-256 hex digest, not the raw string: it is compared, never
--  displayed. The human-readable device description in the alert email is
--  rendered from user_agent, which we already store alongside it.

ALTER TABLE core.refresh_tokens ADD COLUMN IF NOT EXISTS device_key text;

-- Every sign-in asks "any earlier session for this user on this device?", so
-- the pair is the lookup, and the pair is the index.
CREATE INDEX IF NOT EXISTS idx_core_refresh_tokens_user_device
    ON core.refresh_tokens(user_id, device_key) WHERE device_key IS NOT NULL;

-- Sessions that predate this column have no fingerprint, so the first sign-in
-- after deploy would look "new" on a device the person has used for months —
-- an alert storm on release day, which is exactly the sort of self-inflicted
-- incident that teaches users to ignore these emails.
--
-- Backfilling a real fingerprint is not possible here (it is a SHA-256 the API
-- computes), so instead the API SUPPRESSES the alert for any user whose
-- sessions are all unfingerprinted — see NewDeviceAlert in AuthEndpoints.cs.
-- This notice is a reminder that the suppression is load-bearing, not belt-and-
-- braces.

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Sign-in alert fingerprint ready — device_key on refresh_tokens.';
    RAISE NOTICE '  Pre-existing sessions carry no fingerprint; the API suppresses';
    RAISE NOTICE '  alerts for those users until they have one, to avoid a storm.';
    RAISE NOTICE '';
END $$;

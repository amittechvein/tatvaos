-- ============================================================================
--  Bounce intake — the guarded, idempotent write a returning DSN makes.
--
--  Slice 3 of the bounce pipeline (see local/postfix/BOUNCE-ROUTING.md):
--    #25  schema — bounced_at / bounce_type / bounce_reason on mail.api_sends
--    #28  VERP envelope — every API send leaves carrying its own row id
--    #34  routing + RCPT-time HMAC validation (Postfix + PostfixPolicyWorker)
--    THIS the intake — Postfix delivers the accepted, validated bounce to an
--         LMTP receiver in the API (BounceIntakeWorker), which parses the DSN
--         and calls this function to record the outcome.
--
--  WHY A FUNCTION, AND WHY SECURITY DEFINER.
--  mail.api_sends is FORCE ROW LEVEL SECURITY with a tenant_isolation policy
--  keyed on app.tenant_id (see 20260903-mail-api-keys.sql). The intake knows a
--  row id — the correlation key carried in the bounce address — but NOT the
--  tenant, and it cannot learn the tenant by reading the row, because the read
--  is itself filtered by the same policy. That is the identical circle the send
--  endpoint hit at key-resolution time, and it is broken the identical way:
--  a SECURITY DEFINER function, owned by the migration role (which bypasses
--  RLS), that does exactly one narrow thing by primary key and reveals nothing
--  to a caller who does not already hold the id. Modelled on
--  mail.resolve_api_key / core.resolve_refresh_token.
--
--  WHY NO `GRANT UPDATE ... TO tatvaos_app`.
--  The app role is deliberately left with SELECT, INSERT only on api_sends
--  (the base grant is unchanged). It gets EXECUTE on THIS function and nothing
--  more, so the ONLY write it can make to a delivered row is a bounce stamp,
--  through the idempotent guard below. The table stays append-only from the
--  application's side — which is the whole "shown once, revoke-not-delete, keep
--  everything" posture the api_sends comment sets out. A blanket UPDATE grant
--  would hand the app the power to rewrite send history; it never needs it.
--
--  IDEMPOTENT ON PURPOSE (design §3). A DSN can be delivered more than once —
--  the far MTA retries, or two MX hosts both report. Setting bounced_at twice
--  is harmless; counting a hard bounce twice toward a future suppression /
--  reputation threshold is not. `AND bounced_at IS NULL` makes the second
--  delivery a no-op, and the caller is told which of the three things happened
--  so it can log an orphan loudly and a duplicate quietly:
--    'recorded'  — the row existed, was unbounced, and is now stamped.
--    'duplicate' — the row existed but was already bounced; nothing changed.
--    'unknown'   — no such row (a validly-signed id that never was, or was
--                  purged). The caller drops it: a valid HMAC over a missing
--                  row is consumed, not retried into a queue backlog.
--
--  The whole init/ directory re-runs on every deploy, so this is written to be
--  safe to run again unchanged: DROP + CREATE inside one transaction (no window
--  where the function is briefly absent for a live caller), guarded grants.
-- ============================================================================

BEGIN;

-- DROP first so a future change to the RETURN TYPE cannot wedge a redeploy with
-- "cannot change return type of existing function" — the exact failure the
-- api-keys migration documents. Harmless while the function is new; the point
-- is to never leave the fragile shape in the tree to be copied next time.
DROP FUNCTION IF EXISTS mail.record_bounce(uuid, text, text);

CREATE FUNCTION mail.record_bounce(
    p_id     uuid,
    p_type   text,   -- 'hard' | 'soft' — the CHECK on the column is the backstop
    p_reason text    -- DSN diagnostic + reported recipient; PERSONAL DATA, verbatim
)
RETURNS TABLE (result text, to_address text, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = mail, pg_temp
AS $fn$
    WITH existing AS (
        SELECT s.id, s.to_address, s.tenant_id
          FROM mail.api_sends s
         WHERE s.id = p_id
    ),
    upd AS (
        UPDATE mail.api_sends s
           SET bounced_at    = now(),
               bounce_type   = p_type,
               bounce_reason = p_reason
         WHERE s.id = p_id
           AND s.bounced_at IS NULL
        RETURNING s.to_address, s.tenant_id
    )
    SELECT
        CASE
            WHEN NOT EXISTS (SELECT 1 FROM existing) THEN 'unknown'
            WHEN EXISTS     (SELECT 1 FROM upd)      THEN 'recorded'
            ELSE                                          'duplicate'
        END AS result,
        -- The ROW's own to_address, authoritative for who bounced (design §4).
        -- Same value whether it came from the update or the pre-image.
        COALESCE((SELECT u.to_address FROM upd u),
                 (SELECT e.to_address FROM existing e)) AS to_address,
        COALESCE((SELECT u.tenant_id  FROM upd u),
                 (SELECT e.tenant_id  FROM existing e)) AS tenant_id;
$fn$;

COMMENT ON FUNCTION mail.record_bounce(uuid, text, text) IS
    'Idempotently stamp a bounce on the mail.api_sends row named by id. '
    'SECURITY DEFINER to cross the FORCE-RLS boundary by primary key only; '
    'the app holds EXECUTE on this and no direct UPDATE. Returns '
    'recorded|duplicate|unknown so the intake can drop orphans and no-op '
    'repeats. See local/postfix/BOUNCE-ROUTING.md.';

REVOKE ALL     ON FUNCTION mail.record_bounce(uuid, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mail.record_bounce(uuid, text, text) TO tatvaos_app;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'mail.record_bounce - idempotent bounce intake write (SECURITY DEFINER, EXECUTE to app only).';
END $$;

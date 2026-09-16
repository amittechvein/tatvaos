-- ============================================================================
--  Sweep for sign-in handoff codes — decision 0003, CTO ruling 16 Sept 2026.
--
--  20260916-auth-handoff-codes.sql created core.auth_handoff_codes with "NO
--  SWEEPER, ON PURPOSE": expiry is decided in the redeem statement, so spent
--  and expired rows are inert and deleting them is housekeeping, not security.
--  That is still true, and this file does not change it — the redeem never
--  depends on this running. But an unbounded table of credential hashes is a
--  finding in any review anyone ever runs on this platform, so they go.
--
--  ADDITIVE. One new function; no table, column or policy changes. Safe to
--  re-run on every deploy (CREATE OR REPLACE, REVOKE/GRANT are idempotent).
--
--  TWENTY-FOUR HOURS PAST EXPIRY, AND THE NUMBER LIVES HERE. Not a parameter:
--  a caller who could pass the window could pass zero and delete a code in the
--  middle of somebody's handoff. A day keeps a failed handoff debuggable the
--  morning after. Spent codes expire sixty seconds after mint like any other,
--  so they leave on the same clock.
--
--  WHY SECURITY DEFINER. The table is FORCE-RLS per tenant; a sweep crosses
--  every tenant, from a worker with no tenant set. Same shape, and the same
--  reason, as core.redeem_handoff_code and space.blob_keys_present: one
--  function that does exactly one thing, callable by the app role only. It
--  returns a count and nothing else — no hashes, no tenants.
--
--  Called from apps/api/Workers/SpaceBlobSweepWorker.cs on its existing tick.
--  Proven by infra/scripts/verify-handoff-sweep.sh (and --calibrate).
-- ============================================================================

CREATE OR REPLACE FUNCTION core.sweep_handoff_codes()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
-- Pinned, mandatory on SECURITY DEFINER: without it a caller's search_path
-- could point these names at objects of their own.
SET search_path = core, pg_temp
AS $$
    WITH gone AS (
        DELETE FROM core.auth_handoff_codes
         WHERE expires_at < now() - interval '24 hours'
        RETURNING 1
    )
    SELECT count(*)::int FROM gone;
$$;

REVOKE ALL ON FUNCTION core.sweep_handoff_codes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.sweep_handoff_codes() TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Report what is here, rather than assert what should be (rule 6).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    due int;
BEGIN
    SELECT count(*) INTO due
      FROM core.auth_handoff_codes
     WHERE expires_at < now() - interval '24 hours';

    RAISE NOTICE '';
    RAISE NOTICE '  core.sweep_handoff_codes() ready.';
    RAISE NOTICE '    % handoff code(s) are past the 24-hour window and will go on the next sweep', due;
    RAISE NOTICE '    run by SpaceBlobSweepWorker; the redeem never depends on it';
    RAISE NOTICE '';
END $$;

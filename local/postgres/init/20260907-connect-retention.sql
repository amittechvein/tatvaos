-- ============================================================================
--  TatvaOS Connect — recording retention. Decided 19 August 2026;
--  spec in docs/CONNECT_DECISIONS.md §1.
-- ============================================================================
--
--  Recordings are no longer kept forever. An organisation keeps them for one
--  of five periods — 7, 30, 90, 180 or 365 days — and the default is 90:
--  long enough that nobody loses a recording they were still going to watch,
--  short enough that the disk does not fill while nobody is looking. Not
--  free-form, deliberately: a text box invites 1 and 3650, and both are
--  somebody's bad day.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THREE DECISIONS.
--
--  1. THE SWEEP IS THE WORKER'S, THE CANDIDATES ARE THIS FILE'S. The worker
--     runs with no tenant, so which recordings have expired is answered by a
--     SECURITY DEFINER function returning IDS ONLY — the same shape as every
--     other queue in this module. The worker takes an id, enters the tenant,
--     and does the deletion the ordinary way, under the policy, exactly as
--     the host's own Delete button does.
--
--  2. "KEEP THIS ONE" EXISTS FROM DAY ONE. recordings.keep_until_at, NULL for
--     the ordinary case. The spec's own prediction is that the first support
--     ticket is a board meeting that got swept; the exemption costs one
--     nullable column now and a migration plus an apology later.
--
--  3. THE CLOCK STARTS WHEN THE RECORDING ENDED, falling back to created_at.
--     Retention counted from creation would shave the meeting's own length
--     off every period; nobody means "89 days and the hour we spent talking".
--
--  WHAT THE SWEEP DELETES is decided in ConnectNotesWorker, not here — see
--  its header for the transcript-and-notes ruling and the open question
--  flagged to Amit.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Core's table, one column — the organisation's retention choice.
--  Flagged to Core, the allow_connect_guests / allow_connect_recording
--  precedent exactly.
-- ----------------------------------------------------------------------------
ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS connect_recording_retention_days integer NOT NULL DEFAULT 90;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenants_connect_retention_check'
           AND conrelid = 'core.tenants'::regclass) THEN
        ALTER TABLE core.tenants ADD CONSTRAINT tenants_connect_retention_check
            CHECK (connect_recording_retention_days IN (7, 30, 90, 180, 365));
    END IF;
END $$;

COMMENT ON COLUMN core.tenants.connect_recording_retention_days IS
    'How long Connect recordings are kept before the sweep deletes them. '
    'One of 7/30/90/180/365; default 90. Shortening this destroys existing '
    'recordings on the next sweep — any UI that sets it must say how many '
    'and ask twice (docs/CONNECT_DECISIONS.md §1).';

-- ----------------------------------------------------------------------------
--  The exemption. NULL = ordinary retention applies.
-- ----------------------------------------------------------------------------
ALTER TABLE connect.recordings
    ADD COLUMN IF NOT EXISTS keep_until_at timestamptz;

COMMENT ON COLUMN connect.recordings.keep_until_at IS
    '"Keep this one": the sweep will not touch the recording before this '
    'instant, whatever the org retention says. NULL for the ordinary case. '
    'Set by the host via the recordings API.';

-- ----------------------------------------------------------------------------
--  The candidates. IDS ONLY, definer, pinned search_path — the worker enters
--  each recording's tenant before reading anything else about it.
--
--  Only 'ready' rows: 'deleted' is already gone, 'failed'/'aborted' hold no
--  file, and anything still moving belongs to the repair pass, not this one.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.expired_recordings(p_limit integer DEFAULT 10)
RETURNS TABLE (recording_id uuid, meeting_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT r.id, r.meeting_id
      FROM connect.recordings r
      JOIN connect.meetings m ON m.id = r.meeting_id
      JOIN core.tenants t     ON t.id = m.tenant_id
     WHERE r.status = 'ready'
       AND (r.keep_until_at IS NULL OR r.keep_until_at < now())
       AND COALESCE(r.ended_at, r.created_at)
           < now() - make_interval(days => t.connect_recording_retention_days)
     ORDER BY COALESCE(r.ended_at, r.created_at)
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.expired_recordings(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.expired_recordings(integer) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Connect recording retention:';
    RAISE NOTICE '    core.tenants.connect_recording_retention_days — 7/30/90/180/365, default 90';
    RAISE NOTICE '    connect.recordings.keep_until_at — "keep this one" exemption';
    RAISE NOTICE '    connect.expired_recordings() — the sweep''s queue, ids only';
    RAISE NOTICE '';
END $$;

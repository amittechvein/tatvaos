-- ============================================================================
--  TatvaOS Connect — recording retention default drops from 90 days to 30.
--  Amit's ruling, 22 August 2026.
-- ============================================================================
--
--  THE FILENAME IS A LIE. Written 23 August, named 20260822, and it ALTERs a
--  column that 20260907-connect-retention.sql creates — so it sorted before
--  the thing it depends on and would have failed on any fresh database.
--  Renamed to 20260911 as a workaround. See the header of
--  20260911-connect-captions.sql for the full account and the real fix.
-- ============================================================================
--
--  WHY, IN ONE SUM.
--
--  Connect records video at H264_720P_30, which measured at 23.5 MB a minute
--  on a real file — about 1.4 GB an HOUR. The production box has ~114 GB free,
--  and that free space is shared with Mail, because it is one machine and one
--  filesystem.
--
--      114 GB ÷ 1.4 GB per hour ≈ 81 hours of video held at once.
--
--  At the old 90-day default that is roughly ONE HOUR of recorded meeting per
--  day before the disk fills. For a school running four lessons a day it is
--  about three weeks from switching recording on to Mail having nowhere to
--  write. 30 days roughly triples the headroom, and covers essentially every
--  real reason somebody goes back to a meeting.
--
--  The policy was never missing — it shipped on 19 August. The DEFAULT was
--  wrong, which is a different and quieter kind of wrong: nothing fails, no
--  test goes red, and the first symptom is a full disk on a Tuesday.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THIS FILE CHANGES THE DEFAULT ONLY. IT DOES NOT TOUCH ANY EXISTING ROW.
--
--  That restraint is the whole point, and it is worth spelling out because the
--  obvious version of this file is dangerous.
--
--  Every migration in this directory RE-RUNS ON EVERY DEPLOY. So a line like
--
--      UPDATE core.tenants SET connect_recording_retention_days = 30
--       WHERE connect_recording_retention_days = 90;
--
--  is not a one-time correction. It is a rule that runs forever. An
--  administrator who deliberately chooses 90 days next month would find
--  themselves back on 30 after the next deploy, again after the one following,
--  with nothing anywhere saying why — and because shortening retention
--  DELETES recordings, the cost of that quiet reversal is a customer's
--  meetings, not a preference.
--
--  Existing organisations are therefore changed by hand, once, with somebody
--  looking at what will be deleted first. See docs/CONNECT_DECISIONS.md and
--  the runbook note at the bottom of this file.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

ALTER TABLE core.tenants
    ALTER COLUMN connect_recording_retention_days SET DEFAULT 30;

COMMENT ON COLUMN core.tenants.connect_recording_retention_days IS
    'How long Connect recordings are kept before the sweep deletes them. '
    'One of 7/30/90/180/365; default 30 as of 22 August 2026 (was 90) because '
    'video costs ~1.4 GB an hour and the box shares its disk with Mail. '
    'SHORTENING THIS DESTROYS EXISTING RECORDINGS older than the new period, '
    'and rotating nothing brings them back.';

DO $$
DECLARE
    still_on_90 integer;
BEGIN
    SELECT count(*) INTO still_on_90
      FROM core.tenants
     WHERE connect_recording_retention_days = 90;

    RAISE NOTICE 'connect retention: new organisations now default to 30 days.';

    IF still_on_90 > 0 THEN
        -- Loud, every deploy, until somebody deals with it. A notice that
        -- disappears once the work is done is a notice worth printing; one
        -- that has to be remembered is not.
        RAISE NOTICE '  % existing organisation(s) are still on 90 days and were NOT changed.', still_on_90;
        RAISE NOTICE '  Deliberate: this file re-runs on every deploy, and shortening retention deletes recordings.';
        RAISE NOTICE '  To move them, run BOTH of these by hand on the box and READ THE FIRST';
        RAISE NOTICE '  BEFORE RUNNING THE SECOND. Query 1 mirrors connect.expired_recordings()';
        RAISE NOTICE '  exactly — same status, same keep_until_at exemption, same clock — so its';
        RAISE NOTICE '  count is what the sweep would actually delete, not an estimate:';
        RAISE NOTICE '    1) SELECT t.id, count(r.id) AS would_be_deleted';
        RAISE NOTICE '         FROM core.tenants t';
        RAISE NOTICE '         LEFT JOIN connect.meetings m ON m.tenant_id = t.id';
        RAISE NOTICE '         LEFT JOIN connect.recordings r ON r.meeting_id = m.id';
        RAISE NOTICE '          AND r.status = ''ready''';
        RAISE NOTICE '          AND (r.keep_until_at IS NULL OR r.keep_until_at < now())';
        RAISE NOTICE '          AND COALESCE(r.ended_at, r.created_at) < now() - interval ''30 days''';
        RAISE NOTICE '        WHERE t.connect_recording_retention_days = 90';
        RAISE NOTICE '        GROUP BY t.id;';
        RAISE NOTICE '    2) UPDATE core.tenants SET connect_recording_retention_days = 30';
        RAISE NOTICE '        WHERE connect_recording_retention_days = 90;';
        RAISE NOTICE '  A non-zero count in (1) is recordings that will be GONE minutes after (2).';
    END IF;
END $$;

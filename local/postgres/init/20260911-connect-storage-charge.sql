-- ============================================================================
--  Connect recordings count against the person who started them.
--  Amit's ruling, 23 August 2026.
-- ============================================================================
--
--  THE BUG THIS FIXES: A METER THAT WAS SIMPLY WRONG.
--
--  Amit noticed the Connect sidebar reading "426.9 MB of 15.00 GB used" on a
--  page that was, at that moment, displaying a 1.6 GB recording.
--
--  core.user_storage_usage was a UNION of exactly two things: the person's
--  mailboxes and their personal Space files. MEETING RECORDINGS WERE COUNTED
--  NOWHERE — not against the person, not against the organisation, not at
--  all. The bytes were real, on the disk, and no number anywhere reflected
--  them.
--
--  Video is ~1.4 GB per hour. The box has ~114 GB free, on the SAME
--  FILESYSTEM MAIL WRITES TO. So the failure this permitted was: a customer
--  fills the disk until mail stops being delivered, while their storage bar
--  still reads comfortable. The only backstop was a 1 GB free-disk guard that
--  refuses recording — which trips for EVERY tenant on the box at once, at
--  the last possible moment, and explains nothing.
--
--  Same family as everything else found this week: not a thing that breaks,
--  a thing that accrues quietly while every screen says fine.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHY THE PERSON AND NOT THE ORGANISATION
--
--  Amit's call, and it is the one that creates pressure where the decision is
--  made: the host chooses to record, so the host sees the cost. Charging the
--  organisation would make recording free at the point of use, which is how a
--  disk fills.
--
--  IT IS SHARP, AND THAT SHOULD BE SAID HERE RATHER THAN DISCOVERED. A
--  90-minute meeting is about 2 GB — a seventh of a 15 GB allowance — and
--  that allowance is shared with MAIL. Somebody who records three lessons a
--  week will exhaust it inside a month, and the symptom they experience is
--  not "recordings are full", it is mail refusing delivery.
--
--  Two things make it survivable, and they are now load-bearing together:
--  retention defaults to 30 days (20260911-connect-retention-default-30), so
--  the charge ages off by itself; and audio-only recording is a twentieth of
--  the size and is the default.
--
--  ─────────────────────────────────────────────────────────────────────────
--  ONLY 'ready' RECORDINGS ARE CHARGED
--
--  A recording still being written has no final size, and one marked
--  'deleted' has had its bytes removed while the row stays so the audit log
--  is honest. Charging either would bill somebody for storage that does not
--  exist — which is the same class of wrongness as not charging for storage
--  that does.
--
--  Idempotent and additive, like every migration here.
--
--  NOTE ON THE FILENAME: 20260911, not 20260823. This function references
--  connect.recordings, created in 20260901-connect.sql, so it must sort after
--  it. See the header of 20260911-connect-captions.sql for why those files
--  carry September dates in August and what the real fix is.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  NO NEW COLUMN. connect.recordings.requested_by_user_id has existed since
--  20260902 and has been populated all along — the fact was already being
--  recorded, it was simply never used for anything.
--
--  Worth stating, because the first draft of this file added a
--  started_by_user_id beside it. A duplicate column holding the same fact is
--  how two numbers begin to disagree, and this migration exists precisely
--  because two things that should have agreed did not.
--
--  An index, though: the meter joins on it for every storage read.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_recordings_requested_by
    ON connect.recordings (requested_by_user_id)
    WHERE requested_by_user_id IS NOT NULL;

COMMENT ON COLUMN connect.recordings.requested_by_user_id IS
    'The host who started this recording. Their personal storage is charged '
    'for it while status = ''ready'' (Amit, 23 August 2026). NULL rows fall '
    'back to the meeting''s creator in core.user_storage_usage.';

-- ----------------------------------------------------------------------------
--  The meter, with the third thing it was always missing.
--
--  Deliberately a REPLACE of the whole function rather than a second function
--  the caller has to remember to add: there is exactly one answer to "what is
--  this person using", and two places to maintain it is how the meters came
--  to disagree in the first place (see 0017-storage-usage.sql).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.user_storage_usage(p_user uuid)
RETURNS TABLE (product_code text, used_bytes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, mail, space, connect, pg_temp
AS $$
    -- Mail: the person's OWN mailboxes only. A shared mailbox has user_id
    -- NULL and is the organisation's, not theirs.
    SELECT 'mail'::text,
           COALESCE(SUM(m.used_bytes), 0)::bigint
      FROM mail.mailboxes m
     WHERE m.user_id = p_user
       AND m.type = 'user'

    UNION ALL

    -- Space: files they OWN, personal ones only. Organisational files are the
    -- organisation's, whoever uploaded them.
    SELECT 'drive'::text,
           COALESCE(SUM(f.size_bytes), 0)::bigint
      FROM space.files f
     WHERE f.owner_user_id = p_user
       AND f.ownership_type = 'personal'

    UNION ALL

    -- Connect: recordings they started. COALESCE to the meeting's creator so
    -- that rows written before started_by_user_id existed are charged to
    -- somebody rather than silently to nobody — which is the exact bug this
    -- file is here to fix, and it would be a poor joke to reintroduce it for
    -- the historical rows.
    SELECT 'connect'::text,
           COALESCE(SUM(r.size_bytes), 0)::bigint
      FROM connect.recordings r
      JOIN connect.meetings  mt ON mt.id = r.meeting_id
     WHERE COALESCE(r.requested_by_user_id, mt.created_by_user_id) = p_user
       AND r.status = 'ready';
$$;

REVOKE ALL ON FUNCTION core.user_storage_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.user_storage_usage(uuid) TO tatvaos_app;

DO $$
DECLARE unattributed bigint;
BEGIN
    SELECT COALESCE(SUM(r.size_bytes), 0) INTO unattributed
      FROM connect.recordings r
      JOIN connect.meetings mt ON mt.id = r.meeting_id
     WHERE r.status = 'ready'
       AND r.requested_by_user_id IS NULL
       AND mt.created_by_user_id IS NULL;

    RAISE NOTICE 'connect storage: recordings now count against the host who started them.';
    IF unattributed > 0 THEN
        RAISE NOTICE '  % bytes of recordings have no host and no meeting creator —', unattributed;
        RAISE NOTICE '  they are on the disk and still counted against nobody.';
    END IF;
END $$;

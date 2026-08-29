-- ============================================================================
--  TatvaOS Connect — notes wait for a recording that is actually landing.
-- ============================================================================
--
--  Found on the module's FIRST proven end-to-end run (19 August): the minutes
--  said "this meeting was not recorded" beside a recording marked Ready.
--  Two separate holes, both closed here:
--
--  1. TIMING. 20260903 taught pending_notes to defer for a transcript that is
--     queued or running — but only a transcript. With transcription switched
--     off there IS no transcript coming, so notes fired the minute the
--     meeting ended, while the egress was still finalising its file. The same
--     deferral now applies to the RECORDING: a meeting whose recording is
--     starting, recording or processing is not offered for notes yet. The
--     repair pass already guarantees those states settle (to ready or
--     failed), so this is a delay of minutes, never a deadlock.
--
--  2. HONESTY. Even written at the right moment, the notes had no way to say
--     "recorded, but no transcript was made" — had_transcript=false rendered
--     as "this meeting was not recorded", which is a false statement beside a
--     Ready recording. meeting_notes now records had_recording as well, and
--     the renderer says one of three true things instead of one of two.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

ALTER TABLE connect.meeting_notes
    ADD COLUMN IF NOT EXISTS had_recording boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN connect.meeting_notes.had_recording IS
    'Whether a READY recording existed when these notes were written. With '
    'had_transcript, picks one of three true sentences: recorded+transcribed, '
    'recorded but no transcript, not recorded.';

-- ----------------------------------------------------------------------------
--  What needs notes — REPLACES the 20260903 definition.
--
--  Was: ended, no notes, unless a transcript is on its way.
--  Now: ended, no notes, unless a transcript OR A RECORDING is on its way.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.pending_notes(p_limit integer DEFAULT 10)
RETURNS TABLE (meeting_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    SELECT m.id
      FROM connect.meetings m
      LEFT JOIN connect.meeting_notes n ON n.meeting_id = m.id
     WHERE m.status = 'ended'
       AND (n.id IS NULL OR n.status = 'queued')
       -- 20260903's decision 2: do not write the worse version of notes that
       -- are about to have a transcript.
       AND NOT EXISTS (
            SELECT 1 FROM connect.transcripts t
             WHERE t.meeting_id = m.id AND t.status IN ('queued','running'))
       -- And the same courtesy for the recording itself. An egress still
       -- finalising is minutes from being 'ready' or 'failed' — the repair
       -- pass sees to it — and notes written inside that window claim the
       -- meeting was never recorded. They can wait a tick.
       AND NOT EXISTS (
            SELECT 1 FROM connect.recordings r
             WHERE r.meeting_id = m.id
               AND r.status IN ('starting','recording','processing'))
       -- A meeting nobody ever joined has nothing to write notes about.
       AND EXISTS (
            SELECT 1 FROM connect.participants pa
             WHERE pa.meeting_id = m.id AND pa.first_joined_at IS NOT NULL)
     ORDER BY m.ended_at NULLS LAST
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.pending_notes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.pending_notes(integer) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Connect notes now wait for the recording, not only the transcript:';
    RAISE NOTICE '    pending_notes defers while a recording is starting/recording/processing';
    RAISE NOTICE '    meeting_notes.had_recording lets the minutes say which of three things is true';
    RAISE NOTICE '';
END $$;

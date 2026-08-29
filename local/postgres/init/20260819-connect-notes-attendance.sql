-- ============================================================================
--  TatvaOS Connect — notes that exist before a transcript does.
-- ============================================================================
--
--  20260818 made the notes taker depend on a transcript, and a transcript
--  depends on a transcription service, and a transcription service is off by
--  default because audio must not leave the box until somebody decides it may.
--  The result: an "automatic meeting notes" feature that produces nothing at
--  all on a fresh deployment, for every meeting, indefinitely.
--
--  That is the wrong shape. The platform already knows, for every meeting and
--  with no media involved: who was invited, who actually turned up, when they
--  arrived, when they left and how long they stayed. For a school checking
--  who attended a class, that IS the meeting record. A transcript makes it
--  better; it should not be what makes it exist.
--
--  ─────────────────────────────────────────────────────────────────────────
--  TWO DECISIONS.
--
--  1. WHO CAME IS READ FROM TWO PLACES, ON PURPOSE.
--     connect.participants is written by the API when somebody joins, so it
--     is certain — it does not depend on a webhook arriving. Times come from
--     connect.meeting_events, which is the media server's account of the same
--     meeting and can be incomplete if a callback was lost. So the NAMES come
--     from the certain source and the DURATIONS from the accurate one, and
--     when the event log is empty the notes say who attended and say plainly
--     that timings are unavailable — rather than claiming nobody came.
--
--  2. NOTES WAIT FOR A TRANSCRIPT THAT IS ACTUALLY COMING, AND NOT OTHERWISE.
--     If a recording is being transcribed, writing attendance-only notes now
--     and replacing them ten minutes later reads as the notes changing their
--     mind. So pending_notes skips a meeting whose transcript is queued or
--     running — and the worker re-queues the notes when a transcript lands,
--     so the better version arrives on its own.
--  ─────────────────────────────────────────────────────────────────────────
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Who was there. [{ "name": "...", "identity": "...", "guest": false,
--                    "joinedAt": "...", "leftAt": "...", "seconds": 2731,
--                    "joins": 2 }]
-- ----------------------------------------------------------------------------
ALTER TABLE connect.meeting_notes
    ADD COLUMN IF NOT EXISTS attendance jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN connect.meeting_notes.attendance IS
    'Who attended, derived from connect.participants (who) and '
    'connect.meeting_events (when). Present even when no transcript exists.';

-- ----------------------------------------------------------------------------
--  Whether the notes had a transcript to work from.
--
--  Without this the screen cannot tell "this meeting was not recorded" from
--  "this meeting was recorded and the transcript failed", and those need
--  different sentences — the first is normal, the second is a fault.
-- ----------------------------------------------------------------------------
ALTER TABLE connect.meeting_notes
    ADD COLUMN IF NOT EXISTS had_transcript boolean NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
--  What needs notes — REPLACES the 20260818 definition.
--
--  Was: a meeting with a READY TRANSCRIPT and no notes.
--  Now: a meeting that has ENDED and no notes, unless a transcript for it is
--       still on its way.
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
       -- Decision 2: do not write the worse version of notes that are about
       -- to have a transcript.
       AND NOT EXISTS (
            SELECT 1 FROM connect.transcripts t
             WHERE t.meeting_id = m.id AND t.status IN ('queued','running'))
       -- A meeting nobody ever joined has nothing to write notes about, and
       -- would otherwise sit in this queue for ever being re-examined.
       AND EXISTS (
            SELECT 1 FROM connect.participants pa
             WHERE pa.meeting_id = m.id AND pa.first_joined_at IS NOT NULL)
     ORDER BY m.ended_at NULLS LAST
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.pending_notes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.pending_notes(integer) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Attendance for one meeting, as the notes worker wants it.
--
--  NOT a definer function: by the time the worker calls this it has already
--  entered the meeting's tenant, so ordinary RLS applies and should. Only the
--  "which tenant is this" question is answered outside the policy, and
--  connect.webhook_meeting_tenant already answers it.
--
--  The duration is computed by PAIRING joins with leaves rather than by
--  subtracting first from last: somebody who joins, leaves for twenty minutes
--  and comes back for the last five was present for ten minutes, not
--  thirty-five. An attendance figure that cannot tell those apart is worse
--  than none, because it will be used to mark a register.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.attendance(p_meeting uuid)
RETURNS TABLE (
    identity     text,
    display_name text,
    is_guest     boolean,
    joined_at    timestamptz,
    left_at      timestamptz,
    seconds      bigint,
    joins        integer)
LANGUAGE sql
STABLE
AS $$
    WITH ordered AS (
        SELECT e.identity,
               e.kind,
               e.occurred_at,
               -- The next event for the SAME person, whatever it is. A join
               -- followed by another join (a missed leave) closes at the
               -- second join rather than running to the end of the meeting.
               LEAD(e.occurred_at) OVER (PARTITION BY e.identity ORDER BY e.occurred_at) AS next_at
          FROM connect.meeting_events e
         WHERE e.meeting_id = p_meeting
           AND e.identity IS NOT NULL
           AND e.kind IN ('participant_joined','participant_left')
    ),
    spans AS (
        SELECT o.identity,
               GREATEST(EXTRACT(EPOCH FROM (
                   COALESCE(o.next_at,
                            (SELECT m.ended_at FROM connect.meetings m WHERE m.id = p_meeting),
                            o.occurred_at) - o.occurred_at))::bigint, 0) AS secs
          FROM ordered o
         WHERE o.kind = 'participant_joined'
    ),
    totals AS (
        SELECT s.identity, SUM(s.secs)::bigint AS secs, COUNT(*)::integer AS joins
          FROM spans s GROUP BY s.identity
    ),
    times AS (
        -- Keyed on the KIND, not on min/max over everything. Taking MAX of
        -- all events gave somebody who joined and never left a left_at equal
        -- to their join time, which on screen reads as leaving immediately —
        -- exactly backwards for the person who stayed the whole hour.
        SELECT e.identity,
               MIN(e.occurred_at) FILTER (WHERE e.kind = 'participant_joined') AS first_at,
               MAX(e.occurred_at) FILTER (WHERE e.kind = 'participant_left')   AS last_at
          FROM connect.meeting_events e
         WHERE e.meeting_id = p_meeting AND e.identity IS NOT NULL
         GROUP BY e.identity
    )
    -- LEFT JOIN from participants, not from events: decision 1. Everybody the
    -- API saw join appears, even if not one webhook about them ever arrived.
    SELECT pa.identity,
           pa.display_name,
           pa.is_guest,
           COALESCE(t.first_at, pa.first_joined_at),
           -- No leave event and the meeting is over means they were still in
           -- it at the end. That is the honest answer, and it is the common
           -- one — most people close the tab rather than press Leave.
           COALESCE(t.last_at,
                    (SELECT m.ended_at FROM connect.meetings m WHERE m.id = p_meeting),
                    pa.last_seen_at),
           COALESCE(tot.secs, 0)::bigint,
           COALESCE(tot.joins, 0)::integer
      FROM connect.participants pa
      LEFT JOIN totals tot ON tot.identity = pa.identity
      LEFT JOIN times  t   ON t.identity   = pa.identity
     WHERE pa.meeting_id = p_meeting
       AND pa.first_joined_at IS NOT NULL
     ORDER BY COALESCE(tot.secs, 0) DESC, pa.display_name;
$$;

REVOKE ALL ON FUNCTION connect.attendance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.attendance(uuid) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Connect notes now work without a transcript.';
    RAISE NOTICE '    every ENDED meeting with attendance gets notes, transcript or not';
    RAISE NOTICE '    names from connect.participants, timings from connect.meeting_events';
    RAISE NOTICE '';
END $$;

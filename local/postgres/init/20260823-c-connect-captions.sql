-- ============================================================================
--  TatvaOS Connect — live captions, and a transcript that costs nothing.
--  Amit's ruling, 22 August 2026.
-- ============================================================================
--
--  THE FILENAME IS A LIE, AND HERE IS WHY.
--
--  This was written on 23 August 2026 and was named 20260822. It sorted
--  BEFORE 20260901-connect.sql, which is the file that creates
--  connect.meetings — the table this one's foreign keys point at. On the
--  production database it applied cleanly, because those tables already
--  existed. ON A FRESH DATABASE IT WOULD HAVE FAILED: a new customer, a
--  rebuild, or the staging box.
--
--  The cause is that Connect's migrations are numbered 20260901 through
--  20260910 as a SEQUENCE, not as dates — they were written in August. The
--  date prefix was adopted so that ordering equals chronology and nobody has
--  to ask for the next number. A future-dated file breaks both halves of
--  that at once, and it breaks them silently: everything works until somebody
--  builds from nothing.
--
--  Found by Space on 23 August, from reading the directory listing rather
--  than from anything failing. Renamed to 20260911 so it sorts after the
--  tables it depends on. That is a WORKAROUND: this filename now carries the
--  same false date as the ones it is working around, and the next person to
--  use a real date will land in the same trap.
--
--  THE ACTUAL FIX is Connect's: rename 20260901..20260910 to the dates of
--  their first commits, then this file goes back to 20260823 and the rule
--  means what it says again. Cheap today, awkward once more files pile on.
-- ============================================================================
--
--  WHY THIS TABLE EXISTS: 97% OF THE BILL WAS THE PART NOBODY WANTED.
--
--  Measured on a real 31-minute meeting: transcription ₹16.6, minutes ₹0.40.
--  The AI everybody means when they say "AI meeting notes" cost less than fifty
--  paise. The expensive part was turning speech into text — a thing the
--  browser will already do, for free, while the meeting is happening.
--
--  So the browser captions the speech as it is spoken, the lines are collected
--  here, and the model writes the minutes from them. At 300 meetings a month
--  that is roughly ₹7,200 becoming ₹90.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHAT THIS COSTS INSTEAD, SAID PLAINLY BECAUSE IT IS NOT FREE
--
--  Chrome's speech recognition SENDS THE AUDIO TO GOOGLE. We are not removing
--  a third party from the room, we are changing which one — from a provider we
--  hold a contract with to one we do not. For a hospital or a school asking
--  where a meeting goes, that is a real answer they are owed, and Connect's
--  UI must say it where captions are switched on rather than leaving it here.
--
--  It is also Chrome-only, and each browser hears only its OWN microphone. A
--  participant on Firefox contributes nothing; a participant who leaves takes
--  their share of the transcript with them. So a caption transcript is
--  STRUCTURALLY PARTIAL in a way a recording is not, and anything reading it
--  must say so rather than implying completeness.
--
--  The compensation is real too: because each browser reports its own speech,
--  we get WHO SAID WHAT — which the paid transcription does not give us at
--  all. Attribution is the thing that turns a wall of text into minutes.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THE SPEAKER IS NOT TAKEN FROM THE CLIENT
--
--  participant_id, not a name in the request body. The browser says what was
--  said; the server decides who said it, from the participant row the caller's
--  token already resolves to. A caption endpoint that accepted a display name
--  would let anybody in the meeting put words in anybody's mouth, in a
--  document that later gets emailed to a board as the minutes.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connect.caption_lines (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id     uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    -- Who. Resolved server-side from the caller's token, never sent by the
    -- browser. ON DELETE SET NULL so removing a participant row does not
    -- delete the meeting's record of what was said.
    participant_id uuid REFERENCES connect.participants(id) ON DELETE SET NULL,

    -- The line itself. Capped in the endpoint as well as here: a browser
    -- sending a megabyte of "text" is a bug or an attack, and neither should
    -- reach the notes model as though it were speech.
    text           text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),

    -- WHEN IT WAS SAID, as the client observed it, and it is worth being
    -- honest that this is client time. It is used for ORDERING lines from
    -- several browsers into one conversation, which is a job it does well
    -- enough even with a few seconds of clock skew. It is not evidence of
    -- when anything happened, and nothing should treat it as such.
    spoken_at      timestamptz NOT NULL,

    -- Server time, for the retention sweep and for spotting a client whose
    -- clock is wrong by an hour.
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The notes worker reads a whole meeting in spoken order; that is the only
-- query this table has.
CREATE INDEX IF NOT EXISTS ix_caption_lines_meeting
    ON connect.caption_lines (meeting_id, spoken_at);

COMMENT ON TABLE connect.caption_lines IS
    'Live captions from participants'' browsers, used to build a transcript '
    'with no transcription cost. STRUCTURALLY PARTIAL: Chrome only, and each '
    'browser hears only its own microphone. Chrome sends the audio to Google.';

-- ============================================================================
--  RLS — enabled AND forced. Deliberately a copy of the loop in
--  20260902-connect-recording.sql: same array shape, same format string, same
--  nullif(...,'') guard. A second, cleverer expression of the same rule is how
--  two tables end up disagreeing about tenancy.
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['caption_lines'] LOOP
        EXECUTE format('ALTER TABLE connect.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE connect.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON connect.%I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON connect.%I '
            'USING (EXISTS (SELECT 1 FROM connect.meetings m '
            '                WHERE m.id = meeting_id '
            '                  AND m.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid))', t);
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON connect.caption_lines TO tatvaos_app;

-- ============================================================================
--  Does this meeting have captions? Asked by the notes worker BEFORE it spends
--  anything on transcription.
--
--  SECURITY DEFINER and ids only, the same shape as every other queue in this
--  module: the worker runs with no tenant, takes an id, enters the tenant, and
--  does the ordinary thing under the policy.
-- ============================================================================
CREATE OR REPLACE FUNCTION connect.meetings_with_captions(p_limit integer DEFAULT 10)
RETURNS TABLE (meeting_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT DISTINCT c.meeting_id
      FROM connect.caption_lines c
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.meetings_with_captions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.meetings_with_captions(integer) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE 'connect captions:';
    RAISE NOTICE '    connect.caption_lines — free transcript from the browser, speaker attributed';
    RAISE NOTICE '    Chrome-only, and Chrome sends the audio to Google. Say so in the UI.';
END $$;

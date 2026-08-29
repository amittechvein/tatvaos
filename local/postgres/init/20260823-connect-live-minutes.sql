-- ============================================================================
--  TatvaOS Connect — live minutes, and the end of paid transcription.
--  Ruled by Amit, 22 August 2026.
-- ============================================================================
--
--  ONE SWITCH, WHERE PEOPLE LOOK.
--
--  Until now "will there be minutes" was answered by a transcription flag on
--  a recording, three screens away from anybody who cared, in language about
--  a mechanism rather than an outcome. Nobody asks for a transcript. They ask
--  whether there will be minutes.
--
--  So: one boolean on the meeting, one switch beside the meeting name, and
--  the mechanism underneath it changed completely.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHY THIS REPLACES TRANSCRIPTION RATHER THAN SITTING BESIDE IT.
--
--  Measured on a real 31-minute meeting: paid transcription cost Rs 16.6 and
--  the model that writes the minutes cost Rs 0.40. Turning speech into text
--  was 97% of the bill — and every participant's browser already does that
--  part, live, for nothing.
--
--  It is also BETTER for this purpose, not merely cheaper. A room-composite
--  recording is one mixed stream: nothing in it says who spoke, so the best
--  possible minutes say "somebody will send the pricing sheet". Captions come
--  from each person's own microphone, so they say "Rahul will send the
--  pricing sheet". Attribution is the whole value of minutes.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHAT IT COSTS, WHICH THE UI MUST SAY OUT LOUD.
--
--  Chrome's speech recognition SENDS AUDIO TO GOOGLE. This does not remove a
--  third party from the meeting; it changes which one, from a provider under
--  contract to one that is not. It is also partial by construction: Chrome
--  and Edge only, each browser hears only its own microphone, and signed-in
--  participants only until guest tickets exist.
--
--  Every one of those is surfaced where the switch is, and each person is
--  asked before their own microphone is captioned. Consent for a recording
--  belongs to the host; consent for sending your voice to Google belongs to
--  the person whose voice it is.
--
--  Additive and idempotent, applied before the containers start, and every
--  existing meeting keeps today's behaviour: off.
-- ============================================================================

ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS minutes_live boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN connect.meetings.minutes_live IS
    'Capture live captions from participants'' browsers, so the meeting gets '
    'attributed minutes. Off by default. Replaces the per-recording '
    'transcription flag, which cost 97% of the bill and could not attribute '
    'anything. See 20260823-connect-live-minutes.sql.';

DO $$
BEGIN
    RAISE NOTICE 'connect live minutes:';
    RAISE NOTICE '    meetings.minutes_live — off by default, host-controlled';
END $$;

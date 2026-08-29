-- ============================================================================
--  TatvaOS Connect — meeting mode: Private (E2EE) or Recorded.
--  Ruled by Amit 19 August 2026; spec in docs/CONNECT_PHASE_NEXT.md §1.
-- ============================================================================
--
--  One choice, made when the meeting is created, and it decides everything
--  downstream:
--
--    'private'   end-to-end encrypted. No recording, no auto-record, no
--                transcription, no AI notes. The media server forwards
--                packets it cannot decode, so there is nothing to record —
--                this is physics, not policy, and the refusals below exist
--                so the application never pretends otherwise.
--
--    'recorded'  recording, transcription and AI notes are available, with
--                the written and spoken notice. No E2EE.
--
--  Attendance, chat and minutes work in BOTH. None of them touches media:
--  the API writes participant rows at join, the SFU reports joins and leaves,
--  and chat rides the data channel. A Private meeting gets minutes that say
--  who came and what was typed, and say plainly that nothing was recorded —
--  the third provenance sentence 20260906 added already covers it.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THREE DECISIONS.
--
--  1. PLAIN TEXT COLUMN, CHECK CONSTRAINT — the same shape as waiting_room,
--     status and share_policy. EF maps a string property to a text column by
--     convention and needs NOTHING in AppDbContext, so this migration
--     crosses no lane. That is deliberate: connect.meeting_events.payload is
--     jsonb, was never mapped, and every insert failed 42804 silently from
--     the day the module shipped. A column type that needs a mapping is a
--     column type that can be forgotten.
--
--  2. DEFAULT 'recorded', SO EVERY EXISTING ROW BEHAVES EXACTLY AS TODAY.
--     A migration that changes what existing meetings do is not additive,
--     whatever the column count says.
--
--  3. THE MODE IS IMMUTABLE, AND THE DATABASE IS WHERE THAT IS ENFORCED.
--     See the trigger at the bottom, and its header for why.
--  ─────────────────────────────────────────────────────────────────────────
--
--  Idempotent and additive, like every migration here, and proven so: the
--  whole init directory was built three times against a scratch PostgreSQL
--  with this file in it, and once more with the column pre-existing.
--
--  Nothing in this file CREATE OR REPLACEs an object an earlier migration
--  owns — the 20260816 trap. It adds a column, a constraint and a trigger,
--  all its own, and touches no existing function.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1. The mode.
-- ----------------------------------------------------------------------------
ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'recorded';

-- ADD COLUMN IF NOT EXISTS skips its whole clause when the column already
-- exists, so a CHECK written inline would never be applied on the second
-- deploy. Named and added separately, the 20260905 share_policy pattern.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'meetings_mode_check'
           AND conrelid = 'connect.meetings'::regclass) THEN
        ALTER TABLE connect.meetings ADD CONSTRAINT meetings_mode_check
            CHECK (mode IN ('recorded','private'));
    END IF;
END $$;

COMMENT ON COLUMN connect.meetings.mode IS
    'recorded | private. Chosen at creation and IMMUTABLE thereafter (see '
    'the trigger below). ''private'' means end-to-end encrypted: no '
    'recording, auto-record, transcription or AI notes are possible, because '
    'the server cannot decode the media. Attendance, chat and minutes work '
    'in both modes — none of them touches media.';

-- ----------------------------------------------------------------------------
--  2. A private meeting cannot carry an auto-record request.
--
--  The webhook already re-reads the org flag and the storage gate before
--  acting on auto_record, and it will read the mode too. This constraint is
--  the second lock: it makes the contradictory ROW unrepresentable, so no
--  future code path — an endpoint, a script, a fix applied by hand at 2am —
--  can create a meeting that claims to be private and asks to be recorded.
--
--  The API must refuse this in words BEFORE the database refuses it in
--  SQLSTATE 23514, so that a person meets a sentence and never a 500. The
--  constraint is what makes the sentence true rather than merely intended.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'meetings_private_no_autorecord'
           AND conrelid = 'connect.meetings'::regclass) THEN
        ALTER TABLE connect.meetings ADD CONSTRAINT meetings_private_no_autorecord
            CHECK (mode <> 'private' OR auto_record = false);
    END IF;
END $$;

-- ----------------------------------------------------------------------------
--  3. The mode cannot change after the meeting is created.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHY THIS IS A TRIGGER AND NOT A LINE IN AN ENDPOINT.
--
--  The mode is not a preference. It is a promise made to everyone who joined:
--  they were told this meeting is private, and they spoke accordingly. A host
--  who could flip 'private' to 'recorded' mid-meeting would retroactively
--  make recordable a conversation people entered under the opposite
--  assurance — and nobody in the room would see it happen.
--
--  This platform already puts the promises it will not break in the database
--  rather than in application code: tenancy is RLS, forced, on a NOBYPASSRLS
--  role, precisely so that a forgotten WHERE clause cannot leak a tenant.
--  Same reasoning, smaller scope. The UpdateMeetingRequest DTO will not carry
--  a mode field, which is the first lock; this is the one that still holds
--  when somebody adds the field back in six months without knowing why it
--  was absent.
--
--  It fires only when the mode ACTUALLY changes, so every ordinary update —
--  status to 'ended', started_at, locked, the title — passes untouched.
--
--  Escape hatch, stated so it is not discovered in an emergency: the table
--  owner can ALTER TABLE connect.meetings DISABLE TRIGGER
--  trg_meetings_mode_immutable, do the surgery, and re-enable it. That is a
--  deliberate act with a name, which is the point.
--  ─────────────────────────────────────────────────────────────────────────
--  THE MESSAGE IS PART OF THE FEATURE. Whoever meets this exception will be
--  a developer six months from now, mid-incident, with no idea this rule
--  exists — so it names the rule, the reason, and where the reasoning is
--  written down, rather than saying "update rejected" and leaving them to
--  guess whether they have found a bug or a boundary.
CREATE OR REPLACE FUNCTION connect.meetings_mode_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.mode IS DISTINCT FROM OLD.mode THEN
        RAISE EXCEPTION
            'connect.meetings.mode is immutable: meeting % was created as ''%'' '
            'and cannot become ''%''.', OLD.id, OLD.mode, NEW.mode
            USING
                ERRCODE = 'check_violation',
                DETAIL  = 'The mode is a promise made to everyone who already joined '
                       || 'under it. Changing ''private'' to ''recorded'' would make '
                       || 'recordable a conversation people entered believing it could '
                       || 'not be, and nobody in the room would see it happen.',
                HINT    = 'This is a boundary, not a bug. If the mode genuinely must '
                       || 'differ, create a new meeting. The reasoning is in '
                       || 'local/postgres/init/20260908-connect-meeting-mode.sql and '
                       || 'docs/CONNECT_PHASE_NEXT.md section 1. To override for a '
                       || 'one-off repair: ALTER TABLE connect.meetings DISABLE TRIGGER '
                       || 'trg_meetings_mode_immutable, then re-enable it.';
    END IF;
    RETURN NEW;
END;
$$;

--  ─────────────────────────────────────────────────────────────────────────
--  CREATE OR REPLACE TRIGGER, AND NOT "DROP IF EXISTS THEN CREATE".
--  DO NOT "FIX" THIS BACK TO THE DROP PATTERN.
--
--  This file re-runs on EVERY deploy, and deploy.sh runs it with
--  ON_ERROR_STOP but WITHOUT --single-transaction — so every statement
--  autocommits on its own. A DROP followed by a CREATE therefore leaves a
--  real window, on the live database, in which this trigger does not exist
--  and the mode is silently mutable. Milliseconds, and the odds of an UPDATE
--  landing inside one are small — but it would reopen on every deploy, for
--  ever, and the whole reason this trigger exists is to keep a promise that
--  must not be suspended on a schedule.
--
--  It is the same shape as the unwrapped function swap that
--  20260819-space-link-loss-logging.sql wraps in BEGIN/COMMIT for exactly
--  this reason, and the same family as the 20260816 trap cited at the top of
--  this file. I wrote the header quoting that lesson and then made the
--  mistake one layer down; Core caught it in review.
--
--  CREATE OR REPLACE TRIGGER is atomic — no window at all — and needs
--  PostgreSQL 14+; production is 17. It also sidesteps the 20260816
--  return-type trap by construction, because a trigger has no return type to
--  fight over. BEGIN/COMMIT around DROP+CREATE would also work; this is
--  simpler and has nothing to forget.
--
--  A KNOWN KNOB, not a discovery: the trigger fires per row on every
--  meetings UPDATE, whether the mode changed or not. At our volumes that is
--  nothing, and the behavioural checks confirm ordinary updates pass. If
--  meetings updates ever become hot, adding
--      WHEN (OLD.mode IS DISTINCT FROM NEW.mode)
--  moves the test ahead of the function call. Deliberately not done now.
--  ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TRIGGER trg_meetings_mode_immutable
    BEFORE UPDATE ON connect.meetings
    FOR EACH ROW
    EXECUTE FUNCTION connect.meetings_mode_is_immutable();

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Connect meeting mode:';
    RAISE NOTICE '    meetings.mode — recorded (default, today''s behaviour) | private';
    RAISE NOTICE '    a private meeting cannot hold auto_record = true';
    RAISE NOTICE '    the mode is immutable once the meeting exists';
    RAISE NOTICE '';
END $$;

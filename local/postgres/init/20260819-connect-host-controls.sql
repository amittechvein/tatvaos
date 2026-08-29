-- ============================================================================
--  TatvaOS Connect — host controls: auto-record, share policy, and a
--  blocklist that makes "Remove" mean removed.
-- ============================================================================
--
--  Three small additions, each one closing a gap a host will hit in their
--  first week of real meetings:
--
--  1. AUTO-RECORD IS A FLAG ON THE MEETING, ACTED ON BY THE WEBHOOK.
--     The host asks at creation time; the room_started webhook is what
--     actually starts the egress, because that is the moment the media server
--     says the meeting exists. The THREE GATES from 20260818 still apply at
--     that moment — org flag, storage headroom — re-read when the room
--     starts, not trusted from creation time. An org that switches recording
--     off between scheduling and starting gets no recording, silently, which
--     is the org switch doing its job.
--
--  2. WHO MAY SHARE A SCREEN IS THE MEETING'S SETTING, ENFORCED BY THE TOKEN.
--     'everyone' is the default because that is what the product does today —
--     this migration must not change the behaviour of existing meetings.
--     The enforcement is LiveKit's canPublishSources grant, minted server-side
--     from this column and the caller's role in the DATABASE — never from a
--     claim in anybody's token. A policy change mid-meeting is pushed to
--     connected participants through UpdateParticipant.
--
--  3. REMOVED MEANS REMOVED. connect.meeting_blocks records who a host threw
--     out. The join path refuses a blocked user; the admit path refuses to
--     admit one. It is keyed on user_id, which is the only STABLE handle we
--     have: a guest gets a fresh participant row (and a fresh identity) every
--     time they come through the door, so a guest cannot be usefully
--     blocklisted — for guests the waiting room IS the control, and Remove
--     already cancels their admitted lobby rows so they land back in it.
--     The identity is recorded anyway, for the audit trail.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1. Auto-record.
-- ----------------------------------------------------------------------------
ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS auto_record boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN connect.meetings.auto_record IS
    'Start an audio recording when the room starts. Acted on by the '
    'room_started webhook, and STILL behind the org''s allow_connect_recording '
    'flag and the storage gate at that moment — this is a request, not a bypass.';

-- ----------------------------------------------------------------------------
--  2. Share policy.
--
--  'everyone' keeps today's behaviour for every existing meeting. The CHECK
--  lives in a named constraint added defensively, because ADD COLUMN IF NOT
--  EXISTS skips the whole clause when the column already exists and a re-run
--  must not error.
-- ----------------------------------------------------------------------------
ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS share_policy text NOT NULL DEFAULT 'everyone';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'meetings_share_policy_check'
           AND conrelid = 'connect.meetings'::regclass) THEN
        ALTER TABLE connect.meetings ADD CONSTRAINT meetings_share_policy_check
            CHECK (share_policy IN ('host','cohost','everyone'));
    END IF;
END $$;

COMMENT ON COLUMN connect.meetings.share_policy IS
    'Who may share a screen: host | cohost (host + cohosts) | everyone. '
    'Enforced in the LiveKit token (canPublishSources) minted from the '
    'caller''s role in connect.participants — never from a client claim.';

-- ----------------------------------------------------------------------------
--  3. The blocklist.
--
--  No tenant_id, deliberately — scoped through the parent meeting exactly as
--  participants, lobby_requests and meeting_events are, so a block row cannot
--  disagree with its meeting about which tenant it belongs to.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.meeting_blocks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id          uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    -- The stable handle. NULL for a guest, whose block is advisory only —
    -- see the header. ON DELETE CASCADE rather than SET NULL: a block on a
    -- user who no longer exists protects nothing.
    user_id             uuid REFERENCES core.users(id) ON DELETE CASCADE,

    -- What the audit trail keeps: who they appeared as when they were removed.
    identity            text NOT NULL,
    display_name        text NOT NULL DEFAULT '',

    blocked_by_user_id  uuid REFERENCES core.users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- One block per signed-in person per meeting; re-removing them is a no-op,
-- not a second row. Partial because guests all carry NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_meeting_blocks_meeting_user
    ON connect.meeting_blocks (meeting_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_meeting_blocks_meeting
    ON connect.meeting_blocks (meeting_id);

-- RLS — enabled AND forced, scoped through the meeting, the child-table
-- pattern from 20260817 verbatim.
DO $$
BEGIN
    EXECUTE 'ALTER TABLE connect.meeting_blocks ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE connect.meeting_blocks FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON connect.meeting_blocks';
    EXECUTE 'CREATE POLICY tenant_isolation ON connect.meeting_blocks '
         || 'USING (EXISTS (SELECT 1 FROM connect.meetings m '
         || '                WHERE m.id = meeting_id '
         || '                  AND m.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid))';
END $$;

-- Default privileges from 20260817 normally cover a new table; the explicit
-- grant is here so this migration does not depend on which role created what.
GRANT SELECT, INSERT, UPDATE, DELETE ON connect.meeting_blocks TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Connect host controls:';
    RAISE NOTICE '    meetings.auto_record   — the room_started webhook starts an audio egress (org gates still apply)';
    RAISE NOTICE '    meetings.share_policy  — host | cohost | everyone, enforced in the LiveKit token';
    RAISE NOTICE '    meeting_blocks         — a removed signed-in participant cannot rejoin or be admitted';
    RAISE NOTICE '';
END $$;

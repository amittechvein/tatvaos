-- ============================================================================
--  Meeting invitations by email.
--
--  Amit's decision, 17 September 2026: "Invite on the meeting". The host
--  types addresses on a Connect meeting; each address gets an email with the
--  join link and, for a scheduled meeting, a calendar invitation (iMIP,
--  METHOD:REQUEST) so it lands in Gmail and Outlook calendars. Moving the
--  meeting re-sends it with a higher SEQUENCE; cancelling sends METHOD:CANCEL.
--
--  ONE ROW PER PERSON PER MEETING. The row is the record of who was invited
--  and whether the email actually went: `status` is what the mail submission
--  answered, never an optimistic 'sent' written before trying. A host asking
--  "did Ravi get it?" is answered by this row.
--
--  ADDITIVE ONLY: one new table, one new column with a constant default. Every
--  existing meeting keeps invite_sequence 0 and has no invitations. Re-running
--  this file on every deploy changes nothing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connect.meeting_invitations (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL,
    meeting_id          uuid        NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    -- Lower-cased and trimmed by the application before insert; the unique
    -- index below is on lower(email) anyway so a mixed-case caller cannot
    -- invite the same person twice.
    email               text        NOT NULL,

    invited_by_user_id  uuid,

    -- pending    saved, not yet attempted (the request is still running)
    -- sent       OUR mail server accepted it. Not "delivered": nothing here
    --            learns about a bounce (CTO, 17 Sept: the bounce pipeline has
    --            never been proven end to end), and the page says so.
    -- failed     our mail server refused it or could not be reached; `note` says why
    -- not_sent   deliberately not attempted (e.g. the sender has no mailbox)
    -- withdrawn  the host took it back. The row is KEPT, not deleted, because
    --            its sequence_sent is what a later re-invite must exceed: a
    --            REQUEST at or below the SEQUENCE of the CANCEL that person
    --            already holds is ignored by their calendar.
    status              text        NOT NULL DEFAULT 'pending',
    note                text,

    -- The RFC 5545 SEQUENCE of the last message this person received. Every
    -- message to a person goes out strictly higher than this (and never lower
    -- than meetings.invite_sequence). Lower than the meeting's means the
    -- meeting changed after they were last told.
    sequence_sent       integer,

    created_at          timestamptz NOT NULL DEFAULT now(),
    last_sent_at        timestamptz,

    CONSTRAINT meeting_invitations_email_shape CHECK (position('@' in email) > 1 AND length(email) <= 320)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_invitations_status_check') THEN
        ALTER TABLE connect.meeting_invitations
            ADD CONSTRAINT meeting_invitations_status_check
            CHECK (status IN ('pending', 'sent', 'failed', 'not_sent', 'withdrawn'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS meeting_invitations_meeting_email_uq
    ON connect.meeting_invitations (meeting_id, lower(email));
CREATE INDEX IF NOT EXISTS meeting_invitations_tenant_idx
    ON connect.meeting_invitations (tenant_id);

-- RFC 5545 SEQUENCE for this meeting's invitation. Bumped when a sent
-- invitation has to be replaced (time or title changed) or withdrawn
-- (cancelled). Without it a re-sent invitation is ignored by the receiving
-- calendar as a duplicate.
ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS invite_sequence integer NOT NULL DEFAULT 0;

-- ============================================================================
--  RLS — the same shape as every connect.* table. FORCE, because migrations
--  run as the owner and the owner would otherwise bypass the policy. Connect
--  entities carry no EF query filter; this policy is the tenant fence.
-- ============================================================================
ALTER TABLE connect.meeting_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.meeting_invitations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON connect.meeting_invitations;
CREATE POLICY tenant_isolation ON connect.meeting_invitations
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON connect.meeting_invitations TO tatvaos_app;

-- ============================================================================
--  RETENTION — 90 days after the meeting is over (Amit, 17 Sept 2026).
--
--  This table accumulates the email addresses of people OUTSIDE the
--  organisation, who never agreed to be kept anywhere. 90 days leaves room to
--  resend or to answer "who was invited", and then they go. "Over" means ended
--  or cancelled, or a scheduled meeting whose time passed without either.
--
--  SECURITY DEFINER because the sweep runs with no tenant set, which RLS
--  (correctly) refuses; the window is in here and not a parameter, so no
--  caller can pass a shorter one — the same shape as core.sweep_handoff_codes.
--  Called hourly by ConnectNotesWorker, which already wakes every minute.
-- ============================================================================
CREATE OR REPLACE FUNCTION connect.sweep_meeting_invitations()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    WITH gone AS (
        DELETE FROM connect.meeting_invitations i
         USING connect.meetings m
         WHERE m.id = i.meeting_id
           AND (
                 (m.status IN ('ended', 'cancelled')
                    AND coalesce(m.ended_at, m.updated_at) < now() - interval '90 days')
              OR (m.status = 'scheduled'
                    AND coalesce(m.scheduled_end, m.scheduled_start) < now() - interval '90 days')
               )
        RETURNING 1
    )
    SELECT count(*)::int FROM gone;
$$;
REVOKE ALL ON FUNCTION connect.sweep_meeting_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.sweep_meeting_invitations() TO tatvaos_app;

COMMENT ON TABLE connect.meeting_invitations IS
    'One row per person invited to a Connect meeting by email, with what the send actually answered.';
COMMENT ON COLUMN connect.meetings.invite_sequence IS
    'RFC 5545 SEQUENCE of this meeting''s email invitation; bumped on reschedule and cancel.';

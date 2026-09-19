-- ============================================================================
--  A guest proves a mobile number at the door, and is one row per meeting.
--
--  Amit, 19 Sept 2026: "if any guest join give mobile verification via otp and
--  if he join back to same meeting with same no direct entry count that person
--  one time entry". Asked the evening a live company meeting locked its guests
--  out: every guest join, reload and dropped connection wrote a NEW row in
--  connect.participants, the per-meeting ceiling counted rows, and at 200 rows
--  everybody new was told the link did not work
--  (ConnectGuestEndpoints.PerMeetingGuestCeiling has the incident).
--
--  WHAT IS STORED IS NOT THE NUMBER. guest_phone_hash is an HMAC of it, keyed by
--  a server secret and bound to the meeting (ConnectGuestPhone.Hash says why a
--  plain hash would not do). Nobody reading this table - the host, us, or
--  whoever steals a backup - learns a phone number from it, and the same person
--  in two meetings is two unrelated values.
--
--  ONE ROW PER NUMBER PER MEETING is enforced HERE, by the unique index, and not
--  only in the endpoint: two tabs verifying the same number in the same second
--  must not make two rows, and "the API checks first" is a race.
--
--  NOTHING HERE TURNS THE FEATURE ON. The switch is the platform setting
--  connect.guest_phone_otp, off unless the operator sets it. With it off these
--  columns stay NULL and this table stays empty.
--
--  POSITION ON THIS DATE. Depends on connect.participants and connect.meetings
--  (20260817-connect.sql). 20260919-connect-invitation-caps.sql shares the date
--  and sorts AFTER this file ('-b-' before '-connect-'); neither mentions the
--  other's objects, so the order between them carries nothing.
--
--  Additive, and idempotent: every file here re-runs on every deploy.
-- ============================================================================

ALTER TABLE connect.participants
    ADD COLUMN IF NOT EXISTS guest_phone_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_meeting_guest_phone
    ON connect.participants (meeting_id, guest_phone_hash)
    WHERE guest_phone_hash IS NOT NULL;

COMMENT ON COLUMN connect.participants.guest_phone_hash IS
    'HMAC of a guest''s verified mobile number, bound to this meeting. Never the '
    'number. NULL for colleagues, and for guests who joined while '
    'connect.guest_phone_otp was off.';

-- ----------------------------------------------------------------------------
--  The code in flight. One row per number per meeting; a resend overwrites it.
--  Kept after it is used: `sends` is how "five texts to one number, ever" is
--  counted, and deleting the row would reset the count.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.guest_otps (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id  uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,
    phone_hash  text NOT NULL,
    -- NULL once used or once it has been guessed at too often.
    otp_hash    text,
    sent_at     timestamptz NOT NULL DEFAULT now(),
    attempts    integer NOT NULL DEFAULT 0,
    sends       integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ux_guest_otps_meeting_phone UNIQUE (meeting_id, phone_hash)
);

-- A child of connect.meetings with no tenant_id of its own, scoped through the
-- meeting exactly as participants and lobby_requests are (20260817-connect.sql).
ALTER TABLE connect.guest_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.guest_otps FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON connect.guest_otps;
CREATE POLICY tenant_isolation ON connect.guest_otps
    USING (EXISTS (SELECT 1 FROM connect.meetings m
                    WHERE m.id = meeting_id
                      AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON connect.guest_otps TO tatvaos_app;

COMMENT ON TABLE connect.guest_otps IS
    'The verification code a guest was texted at a meeting''s door. Holds an HMAC '
    'of the number and of the code, never either one. One row per number per '
    'meeting; sends counts every text ever sent to it for that meeting.';

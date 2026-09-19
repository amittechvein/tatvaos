-- ============================================================================
--  Email-invitation caps, per organisation.
--
--  Amit, 19 Sept 2026. A 300-person meeting met "Invite at most 50 people at a
--  time", and behind it a second cap of 200 per meeting. Both constants went to
--  500 the same day (PR 178). This file lets them differ BY ORGANISATION, and
--  Amit's ruling on who turns the dial: the platform operator only, from the
--  super-admin console. Not the organisation's own administrator - these caps
--  are the only guard on outbound invitation mail (MailSendApiEndpoints says
--  outbound mail has no quota anywhere else), and a guard its subject can lift
--  is not a guard.
--
--  NULL MEANS "THE PLATFORM DEFAULT", and a missing row means the same. So
--  there is no backfill, nothing here changes what any organisation may do
--  today, and raising the default later raises it for everyone who was never
--  given a number of their own. The default lives in ONE place,
--  ConnectInvitations.MaxPerRequest / MaxPerMeeting, not here as a column
--  default - two copies of one fact is rule 10.
--
--  WHO CAN WRITE THESE COLUMNS. tatvaos_app already holds UPDATE on this
--  table, because an organisation's administrator flips
--  allow_public_recording_links through ConnectShareEndpoints. That endpoint
--  names the one column it sets and never binds a request body to the row, so
--  the organisation cannot reach these two. The only writer is
--  ConnectInvitationCapEndpoints, behind the SuperAdmin policy. If a second
--  writer to this table is ever added, this paragraph is what it must keep true.
--
--  POSITION ON THIS DATE. Depends only on connect.tenant_settings
--  (20260908-b-connect-recording-shares.sql). Nothing else dated 20260919
--  exists, so there is no letter.
--
--  Additive: two nullable columns with no default are a metadata change, no
--  table rewrite. Re-runs on every deploy and changes nothing the second time.
-- ============================================================================

ALTER TABLE connect.tenant_settings
    ADD COLUMN IF NOT EXISTS invite_max_per_request integer,
    ADD COLUMN IF NOT EXISTS invite_max_per_meeting integer;

-- The application validates first (ConnectInvitations.CapProblem) and says
-- which number is wrong in words. This is the backstop for a caller that
-- forgets. 2000 is ConnectInvitations.CapCeiling: the mails go out one by one
-- inside one web request, and nobody has measured a request that long.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_settings_invite_caps_valid'
           AND conrelid = 'connect.tenant_settings'::regclass
    ) THEN
        ALTER TABLE connect.tenant_settings
            ADD CONSTRAINT tenant_settings_invite_caps_valid
            CHECK (
                (invite_max_per_request IS NULL OR invite_max_per_request BETWEEN 1 AND 2000)
            AND (invite_max_per_meeting IS NULL OR invite_max_per_meeting BETWEEN 1 AND 2000)
            );
    END IF;
END $$;

COMMENT ON COLUMN connect.tenant_settings.invite_max_per_request IS
    'Most addresses one Send may carry. NULL = the platform default '
    '(ConnectInvitations.MaxPerRequest). Set only by the platform operator.';

COMMENT ON COLUMN connect.tenant_settings.invite_max_per_meeting IS
    'Most standing email invitations one meeting may hold. NULL = the platform '
    'default (ConnectInvitations.MaxPerMeeting). Set only by the platform operator.';

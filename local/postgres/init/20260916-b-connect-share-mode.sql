-- ============================================================================
--  Screen sharing: one at a time, or several at once — the host chooses.
--
--  docs/CONNECT_PHASE_NEXT.md §4, decided. `share_mode` sits BESIDE
--  `share_policy` and answers a different question:
--
--      share_policy   WHO may share          host | cohost | everyone
--      share_mode     HOW MANY AT ONCE       multiple | single
--
--  DEFAULT 'multiple' — today's behaviour, which is deliberate and tested
--  (feature 71). Every existing meeting keeps exactly what it had, and a
--  re-run of this file on every deploy changes nothing.
--
--  ENFORCEMENT IS NOT HERE. The permission to publish a screen lives in LiveKit
--  grants that a column cannot reach, so it is applied live by
--  ConnectShareEnforcement on the track_published / track_unpublished webhooks.
--  A 'single' meeting whose webhooks are not arriving still lets two people
--  share: the column is the intent, the grants are the enforcement.
--
--  Additive: a new column with a constant default is a metadata change in
--  Postgres 11+, so it neither rewrites the table nor fires the trigger that
--  keeps `mode` immutable (20260908-connect-meeting-mode.sql).
-- ============================================================================

ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS share_mode text NOT NULL DEFAULT 'multiple';

-- The application validates too; this is the backstop that still holds if a
-- future caller forgets (ConnectShare.IsValidMode).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'meetings_share_mode_valid'
           AND conrelid = 'connect.meetings'::regclass
    ) THEN
        ALTER TABLE connect.meetings
            ADD CONSTRAINT meetings_share_mode_valid
            CHECK (share_mode IN ('multiple', 'single'));
    END IF;
END $$;

COMMENT ON COLUMN connect.meetings.share_mode IS
    'How many people may share a screen at once: multiple (default) or single. '
    'Enforced live through LiveKit grants by ConnectShareEnforcement on the '
    'track webhooks, not by this column.';

-- ----------------------------------------------------------------------------
--  Report what is here, rather than assert what should be (rule 6).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    single_n int;
    multiple_n int;
BEGIN
    SELECT count(*) FILTER (WHERE share_mode = 'single'),
           count(*) FILTER (WHERE share_mode = 'multiple')
      INTO single_n, multiple_n
      FROM connect.meetings;

    RAISE NOTICE '';
    RAISE NOTICE '  connect.meetings.share_mode ready: % single, % multiple', single_n, multiple_n;
    RAISE NOTICE '  enforcement is the track webhooks, not this column';
    RAISE NOTICE '';
END $$;

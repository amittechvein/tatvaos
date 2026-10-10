-- ============================================================================
--  People — prove it is you before seeing a full identifier (0015 §5)
-- ============================================================================
--
--  Depends on 20261010-people-identifiers.sql. "-z-" so it sorts AFTER it:
--  files run in plain string order, and "20261010-b-" would sort before
--  "20261010-people-" and run first.
--
--  MR. SINGH, 10 Oct 2026 (ruling 1 on #448): before the first reveal the
--  person proves they are present - their authenticator code if they have
--  one, their password if not - and that unlocks about ten minutes, for that
--  person, in that sign-in only. The threats: an HR person's unlocked screen
--  at lunch, and a stolen session token. Per-number prompts were ruled OUT:
--  unusable controls get worked around by exporting to a spreadsheet.
--
--  ONE ROW PER (person, sign-in). session_id is the refresh-token family the
--  access token names in its "sid" claim. The API counts a row only while
--    * expires_at is in the future (ten minutes from the proof, not sliding),
--    * the row's user is the caller (never crosses users), and
--    * that family still has a live refresh token - so signing out, "sign out
--      everywhere", a password change or a replay kill ends the window with
--      no clean-up step to forget.
--  Every reveal inside the window is still one people.identifier_reads row.
--
--  Purely additive. Re-runnable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS people.identifier_unlocks (
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL,
    session_id   uuid NOT NULL,
    proof        text NOT NULL CHECK (proof IN ('mfa', 'password')),
    unlocked_at  timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, user_id, session_id),
    CONSTRAINT ck_identifier_unlock_window CHECK (expires_at > unlocked_at AND expires_at <= unlocked_at + interval '15 minutes'),
    CONSTRAINT fk_identifier_unlock_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES core.users (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE people.identifier_unlocks IS
    'Re-authentication before revealing identifiers (Mr. Singh 10 Oct 2026): ~10 minutes, one person, one sign-in (session_id = refresh family).';

GRANT SELECT, INSERT, UPDATE ON people.identifier_unlocks TO tatvaos_app;

ALTER TABLE people.identifier_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE people.identifier_unlocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON people.identifier_unlocks;
CREATE POLICY tenant_isolation ON people.identifier_unlocks
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

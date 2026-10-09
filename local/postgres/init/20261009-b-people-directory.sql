-- ============================================================================
--  People — the staff directory's settings (decision 0018 §5)
-- ============================================================================
--
--  Depends on 20261009-people-employees.sql (same date, sorts after it).
--
--  0018 §5, decided by Amit on 9 Oct 2026 (Mr. Singh recommended it): the
--  directory shows colleagues each other's name, designation, department,
--  location, work email and manager — and NOT employee code, status, joining
--  or exit dates, or employment type. "On notice" in a staff list would tell
--  everyone that someone is leaving before they have said so. Those fields
--  are not narrowed by a setting: the directory never returns them at all
--  (PeopleAccess.DirectoryAsync's projection; tests/people step 13 checks the
--  exact set of fields).
--
--  What an organisation MAY narrow (Amit: yes), held here:
--    * visible_to  'everyone' (default) | 'hr_only' — some schools will not
--      want staff to see each other at all;
--    * show_manager — the one field with an edge (Mr. Singh): in a small
--      organisation, everyone's manager is the whole hierarchy.
--  No row = the defaults. Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS people.directory_settings (
    tenant_id     uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    visible_to    text NOT NULL DEFAULT 'everyone' CHECK (visible_to IN ('everyone', 'hr_only')),
    show_manager  boolean NOT NULL DEFAULT true,
    updated_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE people.directory_settings IS
    'How much of the staff directory colleagues see (0018 §5). Narrowing only: the hidden fields are never returned.';

GRANT SELECT, INSERT, UPDATE ON people.directory_settings TO tatvaos_app;

ALTER TABLE people.directory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE people.directory_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON people.directory_settings;
CREATE POLICY tenant_isolation ON people.directory_settings
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

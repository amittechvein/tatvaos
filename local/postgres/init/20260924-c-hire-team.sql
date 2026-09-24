-- ============================================================================
--  TatvaOS Hire — the hiring team (recruiters and hiring managers)
-- ============================================================================
--
--  Depends on 20260924-b-hire-job-openings.sql (hire schema, and the
--  ux_core_users_tenant_id index this file's foreign key needs).
--
--  Amit, 24 September 2026: people with a recruiter or hiring-manager role
--  manage job openings too, not only organisation administrators.
--
--  A HIRE ROLE, NOT A TatvaOS ROLE. core.users.role is a sign-in permission
--  owned by Core (employee / manager / org_admin ...). Being a recruiter is a
--  job inside one product, and it lives here, in Hire's own table:
--    * giving someone Hire access never widens what they can do in Mail, the
--      console or anywhere else;
--    * People (R5) will have its own team the same way;
--    * the Hire & People welcome's rule — employment facts do not go on
--      core.users — covers this too.
--
--  One row per person: recruiter or hiring_manager, not both. A recruiter
--  can already do everything a hiring manager can.
--
--  What each may do is enforced by the API (Modules/Hire/HireAccess.cs):
--    recruiter       every job opening in the organisation
--    hiring_manager  only the jobs that name them as hiring manager
--  Administrators (org_owner / org_admin / super_admin) need no row, and only
--  they may change this table — a recruiter cannot hand out access.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hire.team_members (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    role        text NOT NULL CHECK (role IN ('recruiter', 'hiring_manager')),
    added_by    uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    -- Pinned to the same organisation, as every Hire reference is: a
    -- Techvein team cannot contain an ABC School person, even if the API's
    -- lookup were skipped. Deleting the person removes their Hire access.
    CONSTRAINT fk_team_member_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES core.users (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE hire.team_members IS
    'Who may use TatvaOS Hire besides administrators (Amit, 24 Sept 2026). '
    'A Hire role, deliberately NOT core.users.role.';

GRANT SELECT, INSERT, UPDATE, DELETE ON hire.team_members TO tatvaos_app;

ALTER TABLE hire.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire.team_members FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hire.team_members;
CREATE POLICY tenant_isolation ON hire.team_members
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE
    pol int;
BEGIN
    SELECT count(*) INTO pol FROM pg_policies
     WHERE schemaname = 'hire' AND tablename = 'team_members' AND policyname = 'tenant_isolation';
    RAISE NOTICE '';
    RAISE NOTICE '  hire.team_members: tenant_isolation policy %', CASE WHEN pol = 1 THEN 'present' ELSE 'MISSING' END;
    IF pol <> 1 THEN
        RAISE WARNING '  hire.team_members has no tenant_isolation policy';
    END IF;
    RAISE NOTICE '';
END $$;

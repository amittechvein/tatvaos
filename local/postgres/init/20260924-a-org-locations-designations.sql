-- ============================================================================
--  Locations and designations — the first two missing Phase 0 tables
-- ============================================================================
--
--  Hire & People, Phase 0 (docs/TATVAOS_HR_ROADMAP.md §2, §6.1). A job opening
--  names a department, a designation and a location; departments exist, these
--  two did not. Both are organisation structure, not HR records, so they sit
--  in core beside core.departments — People will read the same rows when it
--  arrives, and neither product owns the office list.
--
--  WHAT THIS FILE DELIBERATELY DOES NOT ADD. The other two missing Phase 0
--  items — reporting hierarchy and employee-ID configuration — describe
--  EMPLOYEES, and there is no employee table yet. Building them now would mean
--  hanging a manager and an employee number off core.users, which is the one
--  thing the Hire & People welcome forbids: a user is a login, an employee is a
--  person with a manager, and they are not the same row. They land with
--  people.employees.
--
--  ROW-LEVEL SECURITY, UNLIKE core.departments. Departments carry no RLS
--  because the mail edge reads them before any tenant is known (routing data,
--  0000-core-schema.sql). Nothing reads a location or a designation without a
--  tenant, so these get the full fence: FORCE, and the nullif() policy so an
--  unset tenant answers zero rows instead of throwing.
--
--  ARCHIVE, NOT DELETE, ONCE IN USE. is_active = false hides a row from new
--  choices while every job opening and employee that already names it keeps
--  its meaning. The API refuses a delete on a row something references; today
--  nothing does, so delete is allowed and written to the audit log.
--
--  Names are unique per organisation, case-insensitively: "Pune" and "pune"
--  are the same office, and two of them in a dropdown is a support ticket.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.locations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- "Pune office", "Ranchi campus", "Remote". What people pick from.
    name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),

    -- Optional short code an organisation already uses on paper ("PNQ-1").
    code         text CHECK (code IS NULL OR length(code) BETWEEN 1 AND 20),

    address_line text CHECK (address_line IS NULL OR length(address_line) <= 300),
    city         text CHECK (city IS NULL OR length(city) <= 100),
    state        text CHECK (state IS NULL OR length(state) <= 100),
    postal_code  text CHECK (postal_code IS NULL OR length(postal_code) <= 20),
    -- ISO 3166-1 alpha-2. India first, not India only.
    country      text NOT NULL DEFAULT 'IN' CHECK (country ~ '^[A-Z]{2}$'),

    -- True for "Remote" and "Work from home": a location that is not a place.
    -- Attendance will need to know the difference; recorded now so it does
    -- not have to be guessed from the name later.
    is_remote    boolean NOT NULL DEFAULT false,

    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_core_locations_tenant_name
    ON core.locations (tenant_id, lower(btrim(name)));

COMMENT ON TABLE core.locations IS
    'Where an organisation works: offices, campuses, Remote. Phase 0 of Hire & People (24 Sept 2026).';

CREATE TABLE IF NOT EXISTS core.designations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- "Senior Software Engineer", "PGT Physics". A job title, not a role:
    -- core.users.role decides what a person may DO in TatvaOS; a designation
    -- says what they are called at work. Conflating them is how a Principal
    -- ends up an org_admin by accident.
    title        text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),

    -- Optional grade or band ("L3", "E2"). Free text because every company
    -- spells it differently.
    grade        text CHECK (grade IS NULL OR length(grade) <= 20),

    -- Optional seniority for ordering lists: higher is more senior. NULL
    -- sorts last. Not used for any permission, ever.
    level        integer CHECK (level IS NULL OR level BETWEEN 0 AND 100),

    description  text CHECK (description IS NULL OR length(description) <= 500),

    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_core_designations_tenant_title
    ON core.designations (tenant_id, lower(btrim(title)));

COMMENT ON TABLE core.designations IS
    'Job titles an organisation uses. NOT core.users.role, which is a permission. Phase 0 of Hire & People (24 Sept 2026).';

-- ---- grants and the fence ---------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON core.locations    TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.designations TO tatvaos_app;

ALTER TABLE core.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.locations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.locations;
CREATE POLICY tenant_isolation ON core.locations
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE core.designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.designations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.designations;
CREATE POLICY tenant_isolation ON core.designations
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Reports what is there rather than asserting it: the policy count is read
-- back, so a file that silently failed to create one says so.
DO $$
DECLARE
    n int;
BEGIN
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'core' AND tablename IN ('locations', 'designations')
       AND policyname = 'tenant_isolation';
    RAISE NOTICE '';
    RAISE NOTICE '  core.locations, core.designations: % of 2 tenant_isolation policies present', n;
    IF n < 2 THEN
        RAISE WARNING '  expected 2 tenant_isolation policies on locations/designations, found %', n;
    END IF;
    RAISE NOTICE '';
END $$;

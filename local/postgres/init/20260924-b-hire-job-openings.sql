-- ============================================================================
--  TatvaOS Hire — job openings
-- ============================================================================
--
--  Depends on 20260924-a-org-locations-designations.sql (same date, sorts
--  first): a job opening names a location and a designation.
--
--  R1 of the Hire roadmap (docs/TATVAOS_HR_ROADMAP.md §3, Phase 1). Amit,
--  24 September 2026: Hire is hire.tatvaos.com for every customer, and each
--  customer's careers page lives on OUR domain first — so a published job
--  opening carries a slug, which is what its public address is built from.
--
--  THE SLUG IS SET AT FIRST PUBLISH, NOT AT CREATE (Mr. Singh, 24 Sept).
--  Draft titles are routinely not the published ones, and the difference is
--  usually the confidential part: "Head of Maths — replacing Sharma" renamed
--  to "Head of Maths" before it goes out must not leave "replacing-sharma" in
--  a public URL forever. A slug only has to be stable once something outside
--  can link to it, which is publication. So it is NULL on a draft that was
--  never published, fixed at first publish, and never rewritten after —
--  unpublish/republish keeps it. The random part is TEN characters: on a
--  public careers domain an unlisted job is protected by its slug alone.
--
--  Nothing public reads this table yet; the careers portal is a later change
--  with its own review (roadmap §6.2).
--
--  ---------------------------------------------------------------------------
--  EVERY REFERENCE IS PINNED TO THE SAME ORGANISATION, IN THE DATABASE.
--
--  A job references a department, a designation, a location, a hiring
--  manager and a recruiter. A plain FK on id alone would accept ANOTHER
--  organisation's location id — foreign-key checks do not go through
--  row-level security — and the API's lookup would be the only thing
--  standing between one customer's job and another customer's office.
--  So each reference is a composite FK on (tenant_id, <id>), against a
--  (tenant_id, id) unique index on the target. Those indexes are trivially
--  true (id is already unique) and exist only to make the FKs possible; the
--  two on core.users and core.departments are additive indexes on Core
--  tables, named here so nobody wonders where they came from.
--
--  ON DELETE:
--    location, designation -> RESTRICT. The API refuses first with a
--        sentence; this is the backstop. Archive them instead.
--    department            -> SET NULL (department_id) only. Department
--        deletion is Core's endpoint and already refuses while people are in
--        one; a job losing its department is recoverable, a 500 is not.
--    hiring manager/recruiter -> SET NULL (column) only. People are
--        normally offboarded, not deleted; if one is, the job survives.
--    The column-list form of SET NULL (Postgres 15+) matters: a bare SET NULL
--    on a composite FK would null tenant_id too and fail its NOT NULL.
--
--  TEXT IS PLAIN TEXT. description / responsibilities / requirements will be
--  shown to strangers on a public page. They are stored and rendered as plain
--  text with line breaks — no HTML, no Markdown-to-HTML — so there is no
--  sanitiser to get wrong on the first public surface TatvaOS has.
--
--  STATUS: draft -> open <-> on_hold -> closed (closed may reopen). Only a
--  job that was never published may be deleted; after that it is closed, so
--  applications (next change) never lose the job they were made to.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS hire;
GRANT USAGE ON SCHEMA hire TO tatvaos_app;

-- Targets for the composite foreign keys below.
CREATE UNIQUE INDEX IF NOT EXISTS ux_core_locations_tenant_id    ON core.locations    (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_core_designations_tenant_id ON core.designations (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_core_departments_tenant_id  ON core.departments  (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_core_users_tenant_id        ON core.users        (tenant_id, id);

CREATE TABLE IF NOT EXISTS hire.job_openings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    title            text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 150),
    -- Lower-case words and hyphens, unique per organisation. The public
    -- address of the job on the careers page. NULL until the job is first
    -- published; then set once by the API from the title AS PUBLISHED plus
    -- ten random characters, and never rewritten, because a link someone
    -- already shared must keep working.
    slug             text CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 120)),

    department_id    uuid,
    designation_id   uuid,
    location_id      uuid,

    employment_type  text NOT NULL DEFAULT 'full_time'
                     CHECK (employment_type IN ('full_time','part_time','contract','internship','temporary')),

    experience_min_years smallint CHECK (experience_min_years BETWEEN 0 AND 60),
    experience_max_years smallint CHECK (experience_max_years BETWEEN 0 AND 60),
    qualification    text CHECK (qualification IS NULL OR length(qualification) <= 300),
    skills           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 50),

    salary_min       numeric(14,2) CHECK (salary_min >= 0),
    salary_max       numeric(14,2) CHECK (salary_max >= 0),
    salary_currency  text NOT NULL DEFAULT 'INR' CHECK (salary_currency ~ '^[A-Z]{3}$'),
    salary_period    text NOT NULL DEFAULT 'year' CHECK (salary_period IN ('year','month')),
    -- Whether the range may appear on the careers page. Off by default:
    -- publishing pay is the organisation's choice, not ours.
    show_salary      boolean NOT NULL DEFAULT false,

    vacancies        integer NOT NULL DEFAULT 1 CHECK (vacancies BETWEEN 1 AND 10000),

    description      text CHECK (description IS NULL OR length(description) <= 20000),
    responsibilities text CHECK (responsibilities IS NULL OR length(responsibilities) <= 20000),
    requirements     text CHECK (requirements IS NULL OR length(requirements) <= 20000),

    hiring_manager_id uuid,
    recruiter_id      uuid,

    opening_date     date,
    closing_date     date,

    status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','open','on_hold','closed')),
    closed_reason    text CHECK (closed_reason IS NULL OR closed_reason IN ('filled','cancelled')),
    -- First time it went to 'open'. Non-null means it has been public, which
    -- is what forbids deleting it.
    published_at     timestamptz,
    closed_at        timestamptz,

    created_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_job_experience_range CHECK (
        experience_min_years IS NULL OR experience_max_years IS NULL
        OR experience_max_years >= experience_min_years),
    CONSTRAINT ck_job_salary_range CHECK (
        salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min),
    CONSTRAINT ck_job_dates CHECK (
        opening_date IS NULL OR closing_date IS NULL OR closing_date >= opening_date),
    CONSTRAINT ck_job_closed_reason CHECK (
        (status = 'closed') = (closed_reason IS NOT NULL)),
    -- Published at least once <=> has its public address. Neither without
    -- the other: a public job with no slug has no URL, a draft with one has
    -- leaked its working title into it.
    CONSTRAINT ck_job_slug_at_publish CHECK (
        (published_at IS NULL) = (slug IS NULL)),

    CONSTRAINT fk_job_location FOREIGN KEY (tenant_id, location_id)
        REFERENCES core.locations (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_job_designation FOREIGN KEY (tenant_id, designation_id)
        REFERENCES core.designations (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_job_department FOREIGN KEY (tenant_id, department_id)
        REFERENCES core.departments (tenant_id, id) ON DELETE SET NULL (department_id),
    CONSTRAINT fk_job_hiring_manager FOREIGN KEY (tenant_id, hiring_manager_id)
        REFERENCES core.users (tenant_id, id) ON DELETE SET NULL (hiring_manager_id),
    CONSTRAINT fk_job_recruiter FOREIGN KEY (tenant_id, recruiter_id)
        REFERENCES core.users (tenant_id, id) ON DELETE SET NULL (recruiter_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_job_openings_slug
    ON hire.job_openings (tenant_id, slug);
CREATE INDEX IF NOT EXISTS ix_hire_job_openings_status
    ON hire.job_openings (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_hire_job_openings_location
    ON hire.job_openings (tenant_id, location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_hire_job_openings_designation
    ON hire.job_openings (tenant_id, designation_id) WHERE designation_id IS NOT NULL;

COMMENT ON TABLE hire.job_openings IS
    'TatvaOS Hire R1: a position an organisation is recruiting for (24 Sept 2026). '
    'Text columns are PLAIN TEXT - they will be shown on a public careers page.';

GRANT SELECT, INSERT, UPDATE, DELETE ON hire.job_openings TO tatvaos_app;

ALTER TABLE hire.job_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire.job_openings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hire.job_openings;
CREATE POLICY tenant_isolation ON hire.job_openings
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$
DECLARE
    pol int;
    fks int;
BEGIN
    SELECT count(*) INTO pol FROM pg_policies
     WHERE schemaname = 'hire' AND tablename = 'job_openings' AND policyname = 'tenant_isolation';
    SELECT count(*) INTO fks FROM pg_constraint
     WHERE conrelid = 'hire.job_openings'::regclass AND contype = 'f'
       AND array_length(conkey, 1) = 2;
    RAISE NOTICE '';
    RAISE NOTICE '  hire.job_openings: tenant_isolation policy %, % tenant-pinned foreign keys (want 5)',
        CASE WHEN pol = 1 THEN 'present' ELSE 'MISSING' END, fks;
    IF pol <> 1 OR fks <> 5 THEN
        RAISE WARNING '  hire.job_openings is not fenced as intended (policy %, pinned FKs %)', pol, fks;
    END IF;
    RAISE NOTICE '';
END $$;

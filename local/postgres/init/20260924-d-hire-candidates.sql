-- ============================================================================
--  TatvaOS Hire — candidates, applications and the pipeline
-- ============================================================================
--
--  Depends on 20260924-b-hire-job-openings.sql (hire schema, job openings)
--  and 20260924-c-hire-team.sql; same date, sorts after both.
--
--  R1 of the Hire roadmap (§3 Phase 1): "Applications, kept separate from
--  candidates, so one person can apply to several roles":
--
--      Candidate ──< Application >── Job opening
--                        │
--                     Stage (per-organisation pipeline)
--                        │
--                     Events (every move, append-only)
--
--  WHAT IS DELIBERATELY NOT HERE
--    * Resumes and any other file. Files from outside are the careers
--      portal's problem (roadmap §6.2: type/size limits, storage outside the
--      web root, virus scanning, rate limits) and get their own review.
--    * Aadhaar, PAN, bank details. Pre-joining (R4), after the
--      sensitive-data design document the Hire & People welcome requires.
--    Candidates hold ordinary contact and career details only — still
--    personal data under the DPDP Act, which is why erasure is designed in
--    below rather than added later.
--
--  ERASURE. Deleting a candidate removes their applications and every event
--  about them, through ON DELETE CASCADE. application_events is append-only
--  for the app (SELECT, INSERT only — nobody rewrites history), and the
--  cascade still works because Postgres runs referential actions as the
--  table owner, not as tatvaos_app. core.audit_logs keeps THAT a candidate
--  was erased and by whom, by id only: no name, email or phone is ever
--  written to the audit log, so erasure is not undone by it.
--
--  A REJECTION NEEDS A REASON. The welcome: whatever ranks people "must be
--  explainable to a rejected candidate". A human rejection is the first such
--  decision, so rejection_reason is required by the database whenever the
--  outcome is rejected — not only by the form.
--
--  TENANCY, as for job openings: FORCE row-level security, and every
--  reference is a composite (tenant_id, x_id) foreign key, so an application
--  cannot join one organisation's candidate to another's job even if the API
--  check were skipped.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

-- Targets for composite FKs into job openings.
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_job_openings_tenant_id ON hire.job_openings (tenant_id, id);

-- ---- pipeline stages ---------------------------------------------------------
-- Per organisation, so it can be customised (roadmap R1). The API creates the
-- default twelve the first time an organisation needs them; customising the
-- list is a later screen. "Rejected" and "Withdrawn" are OUTCOMES on the
-- application, not stages: a person rejected at Technical Interview was
-- still at Technical Interview, and that is what the history should say.
CREATE TABLE IF NOT EXISTS hire.pipeline_stages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
    name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    position    integer NOT NULL CHECK (position BETWEEN 0 AND 1000),
    -- The last stage, where a candidate becomes an employee (Joined). People
    -- (R5) converts from here; until then it only ends the pipeline.
    is_final    boolean NOT NULL DEFAULT false,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_pipeline_stages_tenant_id ON hire.pipeline_stages (tenant_id, id);

-- ---- candidates --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hire.candidates (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    full_name            text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
    email                text CHECK (email IS NULL OR (length(email) <= 320 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
    phone                text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{7,20}$'),

    current_location     text CHECK (current_location IS NULL OR length(current_location) <= 120),
    current_company      text CHECK (current_company IS NULL OR length(current_company) <= 150),
    current_designation  text CHECK (current_designation IS NULL OR length(current_designation) <= 150),
    experience_months    smallint CHECK (experience_months BETWEEN 0 AND 720),
    education            text CHECK (education IS NULL OR length(education) <= 500),
    skills               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 50),
    tags                 text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),

    expected_salary      numeric(14,2) CHECK (expected_salary >= 0),
    salary_currency      text NOT NULL DEFAULT 'INR' CHECK (salary_currency ~ '^[A-Z]{3}$'),
    notice_period_days   smallint CHECK (notice_period_days BETWEEN 0 AND 365),

    -- Where they came from. careers_page is written only by the careers
    -- portal (later); a recruiter adding someone by hand picks another.
    source               text NOT NULL DEFAULT 'other'
                         CHECK (source IN ('careers_page','referral','linkedin','job_board','agency','walk_in','other')),
    source_detail        text CHECK (source_detail IS NULL OR length(source_detail) <= 200),
    linkedin_url         text CHECK (linkedin_url IS NULL OR (length(linkedin_url) <= 300 AND linkedin_url ~ '^https://')),

    created_by           uuid,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- Someone has to be reachable, or there is no candidate to talk to.
    CONSTRAINT ck_candidate_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
-- One person per organisation by email, ignoring case: the same person
-- applying to three roles is ONE candidate with three applications.
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_candidates_email
    ON hire.candidates (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_candidates_tenant_id ON hire.candidates (tenant_id, id);
CREATE INDEX IF NOT EXISTS ix_hire_candidates_updated ON hire.candidates (tenant_id, updated_at DESC);

COMMENT ON TABLE hire.candidates IS
    'TatvaOS Hire: a person being recruited (24 Sept 2026). Personal data: erase by DELETE (cascades); '
    'never copy name/email/phone into core.audit_logs. No identity documents here.';

-- ---- applications ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hire.applications (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    candidate_id      uuid NOT NULL,
    job_id            uuid NOT NULL,
    stage_id          uuid NOT NULL,

    outcome           text NOT NULL DEFAULT 'active' CHECK (outcome IN ('active','rejected','withdrawn')),
    rejection_reason  text CHECK (rejection_reason IS NULL OR length(btrim(rejection_reason)) BETWEEN 3 AND 1000),

    applied_at        timestamptz NOT NULL DEFAULT now(),
    stage_changed_at  timestamptz NOT NULL DEFAULT now(),
    created_by        uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Rejected <=> a reason is recorded. See the header.
    CONSTRAINT ck_application_rejection_reason CHECK ((outcome = 'rejected') = (rejection_reason IS NOT NULL)),

    CONSTRAINT fk_application_candidate FOREIGN KEY (tenant_id, candidate_id)
        REFERENCES hire.candidates (tenant_id, id) ON DELETE CASCADE,
    -- RESTRICT: only never-published jobs can be deleted, and applications
    -- are only made to published ones, so this should never fire. It is the
    -- backstop that makes "applications never lose their job" true.
    CONSTRAINT fk_application_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES hire.job_openings (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_application_stage FOREIGN KEY (tenant_id, stage_id)
        REFERENCES hire.pipeline_stages (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_applications_candidate_job ON hire.applications (tenant_id, candidate_id, job_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_applications_tenant_id ON hire.applications (tenant_id, id);
CREATE INDEX IF NOT EXISTS ix_hire_applications_job ON hire.applications (tenant_id, job_id, outcome, stage_id);

-- ---- application events (append-only) ------------------------------------
CREATE TABLE IF NOT EXISTS hire.application_events (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    application_id  uuid NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('created','moved','rejected','withdrawn','reopened')),
    from_stage_id   uuid,
    to_stage_id     uuid,
    reason          text CHECK (reason IS NULL OR length(reason) <= 1000),
    actor_id        uuid,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_event_application FOREIGN KEY (tenant_id, application_id)
        REFERENCES hire.applications (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_hire_application_events_app ON hire.application_events (tenant_id, application_id, id);

-- ---- grants and the fence ----------------------------------------------------
GRANT SELECT, INSERT, UPDATE        ON hire.pipeline_stages     TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hire.candidates         TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE        ON hire.applications        TO tatvaos_app;
GRANT SELECT, INSERT                ON hire.application_events  TO tatvaos_app;
GRANT USAGE ON SEQUENCE hire.application_events_id_seq TO tatvaos_app;
-- Taken back explicitly as well, so a broader grant elsewhere (a schema-wide
-- GRANT in a later file) cannot quietly make history rewritable. Checked by
-- tests/isolation.
REVOKE UPDATE, DELETE ON hire.application_events FROM tatvaos_app;
REVOKE DELETE ON hire.applications FROM tatvaos_app;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['pipeline_stages','candidates','applications','application_events'] LOOP
        EXECUTE format('ALTER TABLE hire.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE hire.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON hire.%I', t);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON hire.%I
            USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    END LOOP;
END $$;

DO $$
DECLARE
    pol int;
BEGIN
    SELECT count(*) INTO pol FROM pg_policies
     WHERE schemaname = 'hire' AND policyname = 'tenant_isolation'
       AND tablename IN ('pipeline_stages','candidates','applications','application_events');
    RAISE NOTICE '';
    RAISE NOTICE '  hire candidates/applications/pipeline/events: % of 4 tenant_isolation policies present', pol;
    IF pol <> 4 THEN
        RAISE WARNING '  expected 4 tenant_isolation policies on the candidate tables, found %', pol;
    END IF;
    RAISE NOTICE '';
END $$;

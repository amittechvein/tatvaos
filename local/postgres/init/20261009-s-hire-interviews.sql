-- ============================================================================
--  TatvaOS Hire — interviews and interview feedback (roadmap Phase 2)
-- ============================================================================
--
--  Depends on 20260924-d-hire-candidates.sql (hire.applications, composite
--  (tenant_id, id) index) and core.users. Named "-s-" so it sorts after the
--  other 20261009 files, none of which it needs (the -c-/-r- lesson of 9 Oct:
--  same-date files run in plain string order).
--
--  An interview belongs to ONE application. Who may do what follows the access
--  table Amit confirmed on 2 Oct (#267) and adds one thing to it:
--
--    * schedule, change, cancel  — administrators and recruiters only. A
--      hiring manager may move or reject on their own jobs but not run the
--      process; scheduling is running the process.
--    * see an interview          — whoever may see its application
--      (HireAccess.Applications: everyone at recruiter level, a hiring
--      manager for their own jobs).
--    * give feedback             — a member of THAT interview's panel, for
--      THEMSELVES only. NEW: this is the one new ability, and the database
--      holds it: feedback has a foreign key to the panel row, so feedback by
--      someone who is not on the panel cannot exist, whatever the API does.
--    * panel members             — people who can use Hire (administrators
--      and the hiring team); checked by the API, the FK pins the organisation.
--
--  Erasure: interview -> panel -> feedback all cascade from the application,
--  so erasing a candidate (#267) or the retention sweep (#271) removes their
--  interviews and every word written about them. Feedback is never copied
--  into the audit log (only that it was given).
--
--  No DELETE of interviews for the app: an interview is cancelled, with its
--  history kept, until the candidate goes. Panel rows may be removed while an
--  interview is still scheduled, and the panel member's feedback goes with it.
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hire.interviews (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    application_id    uuid NOT NULL,
    scheduled_at      timestamptz NOT NULL,
    duration_minutes  integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
    mode              text NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person', 'video', 'phone')),
    -- An address, a room, or a meeting link. Plain text, never rendered as HTML.
    place             text CHECK (place IS NULL OR length(place) <= 300),
    status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    cancel_reason     text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
    created_by        uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_interview_application FOREIGN KEY (tenant_id, application_id)
        REFERENCES hire.applications (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_interviews_tenant_id ON hire.interviews (tenant_id, id);
CREATE INDEX IF NOT EXISTS ix_hire_interviews_application ON hire.interviews (tenant_id, application_id, scheduled_at);

CREATE TABLE IF NOT EXISTS hire.interview_panel (
    tenant_id     uuid NOT NULL,
    interview_id  uuid NOT NULL,
    user_id       uuid NOT NULL,
    added_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (interview_id, user_id),
    CONSTRAINT fk_panel_interview FOREIGN KEY (tenant_id, interview_id)
        REFERENCES hire.interviews (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_panel_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES core.users (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_interview_panel_tenant ON hire.interview_panel (tenant_id, interview_id, user_id);

CREATE TABLE IF NOT EXISTS hire.interview_feedback (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    interview_id    uuid NOT NULL,
    interviewer_id  uuid NOT NULL,
    rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    recommendation  text NOT NULL CHECK (recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')),
    notes           text CHECK (notes IS NULL OR length(notes) <= 2000),
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- One piece of feedback per panel member per interview.
    CONSTRAINT ux_feedback_one_per_interviewer UNIQUE (interview_id, interviewer_id),
    -- Only a panel member can have feedback: no panel row, no feedback.
    CONSTRAINT fk_feedback_panel FOREIGN KEY (tenant_id, interview_id, interviewer_id)
        REFERENCES hire.interview_panel (tenant_id, interview_id, user_id) ON DELETE CASCADE
);

COMMENT ON TABLE hire.interviews IS 'Interviews on an application (Phase 2). Cancelled, never deleted, until the candidate is.';
COMMENT ON TABLE hire.interview_panel IS 'Who sits on an interview. Feedback requires a row here (FK).';
COMMENT ON TABLE hire.interview_feedback IS 'One panel member''s feedback on one interview. Never copied to the audit log.';

GRANT SELECT, INSERT, UPDATE ON hire.interviews TO tatvaos_app;
GRANT SELECT, INSERT, DELETE ON hire.interview_panel TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE ON hire.interview_feedback TO tatvaos_app;

DO $$
DECLARE
    tbl text;
    n   int;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['interviews', 'interview_panel', 'interview_feedback'] LOOP
        EXECUTE format('ALTER TABLE hire.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE hire.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON hire.%I', tbl);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON hire.%I
            USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    END LOOP;
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'hire' AND tablename IN ('interviews', 'interview_panel', 'interview_feedback')
       AND policyname = 'tenant_isolation';
    IF n < 3 THEN
        RAISE WARNING '  hire: expected 3 tenant_isolation policies on the interview tables, found %', n;
    END IF;
END $$;

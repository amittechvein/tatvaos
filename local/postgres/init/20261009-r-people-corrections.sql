-- ============================================================================
--  People — correction requests: an employee asks HR to fix their record
-- ============================================================================
--
--  Depends on 20261009-people-employees.sql (same date). Named "-r-" so it
--  SORTS AFTER it: files run in plain string order, and "-c-" (the first
--  name) sorted before "-people-employees" ('c' < 'p') - the throwaway-DB
--  build failed on "relation people.employees does not exist" (9 Oct). The
--  letter must come after 'p'.
--
--  Phase 6 self-service, smallest useful piece. An employee may see their own
--  record (PeopleAccess.VisibleAsync already includes themselves) but not
--  change it: People HR writes records, because the record decides access
--  (setting reports_to grants it - 0018). So the employee ASKS: "my joining
--  date is wrong", "I moved to the Pune office". HR does the change through the
--  ordinary edit, which keeps every rule and the reporting audit in force, and
--  marks the request done - or declines it, with the reason the employee sees.
--
--  Who may do what (PeopleAccess, the only route):
--    * an employee: file requests about THEIR OWN record only (employee_id
--      comes from the session's record, never from the request body), and
--      read their own requests and HR's answers;
--    * People HR: read every request in the organisation, mark done or
--      declined. Nobody else - not a manager, not an administrator who has not
--      named themselves People HR.
--  An employee who has left files nothing (their record is kept as it was).
--  A declined request must say why: an employee is owed a reason (CHECK).
--  No DELETE for the app: the request and its answer are the record of it.
--
--  Not for Aadhaar, PAN or bank details: those wait for decision 0015.
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS people.correction_requests (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    employee_id   uuid NOT NULL,
    -- Which part of the record. 'other' for anything else on it.
    field         text NOT NULL CHECK (field IN ('full_name', 'work_email', 'department', 'designation',
                                                 'location', 'reports_to', 'joined_on', 'other')),
    -- What the employee says it should be, in their words.
    requested     text NOT NULL CHECK (length(btrim(requested)) BETWEEN 1 AND 500),
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
    response      text CHECK (response IS NULL OR length(response) <= 500),
    requested_by  uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    handled_by    uuid,
    handled_at    timestamptz,
    CONSTRAINT fk_correction_employee FOREIGN KEY (tenant_id, employee_id)
        REFERENCES people.employees (tenant_id, id) ON DELETE CASCADE,
    -- Open has no handler; done/declined have one and a time.
    CONSTRAINT ck_correction_handled CHECK ((status = 'open') = (handled_by IS NULL AND handled_at IS NULL)),
    -- An employee is owed a reason when the answer is no.
    CONSTRAINT ck_correction_decline_reason CHECK (status <> 'declined' OR length(btrim(coalesce(response, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS ix_people_corrections_open
    ON people.correction_requests (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_people_corrections_employee
    ON people.correction_requests (tenant_id, employee_id, created_at);
COMMENT ON TABLE people.correction_requests IS
    'An employee asks People HR to correct their record; HR answers. Own record only (PeopleAccess).';

GRANT SELECT, INSERT, UPDATE ON people.correction_requests TO tatvaos_app;

ALTER TABLE people.correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE people.correction_requests FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON people.correction_requests;
CREATE POLICY tenant_isolation ON people.correction_requests
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

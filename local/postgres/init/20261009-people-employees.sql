-- ============================================================================
--  People — the employee record and who reports to whom (decision 0018)
-- ============================================================================
--
--  Depends on 20261008-people-employee-ids.sql (the people schema, the
--  employee-ID scheme and people.format_employee_id()), on core.users and on
--  the composite (tenant_id, id) indexes 20260924-b added to core.departments,
--  core.designations and core.locations.
--
--  0018, accepted 9 Oct 2026 (Mr. Singh, with three additions; Amit decided
--  §4 and §5 the same day). What this file holds, and why:
--
--    people.hr_members        who in an organisation is People HR. NOT
--                             core.users.role, and organisation owners are
--                             NOT members automatically: an owner names
--                             themselves, and that moment is recorded (§4).
--    people.employees         the smallest record the hierarchy, employee
--                             IDs, identifiers (0015) and the directory stand
--                             on. user_id is OPTIONAL: some employees never
--                             sign in, some logins are not employees.
--    people.reporting_changes every change of reports_to, append-only.
--
--  ╔════════════════════════════════════════════════════════════════════════╗
--  ║ SETTING reports_to GRANTS ACCESS. It is an access change, not an       ║
--  ║ organisational detail, and it is audited as one. (Mr. Singh, 9 Oct.)   ║
--  ║ People reads "manager" from reports_to, never from core.users.role, so ║
--  ║ whoever writes reports_to decides who may see whose record.            ║
--  ║ people.reporting_changes is therefore an ACCESS audit. It is written by ║
--  ║ a trigger here, not by the API, so no path - an import, a migration, a ║
--  ║ fix by hand - can change a reporting line without a row in it, and the ║
--  ║ row names the person from the SESSION (app.user_id), never from a      ║
--  ║ column the writer chose. A writer with no app.user_id is refused.      ║
--  ╚════════════════════════════════════════════════════════════════════════╝
--
--  NO LOOPS, ENFORCED HERE. A CHECK refuses reporting to yourself; a CHECK
--  cannot see other rows, so a trigger walks up from the new manager and
--  refuses if it reaches the employee. Two simultaneous changes (A->B and
--  B->A) would each see no loop, so the trigger first takes a transaction-
--  scoped advisory lock per organisation:
--
--      pg_advisory_xact_lock(hashtextextended('people.reporting_to:' || tenant_id, 0))
--
--  * namespaced, so a future lock on the same organisation for another
--    purpose does not queue behind hierarchy edits;
--  * a hash collision makes two organisations' hierarchy edits queue behind
--    each other - contention, NEVER correctness (both still check under a
--    lock). If someone asks why two unrelated customers' edits serialise,
--    this is the answer (0018, addition 1);
--  * in the trigger, not the endpoint: a lock in the write path can be
--    forgotten by the next writer; a lock here cannot (Mr. Singh).
--  * The walk's SELECTs run AFTER the lock is taken, and a VOLATILE plpgsql
--    function takes a fresh snapshot per query under READ COMMITTED, so the
--    walk sees what the previous holder of the lock committed. Under
--    REPEATABLE READ it would not - the API does not use it for these writes.
--    tests/people step "race" runs rounds of A->B / B->A at once (the race in
--    #267 showed in one round of five).
--  * The walk stops at depth 64 and refuses with a sentence rather than
--    loop. No organisation is 64 levels deep.
--
--  An exited employee cannot be anyone's manager, and exiting someone who
--  still has reports is refused with the count (same lock, so an exit and a
--  new report cannot cross).
--
--  No DELETE for the app on employees: leaving is status 'exited'. When
--  exited records go is 0015 §9's lawyer question, answered once for both.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

-- ---- People HR ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people.hr_members (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    added_by    uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    CONSTRAINT fk_hr_member_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES core.users (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE people.hr_members IS
    'People HR per organisation (0018 §4). NOT core.users.role; owners are not members until they name themselves.';
GRANT SELECT, INSERT, DELETE ON people.hr_members TO tatvaos_app;

-- ---- the employee ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people.employees (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- From the organisation's scheme (#409) when it is auto; typed when manual.
    employee_code    text NOT NULL CHECK (length(btrim(employee_code)) BETWEEN 1 AND 30),
    -- Optional: some employees never sign in to TatvaOS.
    user_id          uuid,
    full_name        text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
    work_email       text CHECK (work_email IS NULL OR length(work_email) <= 320),
    department_id    uuid,
    designation_id   uuid,
    location_id      uuid,
    reports_to       uuid,
    employment_type  text NOT NULL DEFAULT 'full_time'
                     CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern')),
    status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'on_notice', 'exited')),
    joined_on        date NOT NULL,
    exit_on          date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    created_by       uuid,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    updated_by       uuid,
    CONSTRAINT ck_employee_not_own_manager CHECK (reports_to IS NULL OR reports_to <> id),
    CONSTRAINT ck_employee_exit_on_iff_exited CHECK ((status = 'exited') = (exit_on IS NOT NULL)),
    CONSTRAINT ck_employee_exit_after_join CHECK (exit_on IS NULL OR exit_on >= joined_on)
);
COMMENT ON TABLE people.employees IS
    'The employee record (0018). Not core.users: a login is not an employee. Setting reports_to grants access.';

CREATE UNIQUE INDEX IF NOT EXISTS ux_people_employees_tenant_id   ON people.employees (tenant_id, id);
-- A code is the organisation's, never reused, and "tv-0007" is "TV-0007".
CREATE UNIQUE INDEX IF NOT EXISTS ux_people_employees_code        ON people.employees (tenant_id, lower(employee_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_people_employees_user        ON people.employees (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS ix_people_employees_reports_to  ON people.employees (tenant_id, reports_to) WHERE reports_to IS NOT NULL;

-- Composite foreign keys: nothing here can name another organisation's person,
-- department, designation, location or manager, even bypassing row-level
-- security. Added guarded, so the file re-runs.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_user') THEN
        -- The login goes, the employee stays (they may have left the company
        -- years ago and kept no account). Only user_id is cleared.
        ALTER TABLE people.employees ADD CONSTRAINT fk_employee_user
            FOREIGN KEY (tenant_id, user_id) REFERENCES core.users (tenant_id, id) ON DELETE SET NULL (user_id);
    END IF;
    -- Departments, designations and locations: refused while an employee
    -- names them (the admin endpoints answer with a sentence first).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_department') THEN
        ALTER TABLE people.employees ADD CONSTRAINT fk_employee_department
            FOREIGN KEY (tenant_id, department_id) REFERENCES core.departments (tenant_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_designation') THEN
        ALTER TABLE people.employees ADD CONSTRAINT fk_employee_designation
            FOREIGN KEY (tenant_id, designation_id) REFERENCES core.designations (tenant_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_location') THEN
        ALTER TABLE people.employees ADD CONSTRAINT fk_employee_location
            FOREIGN KEY (tenant_id, location_id) REFERENCES core.locations (tenant_id, id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_reports_to') THEN
        ALTER TABLE people.employees ADD CONSTRAINT fk_employee_reports_to
            FOREIGN KEY (tenant_id, reports_to) REFERENCES people.employees (tenant_id, id);
    END IF;
END $$;

-- No DELETE: leaving is status 'exited'.
GRANT SELECT, INSERT, UPDATE ON people.employees TO tatvaos_app;

-- ---- the access audit of reporting lines -----------------------------------
CREATE TABLE IF NOT EXISTS people.reporting_changes (
    id               bigserial PRIMARY KEY,
    tenant_id        uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    employee_id      uuid NOT NULL,
    from_manager_id  uuid,
    to_manager_id    uuid,
    -- From the session (app.user_id), never from the row being written.
    changed_by       uuid NOT NULL,
    changed_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_reporting_change_employee FOREIGN KEY (tenant_id, employee_id)
        REFERENCES people.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_people_reporting_changes_employee
    ON people.reporting_changes (tenant_id, employee_id, changed_at);
COMMENT ON TABLE people.reporting_changes IS
    'Every change of reports_to, written by trigger. An ACCESS audit: setting reports_to grants access (0018, Mr. Singh).';
-- Append-only for the app: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON people.reporting_changes TO tatvaos_app;
GRANT USAGE ON SEQUENCE people.reporting_changes_id_seq TO tatvaos_app;

-- ---- the rules: no loops, no exited managers ---------------------------------
CREATE OR REPLACE FUNCTION people.employees_check_reporting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, people, pg_temp
AS $$
DECLARE
    cur    uuid;
    depth  int := 0;
    st     text;
    n      int;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.reports_to IS NOT DISTINCT FROM OLD.reports_to
       AND NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    -- One organisation's hierarchy edits, one at a time (see the header).
    PERFORM pg_advisory_xact_lock(hashtextextended('people.reporting_to:' || NEW.tenant_id::text, 0));

    IF NEW.reports_to IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.reports_to IS DISTINCT FROM OLD.reports_to) THEN
        SELECT status INTO st FROM people.employees
         WHERE tenant_id = NEW.tenant_id AND id = NEW.reports_to;
        IF st = 'exited' THEN
            RAISE EXCEPTION 'An employee who has left cannot be anyone''s manager.'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_people_manager_not_exited';
        END IF;
        -- The CHECK below backs this up; the trigger runs first and would
        -- otherwise call it a "loop" (seen in the first probe, 9 Oct).
        IF NEW.reports_to = NEW.id THEN
            RAISE EXCEPTION 'Someone cannot report to themselves.'
                USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_employee_not_own_manager';
        END IF;
        cur := NEW.reports_to;
        WHILE cur IS NOT NULL LOOP
            IF cur = NEW.id THEN
                RAISE EXCEPTION 'That would make a loop: this person is already above their new manager.'
                    USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_people_reporting_no_loop';
            END IF;
            depth := depth + 1;
            IF depth > 64 THEN
                RAISE EXCEPTION 'The reporting line is more than 64 levels deep - refused rather than followed.'
                    USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_people_reporting_depth';
            END IF;
            SELECT reports_to INTO cur FROM people.employees
             WHERE tenant_id = NEW.tenant_id AND id = cur;
        END LOOP;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.status = 'exited' AND OLD.status <> 'exited' THEN
        SELECT count(*) INTO n FROM people.employees
         WHERE tenant_id = NEW.tenant_id AND reports_to = NEW.id AND status <> 'exited';
        IF n > 0 THEN
            RAISE EXCEPTION '% to this person. Choose who they report to now, then try again.',
                CASE WHEN n = 1 THEN '1 person reports' ELSE n || ' people report' END
                USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_people_exit_with_reports';
        END IF;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_employees_check_reporting ON people.employees;
CREATE TRIGGER trg_employees_check_reporting
    BEFORE INSERT OR UPDATE OF reports_to, status ON people.employees
    FOR EACH ROW EXECUTE FUNCTION people.employees_check_reporting();

-- ---- the access audit, written here so no path can skip it ------------------
CREATE OR REPLACE FUNCTION people.employees_record_reporting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, people, pg_temp
AS $$
DECLARE
    actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.reports_to IS NOT DISTINCT FROM OLD.reports_to THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.reports_to IS NULL THEN
        RETURN NULL;
    END IF;
    IF actor IS NULL THEN
        -- A reporting line is an access grant: whoever changes it must be
        -- named. By hand: SET app.user_id = '<your operator id>' first.
        RAISE EXCEPTION 'Changing who someone reports to grants access, so it must say who did it: no app.user_id is set.'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_people_reporting_actor';
    END IF;
    INSERT INTO people.reporting_changes (tenant_id, employee_id, from_manager_id, to_manager_id, changed_by)
    VALUES (NEW.tenant_id, NEW.id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.reports_to END,
            NEW.reports_to, actor);
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_employees_record_reporting ON people.employees;
CREATE TRIGGER trg_employees_record_reporting
    AFTER INSERT OR UPDATE OF reports_to ON people.employees
    FOR EACH ROW EXECUTE FUNCTION people.employees_record_reporting();

-- ---- the allocator for auto employee codes ----------------------------------
-- The scheme row is created with the defaults if the organisation never saved
-- one, then taken FOR UPDATE by the UPDATE itself: two simultaneous joiners
-- queue on that row and can never get one number. Runs as the caller, inside
-- their tenant (row-level security), with the tenant from the session - it
-- takes no tenant argument, so it cannot allocate for anyone else.
CREATE OR REPLACE FUNCTION people.next_employee_code()
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, people, pg_temp
AS $$
DECLARE
    t     uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
    code  text;
BEGIN
    IF t IS NULL THEN
        RAISE EXCEPTION 'No organisation in this session.';
    END IF;
    INSERT INTO people.employee_id_settings (tenant_id) VALUES (t) ON CONFLICT (tenant_id) DO NOTHING;
    UPDATE people.employee_id_settings
       SET next_number = next_number + 1, updated_at = now()
     WHERE tenant_id = t AND mode = 'auto'
     RETURNING people.format_employee_id(prefix, digits, next_number - 1) INTO code;
    IF code IS NULL THEN
        RAISE EXCEPTION 'This organisation types employee IDs by hand (manual mode).'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_people_code_manual_mode';
    END IF;
    RETURN code;
END $$;
GRANT EXECUTE ON FUNCTION people.next_employee_code() TO tatvaos_app;

-- ---- the fence -----------------------------------------------------------------
DO $$
DECLARE
    tbl text;
    n   int;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['hr_members', 'employees', 'reporting_changes'] LOOP
        EXECUTE format('ALTER TABLE people.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE people.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON people.%I', tbl);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON people.%I
            USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    END LOOP;
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'people' AND tablename IN ('hr_members', 'employees', 'reporting_changes')
       AND policyname = 'tenant_isolation';
    IF n < 3 THEN
        RAISE WARNING '  people: expected 3 tenant_isolation policies on hr_members/employees/reporting_changes, found %', n;
    END IF;
END $$;

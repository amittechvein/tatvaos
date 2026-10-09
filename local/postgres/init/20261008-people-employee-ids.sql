-- ============================================================================
--  People — employee-ID configuration (Phase 0)
-- ============================================================================
--
--  docs/TATVAOS_HR_ROADMAP.md §2 lists "employee-ID configuration" in Phase 0;
--  Mr. Singh's Hire & People handover (8 Oct 2026, §6 step 3) asks for it now.
--
--  WHAT THIS IS: how an organisation numbers its employees — "TV-0001",
--  "ABC/123", or numbers typed in by hand because the organisation already
--  has them on paper. One scheme per organisation.
--
--  WHAT THIS IS NOT: an employee number. Nothing here is a fact about a
--  person, so nothing here touches core.users (a login is not an employee:
--  docs/onboarding/hire-people/WELCOME.md §2). 20260924-a deferred this with
--  the reporting hierarchy "until people.employees"; the hierarchy IS about
--  people and stays deferred, but a numbering scheme is the organisation's,
--  so it can stand alone. The allocator — take the next number, under a row
--  lock, never twice — arrives WITH people.employees, which will also hold
--  UNIQUE (tenant_id, employee_code) and refuse a next_number below the
--  highest already issued. Until then next_number may be set to anything.
--
--  ONE DEFINITION OF THE FORMAT: people.format_employee_id(). The API's
--  preview calls it, and the allocator will call it, so the ID an
--  administrator is shown is the ID an employee gets.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS people;
GRANT USAGE ON SCHEMA people TO tatvaos_app;

CREATE TABLE IF NOT EXISTS people.employee_id_settings (
    tenant_id    uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- 'auto': TatvaOS gives each new employee the next number.
    -- 'manual': an administrator types each ID (an organisation moving in
    -- with numbers it already uses). The scheme below is kept either way.
    mode         text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual')),

    -- Upper-case letters, digits, '-' and '/', up to 10. Upper case only so
    -- "tv-0001" and "TV-0001" can never both exist; the API upper-cases.
    -- Empty is allowed: plain numbers.
    prefix       text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Z0-9/-]{0,10}$'),

    -- The SHORTEST the number is written, padded with zeros: 4 -> 0001. A
    -- MINIMUM, not a limit: number 10000 with 4 digits is 10000, never 1000
    -- (see the function below — lpad() would have cut it).
    digits       integer NOT NULL DEFAULT 4 CHECK (digits BETWEEN 1 AND 8),

    next_number  integer NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 99999999),

    updated_by   uuid,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE people.employee_id_settings IS
    'How an organisation numbers its employees. A scheme, not a number: no row here is about a person. Phase 0 of People (8 Oct 2026).';

-- ---- the one definition of the format ---------------------------------------
-- lpad() TRUNCATES a string longer than the width: lpad('10000', 4, '0') is
-- '1000'. An organisation's ten-thousandth employee would have been given
-- the thousandth's ID. So the number is padded only when it is shorter.
CREATE OR REPLACE FUNCTION people.format_employee_id(p_prefix text, p_digits integer, p_number integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
    SELECT p_prefix || CASE WHEN length(p_number::text) >= p_digits
                            THEN p_number::text
                            ELSE lpad(p_number::text, p_digits, '0') END
$$;
GRANT EXECUTE ON FUNCTION people.format_employee_id(text, integer, integer) TO tatvaos_app;

-- ---- grants and the fence ---------------------------------------------------
-- No DELETE: the row is one per organisation and goes with the organisation.
GRANT SELECT, INSERT, UPDATE ON people.employee_id_settings TO tatvaos_app;

ALTER TABLE people.employee_id_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE people.employee_id_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON people.employee_id_settings;
CREATE POLICY tenant_isolation ON people.employee_id_settings
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Reports what is there rather than asserting it.
DO $$
DECLARE
    n int;
BEGIN
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'people' AND tablename = 'employee_id_settings'
       AND policyname = 'tenant_isolation';
    IF n < 1 THEN
        RAISE WARNING '  people.employee_id_settings has no tenant_isolation policy';
    END IF;
END $$;

-- ============================================================================
--  The product catalogue, told honestly.
--
--  Three corrections, all of them "the catalogue disagrees with reality":
--
--   1. 'drive' shipped as TatvaOS SPACE and is LIVE. The row still said
--      "TatvaOS Drive, not available". The CODE stays 'drive' — allocations,
--      product_access rows and audit entries were all written under it, and
--      renaming a primary key to fix a label is how you break three tables to
--      correct one string.
--
--   2. 'calendar' is the next product and did not exist at all.
--
--   3. people / payroll / sheet / word were placeholders for products nobody
--      has started. An unavailable product in the catalogue is not free: it
--      appears in the console's product lists, in storage allocation screens,
--      and in the launcher as a permanently greyed tile that teaches people
--      the suite is mostly vapour. They come back the day work starts on
--      them, which is a one-line INSERT.
--
--  Idempotent: safe on every deploy, like every file here.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1 + 2. Space is live; Calendar exists and is not available yet.
-- ----------------------------------------------------------------------------
UPDATE core.products
   SET name         = 'TatvaOS Space',
       description  = 'File storage and sharing',
       is_available = true
 WHERE code = 'drive';

INSERT INTO core.products (code, name, description, is_available, sort_order) VALUES
    ('calendar', 'TatvaOS Calendar', 'Scheduling, meetings and reminders', false, 30)
ON CONFLICT (code) DO NOTHING;

-- ----------------------------------------------------------------------------
--  3. Remove the placeholders — but ONLY where nothing points at them.
--
--  core.products is referenced by product_access, storage_allocations and
--  audit_logs.product_code. A bare DELETE would either fail the whole deploy
--  on a foreign key or, worse, take real rows with it. So each code is
--  deleted only when no row anywhere refers to it; anything in use is left
--  exactly where it is and said out loud in the NOTICE rather than silently
--  skipped.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    c text;
    referenced int;
BEGIN
    FOREACH c IN ARRAY ARRAY['people','payroll','sheet','word']
    LOOP
        SELECT (SELECT count(*) FROM core.product_access      WHERE product_code = c)
             + (SELECT count(*) FROM core.storage_allocations WHERE product_code = c)
             + (SELECT count(*) FROM core.audit_logs          WHERE product_code = c)
          INTO referenced;

        IF referenced = 0 THEN
            DELETE FROM core.products WHERE code = c;
        ELSE
            RAISE NOTICE
                'product % kept: % row(s) still reference it', c, referenced;
        END IF;
    END LOOP;
END $$;

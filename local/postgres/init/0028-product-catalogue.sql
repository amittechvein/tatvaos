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
    -- 'people' REMOVED FROM THIS LIST, 9 Sept 2026, and the reason is worth
    -- keeping. TatvaOS People was staffed, so 20260909-hire-people-products.sql
    -- inserts the code again at position 66 - after this file, at 31.
    --
    -- Leaving 'people' here looked harmless: each deploy deleted it and the
    -- later file re-inserted it, so the end state was always correct. It was
    -- not harmless. The re-insert takes the INSERT branch rather than the
    -- ON CONFLICT UPDATE branch, and that branch sets is_available = false. So
    -- the day somebody flips People available in the console, the next deploy
    -- turns it off again - and nobody connects a deploy to a product quietly
    -- vanishing from the catalogue. It would have self-healed only if an
    -- organisation happened to be granted People first, which is luck.
    --
    -- The asymmetry that hid it: on a FRESH install nothing inserts 'people'
    -- before this point, so the DELETE is a no-op and everything looks fine.
    -- The churn exists only on an already-deployed database. Core found it.
    --
    -- payroll, sheet and word stay: nothing inserts them anywhere, so for those
    -- this loop remains the harmless no-op it was designed to be.
    FOREACH c IN ARRAY ARRAY['payroll','sheet','word']
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

-- ----------------------------------------------------------------------------
--  Connect — video meetings. Added when its address was reserved, so the
--  catalogue, the launcher and DNS agree about what the suite contains.
-- ----------------------------------------------------------------------------
INSERT INTO core.products (code, name, description, is_available, sort_order) VALUES
    ('connect', 'TatvaOS Connect', 'Video meetings', false, 40)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
--  TatvaOS Hire and TatvaOS People enter the catalogue
-- ============================================================================
--
--  Both lanes were staffed on 9 September 2026. Until a product has a
--  core.products row it cannot be granted, listed in a plan, given a storage
--  allocation or billed - so this is the row that has to exist before any of
--  that work can be tested, and it is worth having now rather than being
--  discovered as a blocker in week three.
--
--  0028-product-catalogue.sql removed 'people' as a placeholder and said why:
--  "They come back the day work starts on them, which is a one-line INSERT."
--  This is that day.
--
--  ---------------------------------------------------------------------------
--  0028 NO LONGER DELETES 'people'. That line was removed in the same change
--  as this file's second revision, and the first version of this comment
--  argued the opposite - wrongly.
--
--  The original reasoning: 0028 deletes 'people' at position 31, this file
--  re-inserts at 66, so the end state is correct on every deploy and the churn
--  is a harmless transient. Every part of that is true and the conclusion was
--  still wrong, because the re-insert takes the INSERT branch, not the
--  ON CONFLICT UPDATE branch - and the INSERT branch sets is_available = false.
--  So the day People is flipped available in the console, the next deploy turns
--  it off again, silently, and nobody connects a deploy to a product vanishing.
--
--  What hid it: on a FRESH install nothing inserts 'people' before position 31,
--  so 0028's DELETE is a no-op and the whole interaction is invisible. It only
--  exists on an already-deployed database. Core found that asymmetry.
--
--  The general lesson, which is why this is written down rather than quietly
--  fixed: "the end state is correct" is not the same as "this is safe". The
--  path taken to reach the end state decided which columns got written.
--  ---------------------------------------------------------------------------
--
--  is_available stays FALSE for both. Neither product exists yet, and 0028 is
--  right about the cost of pretending otherwise: an unavailable product shows
--  up in product lists, storage screens and the launcher as a permanently
--  greyed tile that teaches people the suite is mostly vapour. Flip these to
--  true on the day each one ships, not before.
--
--  Sort order continues the existing sequence - mail 10, family 15, drive 20,
--  calendar 30, connect 40 - so Hire and People read last, which is the order
--  they will ship in.
--
--  Codes are 'hire' and 'people'. Unlike 'drive' (which ships as Space) these
--  match their names, and they should stay that way: the drive/Space mismatch
--  costs a paragraph of explanation in three separate files.

INSERT INTO core.products (code, name, description, is_available, sort_order) VALUES
    ('hire',   'TatvaOS Hire',   'Recruitment, candidates and hiring',        false, 50),
    ('people', 'TatvaOS People', 'Employees, attendance, leave and payroll',  false, 60)
ON CONFLICT (code) DO UPDATE
    SET name        = EXCLUDED.name,
        description = EXCLUDED.description,
        sort_order  = EXCLUDED.sort_order;
--  is_available is deliberately NOT in that SET list. Once somebody flips a
--  product live, the next deploy must not quietly switch it back off.

--  The NOTICE REPORTS what is in the table; it does not assert it. The first
--  version printed "both is_available = false" as fixed text, which would have
--  gone on saying so after somebody flipped one live - an observation printed
--  as an assertion, which is the same failure shape as a check that cannot go
--  red. Core caught it. Read the values out instead.
DO $$
DECLARE
    r record;
    n int := 0;
BEGIN
    RAISE NOTICE '';
    FOR r IN SELECT code, is_available FROM core.products
              WHERE code IN ('hire', 'people') ORDER BY code
    LOOP
        RAISE NOTICE '  core.products: % present, is_available = %', r.code, r.is_available;
        n := n + 1;
    END LOOP;
    IF n < 2 THEN
        RAISE WARNING '  core.products: expected hire AND people, found % row(s)', n;
    END IF;
    RAISE NOTICE '';
END $$;

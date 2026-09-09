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
--  READ THIS BEFORE WONDERING WHY 'people' KEEPS DISAPPEARING.
--
--  0028 still deletes 'people' - it loops over
--  ARRAY['people','payroll','sheet','word'] and drops each one that nothing
--  references. Every file in this folder re-runs on every deploy, and 0028
--  sorts BEFORE this file, so each deploy does:
--
--      0028   deletes 'people'  (only while nothing references it)
--      this   inserts it again
--
--  The end state after every deploy is therefore correct, and the churn stops
--  permanently the moment any organisation is actually granted People, because
--  0028's reference check then finds a product_access row and skips the delete.
--
--  0028 is deliberately NOT edited. Its delete is guarded, its intent is
--  documented, and rewriting a migration that has already run on production to
--  tidy up a transient no-op is a worse trade than this comment.
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

DO $$
DECLARE
    n int;
BEGIN
    SELECT count(*) INTO n FROM core.products WHERE code IN ('hire', 'people');
    RAISE NOTICE '';
    RAISE NOTICE '  core.products: hire + people present (% of 2), both is_available = false', n;
    RAISE NOTICE '';
END $$;

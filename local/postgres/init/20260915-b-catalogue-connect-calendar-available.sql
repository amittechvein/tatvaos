-- ============================================================================
--  Connect and Calendar are available products.
--
--  Amit, 15 Sept 2026: "Six people use Connect today; it is available.
--  Calendar is part of Mail; it should be available too."
--
--  0028-product-catalogue inserts both rows with is_available = false under
--  ON CONFLICT (code) DO NOTHING. On a database that already has the rows, a
--  re-run of 0028 changes nothing; on a fresh build, this file sorts later and
--  flips them. Either way the end state is the same, and running this file
--  again is a no-op because of the is_available = false guard.
--
--  Rule 7, what reads the flag: a grep of apps/api, apps/web and apps/mobile
--  on 15 Sept found no reader, only a comment in the admin plans page. So
--  this changes nothing a person sees today. It makes the catalogue say what
--  production already does, before decision 0002's derived entitlements and
--  the admin products screen (#74) start reading it.
--
--  Not touched: hire and people stay unavailable. That lane ships in October
--  (Amit, 15 Sept).
-- ============================================================================

UPDATE core.products
   SET is_available = true
 WHERE code IN ('connect', 'calendar')
   AND is_available = false;

-- ============================================================================
--  Public links — make a lost file audible
-- ============================================================================
--
--  When consume succeeds and the blob is then missing from the volume, the
--  platform has lost customer bytes: a valid link, a live row, a passing
--  predicate, and no file behind it. Today that is completely silent — the
--  visitor sees the ordinary "this link does not exist or has expired", the
--  refund (20260819-space-link-refund.sql) correctly returns their download,
--  and NOBODY learns the file is gone. The refund is right, and it also
--  erases the last observable trace of the loss.
--
--  The endpoint can only log what it is handed, and consume currently returns
--  the blob key but not the ids. So this widens its RETURNING clause by two
--  columns. Widening a return type requires DROP + CREATE — CREATE OR REPLACE
--  refuses to change a function's signature — which is why the drop below is
--  here and is not a rewrite.
--
--  ** THE PREDICATE IS UNCHANGED, BYTE FOR BYTE. ** It is still textually
--  identical to peek_public_link, comment for comment, and diffing the two
--  still works. The review-relevant diff of this migration is exactly two
--  lines: the RETURNS TABLE signature and the RETURNING list. Nothing about
--  what qualifies as a valid link has moved.
--
--  The DROP and the CREATE are wrapped in a transaction. DDL is transactional
--  in Postgres, so the swap is atomic and there is never an instant when the
--  function does not exist. That matters more than it first looks: deploy.sh
--  re-runs every file in this directory on EVERY deploy, so an unwrapped drop
--  would reopen that window each time rather than once — and a public-link
--  resolve landing inside it would get a Postgres error instead of the single
--  404 the contract promises. The grants are inside the transaction too, so
--  the function is never briefly present but un-executable by tatvaos_app.
--
--  Independent of 20260819-space-link-refund.sql; neither depends on the
--  other, so their relative order does not matter.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS space.consume_public_link(text);

CREATE OR REPLACE FUNCTION space.consume_public_link(p_token_hash text)
RETURNS TABLE (blob_key text, name text, mime_type text, size_bytes bigint,
               link_id uuid, file_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = space, core, pg_temp
AS $$
    UPDATE space.public_links l
       SET download_count = l.download_count + 1
      FROM space.files   f
      JOIN core.tenants  t ON t.id = f.tenant_id
      LEFT JOIN space.tenant_settings s ON s.tenant_id = f.tenant_id
     WHERE f.id = l.file_id
       AND l.token_hash = p_token_hash
       -- THE PREDICATE. This is the LIVE consume; its twin is
       -- peek_public_link in 20260816-space-public-links.sql. The two are
       -- kept identical comment for comment by
       -- infra/scripts/verify-space-link-predicate.sh, which is the check.
       AND l.revoked_at IS NULL                                        -- not revoked
       AND l.expires_at > now()                                        -- not expired
       AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads)  -- under the cap
       AND f.deleted_at IS NULL                                        -- file is live
       AND t.status IN ('active','trial')                              -- tenant is live
       AND COALESCE(s.allow_public_links, true)                        -- tap is open (absent row = default on)
    RETURNING f.blob_key, f.name, f.mime_type, f.size_bytes, l.id, f.id
$$;

-- Re-granted because DROP took the old grants with it. Inside the same
-- transaction as the CREATE, so the function is never visible without them.
REVOKE ALL ON FUNCTION space.consume_public_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION space.consume_public_link(text) TO tatvaos_app;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  consume_public_link now returns link_id and file_id so a missing';
    RAISE NOTICE '  blob can be logged as a storage loss. Predicate unchanged.';
    RAISE NOTICE '';
END $$;

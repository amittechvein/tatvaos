-- ============================================================================
--  Public links — refund a download the platform failed to deliver
-- ============================================================================
--
--  Review finding F1 (docs/reviews/SPACE_PUBLIC_LINKS.md): consume counts
--  atomically BEFORE the bytes stream — correct, that is what makes
--  max_downloads unraceable — but if the blob is then missing from the
--  volume, the recipient paid a download for our fault. On a link with
--  max_downloads = 1, our missing blob spent their only try.
--
--  So: one narrow refund, called ONLY from the blob-missing window in the
--  resolve endpoint. SECURITY DEFINER for the same reason consume is — the
--  anonymous path has no session and RLS cannot see the row. No gating
--  predicate on purpose: the link was valid moments ago when consume
--  matched it, and a refund that second-guessed expiry at the refund
--  instant could strand a count spent at 23:59:59. Floored at zero so a
--  double-refund bug can never mint free downloads.
-- ============================================================================

CREATE OR REPLACE FUNCTION space.refund_public_link(p_token_hash text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = space, pg_temp
AS $$
    UPDATE space.public_links
       SET download_count = greatest(download_count - 1, 0)
     WHERE token_hash = p_token_hash
    RETURNING download_count
$$;

REVOKE ALL ON FUNCTION space.refund_public_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION space.refund_public_link(text) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Public-link refund ready — a blob the platform lost no longer';
    RAISE NOTICE '  costs the recipient a download (review finding F1).';
    RAISE NOTICE '';
END $$;

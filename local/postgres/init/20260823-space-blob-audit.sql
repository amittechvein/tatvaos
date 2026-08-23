-- ============================================================================
--  Space — finding bytes on disk that no row points at.
--  Written 23 August 2026, from SPACE_FAULT_MATRIX.md entry #1.
-- ============================================================================
--
--  THE ASYMMETRY THIS CLOSES
--
--  Space already detects one direction: a row whose blob is missing. The
--  download path logs it loudly and refunds the download (20260819).
--
--  The OPPOSITE direction has nothing at all. Bytes on the volume with no
--  space.files row consume disk forever, are charged to nobody's quota,
--  appear in no listing, and are invisible to every query we have. In Space's
--  own words: "the asymmetry was never a decision; it's an accident of which
--  failure we happened to think about."
--
--  It is produced by ordinary events, not exotic ones — Postgres dying
--  between the blob write and the row commit, a killed process during a
--  folder purge, the losing side of a concurrent overwrite.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHY A FUNCTION THAT ANSWERS "WHICH OF THESE EXIST", AND NOT ONE THAT
--  RETURNS EVERY KEY
--
--  The worker walks the volume and holds a list of what is physically there.
--  It needs to know which of those the database knows about. Handing it every
--  blob_key in the platform would work today and would be a table scan and a
--  large result the day Space is busy; asking about a bounded batch is the
--  same answer at fixed cost.
--
--  SECURITY DEFINER because the sweeper runs with no tenant, exactly like
--  every other queue in this codebase — and it returns only keys the caller
--  ALREADY NAMED. It cannot be used to enumerate anything: you learn nothing
--  from it that you did not already have on disk.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

CREATE OR REPLACE FUNCTION space.blob_keys_present(p_keys text[])
RETURNS TABLE (blob_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = space, pg_temp
AS $$
    -- deleted_at IS NOT NULL still counts as PRESENT. A soft-deleted file is
    -- in the trash and its bytes are meant to still be there; the purge
    -- worker removes them later. Treating those as orphans would report
    -- every deleted file as a leak, which is the fastest way to make a report
    -- nobody reads.
    SELECT f.blob_key
      FROM space.files f
     WHERE f.blob_key = ANY(p_keys);
$$;

REVOKE ALL ON FUNCTION space.blob_keys_present(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION space.blob_keys_present(text[]) TO tatvaos_app;

COMMENT ON FUNCTION space.blob_keys_present(text[]) IS
    'Which of these blob keys does a space.files row point at? Used by the '
    'blob sweeper to find orphans — bytes on disk with no row. Soft-deleted '
    'files count as present; their bytes are meant to still exist.';

DO $$
BEGIN
    RAISE NOTICE 'space blob audit:';
    RAISE NOTICE '    space.blob_keys_present(text[]) — the orphan half of the storage-loss check';
END $$;

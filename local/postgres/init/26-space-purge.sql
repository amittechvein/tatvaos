-- ============================================================================
--  Space trash purge — the database half
-- ============================================================================
--
--  Trash is a deleted_at stamp (25-space-schema.sql) with a 30-day promise.
--  StorageReconcileWorker keeps that promise on its fifteen-minute tick:
--
--    1. list what is past retention   (space.purgeable_files, below)
--    2. delete the BLOBS from the volume, in C# — the database cannot
--    3. delete the ROWS               (space.purge_trash, below)
--
--  Blobs strictly BEFORE rows: a row that is gone can never tell anyone its
--  blob still exists, so the reverse order leaks bytes forever. If any blob
--  deletion fails, the worker skips step 3 entirely and retries next tick —
--  both functions take the SAME cutoff and use the SAME predicate, so a
--  retried pass converges instead of drifting.
--
--  WHY SECURITY DEFINER. The worker runs in platform scope with NO user id,
--  and the space RLS policies are (correctly) built around a person: a
--  colleague's personal file is invisible to an empty app.user_id. A purge
--  that silently skips personal trash keeps those bytes — and keeps charging
--  the tenant for them — forever. Same justification and same shape as
--  core.reconcile_storage_usage: takes only a timestamp, returns keys/counts,
--  no path leaks one tenant's data to another (the worker never surfaces the
--  rows, it deletes them). search_path pinned, mandatory on SECURITY DEFINER.
--
--  WHAT IS PURGEABLE. A file whose own stamp is past the cutoff, OR any file
--  inside a folder whose stamp is past the cutoff — folder trash stamps ONE
--  row, contents follow their ancestor, so the contents' own deleted_at is
--  null and only the subtree walk finds them. Folder rows past cutoff go by
--  ON DELETE CASCADE from the top stamped folder.
-- ============================================================================

CREATE OR REPLACE FUNCTION space.purgeable_files(p_cutoff timestamptz)
RETURNS TABLE (file_id uuid, blob_key text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = space, pg_temp
AS $$
    WITH RECURSIVE doomed AS (
        SELECT id FROM space.folders
         WHERE deleted_at IS NOT NULL AND deleted_at < p_cutoff
        UNION
        SELECT f.id FROM space.folders f
          JOIN doomed d ON f.parent_folder_id = d.id
    )
    SELECT f.id, f.blob_key
      FROM space.files f
     WHERE (f.deleted_at IS NOT NULL AND f.deleted_at < p_cutoff)
        OR (f.folder_id IS NOT NULL AND f.folder_id IN (SELECT id FROM doomed));
$$;

CREATE OR REPLACE FUNCTION space.purge_trash(p_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = space, pg_temp
AS $$
DECLARE
    v_files integer;
BEGIN
    -- Same predicate as purgeable_files, verbatim. If these two ever
    -- disagree, either bytes outlive their rows or rows outlive their bytes.
    WITH RECURSIVE doomed AS (
        SELECT id FROM space.folders
         WHERE deleted_at IS NOT NULL AND deleted_at < p_cutoff
        UNION
        SELECT f.id FROM space.folders f
          JOIN doomed d ON f.parent_folder_id = d.id
    )
    DELETE FROM space.files f
     WHERE (f.deleted_at IS NOT NULL AND f.deleted_at < p_cutoff)
        OR (f.folder_id IS NOT NULL AND f.folder_id IN (SELECT id FROM doomed));
    GET DIAGNOSTICS v_files = ROW_COUNT;

    -- The stamped folders themselves; their untrashed descendants cascade.
    DELETE FROM space.folders
     WHERE deleted_at IS NOT NULL AND deleted_at < p_cutoff;

    RETURN v_files;
END;
$$;

GRANT EXECUTE ON FUNCTION space.purgeable_files(timestamptz) TO tatvaos_app;
GRANT EXECUTE ON FUNCTION space.purge_trash(timestamptz)     TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Space trash purge functions ready — called by StorageReconcileWorker,';
    RAISE NOTICE '  blobs before rows, 30-day retention set by the caller.';
    RAISE NOTICE '';
END $$;

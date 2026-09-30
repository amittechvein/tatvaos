-- ============================================================================
--  Docs: which files the SERVER built (decision 0011 condition 1)
-- ============================================================================
--
--  From this change a document's file (the Space blob), its text and its
--  stored state are built by the render service from what the server stored
--  — never taken from a browser (docs/DOCS_SERVER_RENDER_DESIGN.md; Mr.
--  Singh, 29-30 Sept 2026).
--
--  rendered_seq: the update seq the server last built the file from.
--    NULL with checkpoint_at set  = a browser wrote this file (before the
--                                   render existed)
--    NULL with checkpoint_at NULL = never saved (a new, blank document is
--                                   given 0 by the API: the server made it)
--
--  THE GUARD (Mr. Singh, 30 Sept 2026, in place of a backfill): switching
--  Docs on for an organisation is refused while any of its files was written
--  by a browser. Production had 0 documents when this was written (read 29
--  Sept), so the guard is expected never to fire there; it exists so a
--  browser-written file can never go live by accident.
--
--  Additive: one nullable column, one function. Re-runs cleanly.
-- ============================================================================

ALTER TABLE docs.documents ADD COLUMN IF NOT EXISTS rendered_seq bigint;

COMMENT ON COLUMN docs.documents.rendered_seq IS
  'Update seq the render service last built the file from. NULL + checkpoint_at set = written by a browser (0011 condition 1).';

-- ----------------------------------------------------------------------------
--  How many of an organisation's documents a browser wrote.
--
--  WHY A FUNCTION. docs.documents is visible only where the caller can see
--  the Space file (its RLS policy defers to space.files). The platform
--  operator switching Docs on is not the owner of anybody's documents, so a
--  plain COUNT through RLS reads 0 whatever the truth — the guard would pass
--  silently. As SECURITY DEFINER it counts every document of that tenant,
--  and returns ONE number: no names, no content, no file ids.
--
--  Pinned search_path; not PUBLIC; the app role only (the rule for definers,
--  PR 333).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION docs.browser_written_count(p_tenant uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = docs, pg_temp
AS $$
    SELECT count(*)
      FROM docs.documents d
     WHERE d.tenant_id = p_tenant
       AND d.rendered_seq IS NULL
       AND d.checkpoint_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION docs.browser_written_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION docs.browser_written_count(uuid) TO tatvaos_app;

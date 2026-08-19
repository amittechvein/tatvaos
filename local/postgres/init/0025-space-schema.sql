-- ============================================================================
--  TatvaOS Space — files, folders, shares
-- ============================================================================
--
--  Space is the storage layer the rest of TatvaOS uses: Mail will attach from
--  it, Family will hold photos in it. It is a product, but more importantly it
--  is core plumbing — which is why it invents nothing:
--
--    quota       core.storage_pools / core.storage_allocations  (product 'drive')
--    audit       core.audit_logs via AuditWriter                (product 'drive')
--    ownership   'personal' | 'organisational', same as Family
--    isolation   RLS on app.tenant_id + app.user_id, same as Family
--    soft delete a deleted_at timestamptz, same as core.users' status
--
--  DECISIONS BAKED IN HERE (agreed with Core, 2026-08-14):
--
--   * Product code stays 'drive'; only the display name is Space. See the
--     UPDATE below.
--   * Bytes live on a docker volume behind an opaque blob_key. The key format
--     is {tenant_id}/{yyyy}/{mm}/{uuid4}, generated SERVER-SIDE, never derived
--     from the uploaded filename (path traversal) and never deterministic
--     (delete-and-recreate collision). The filename lives only in the metadata
--     row, so two files may share a name in a folder, as in Drive.
--   * On overwrite, write a NEW blob_key and repoint — never overwrite a blob
--     in place. Costs nothing now; makes file versions recoverable when the
--     versions table arrives.
--   * Trash is a deleted_at column, not a table. Restore = set it NULL.
--     Trashed bytes still count toward quota until purged (the bytes are
--     still on disk); purge after 30 days runs in StorageReconcileWorker.
--   * No space.trash, no space.audit_logs, no folders.path, no versions
--     table yet — each deliberately (see the sections below).
--
--  APPLICATION-ENFORCED RULES the schema cannot express, recorded here so
--  they are not lost:
--
--   * Folder depth is capped at 32. The recursive CTEs below carry the same
--     cap, so a pathological tree errors cleanly instead of hanging.
--   * A move must check that the destination is not a descendant of the
--     folder being moved, or the tree gains a cycle and every recursive
--     query afterwards hangs. Application-checked on every move.
--   * Quota is checked BEFORE accepting an upload, through StorageAllocator,
--     returning a reason ('full' | 'suspended' | ...), never a bare bool.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Product row. 'drive' is the product CODE — an internal key referenced by
-- product_access, the launcher and the nav. 'TatvaOS Space' is the product
-- NAME. This is deliberate, not a leftover: renaming the code would touch the
-- seed, the launcher tile and every product_access row already granted, for
-- zero user-visible gain. (Family shipped without its products row and was
-- invisible to entitlement for weeks — this runs in the FIRST Space migration
-- for exactly that reason.)
-- ----------------------------------------------------------------------------

UPDATE core.products
   SET name         = 'TatvaOS Space',
       description  = 'File storage and sharing',
       is_available = true
 WHERE code = 'drive';

-- ----------------------------------------------------------------------------
-- Schema
-- ----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS space;

-- ----------------------------------------------------------------------------
-- Folders
-- ----------------------------------------------------------------------------
--
-- No denormalised path column. A stored path is correct until a folder near
-- the root is renamed, at which point every descendant needs rewriting and
-- any missed row has silently moved. Breadcrumbs resolve with a recursive CTE
-- on parent_folder_id (see core.department_effective_quota for the pattern).
--
-- owner_user_id is ON DELETE SET NULL — the Family lesson. Family's CASCADE
-- destroyed a deleted user's entire address book while their mail survived.
-- Files outlive their owner: the CHECK below permits a personal row whose
-- owner is gone (retained, invisible to colleagues, reassignable from the
-- console), so deleting a user cannot fail on it or destroy their files.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space.folders (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    parent_folder_id   uuid REFERENCES space.folders(id) ON DELETE CASCADE,

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    ownership_type     text NOT NULL DEFAULT 'personal'
                       CHECK (ownership_type IN ('personal','organisational')),
    owner_user_id      uuid REFERENCES core.users(id) ON DELETE SET NULL,

    -- Organisational rows never carry an owner. Personal rows normally do,
    -- but MAY be owner-less: that is the retained state after user deletion.
    CONSTRAINT folders_ownership_consistent CHECK (
        ownership_type <> 'organisational' OR owner_user_id IS NULL
    ),

    name        text NOT NULL,

    -- Soft delete. NULL = live. Restore = set NULL. Purged by
    -- StorageReconcileWorker 30 days after deletion.
    deleted_at         timestamptz,
    deleted_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_space_folders_tenant ON space.folders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_space_folders_parent ON space.folders(parent_folder_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_space_folders_owner  ON space.folders(owner_user_id);
-- The purge worker's scan: only trashed rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_space_folders_trash  ON space.folders(deleted_at)
    WHERE deleted_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Files
-- ----------------------------------------------------------------------------
--
-- blob_key is opaque and unique: {tenant_id}/{yyyy}/{mm}/{uuid4}. The tenant
-- prefix makes offboarding, per-tenant audit and a future per-tenant migration
-- to object storage a prefix operation; the date segment keeps any one
-- directory from growing unbounded on a filesystem.
--
-- folder_id NULL means the root of the owner's (or the organisation's) space.
-- The FK cascades on HARD delete only — the purge worker must remove the blob
-- from the volume BEFORE deleting the row, or the bytes are orphaned.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space.files (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    folder_id          uuid REFERENCES space.folders(id) ON DELETE CASCADE,

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    ownership_type     text NOT NULL DEFAULT 'personal'
                       CHECK (ownership_type IN ('personal','organisational')),
    owner_user_id      uuid REFERENCES core.users(id) ON DELETE SET NULL,

    CONSTRAINT files_ownership_consistent CHECK (
        ownership_type <> 'organisational' OR owner_user_id IS NULL
    ),

    -- Display name only. NEVER used to locate bytes on disk, and deliberately
    -- NOT unique per folder — Drive allows two "notes.txt" side by side.
    name        text NOT NULL,
    mime_type   text NOT NULL DEFAULT 'application/octet-stream',

    blob_key    text NOT NULL,
    size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),

    deleted_at         timestamptz,
    deleted_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    search_vector tsvector
);

-- One blob, one row. If this ever fails, two rows point at the same bytes and
-- purging one destroys the other's content.
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_files_blob ON space.files(blob_key);

CREATE INDEX IF NOT EXISTS idx_space_files_tenant ON space.files(tenant_id);
CREATE INDEX IF NOT EXISTS idx_space_files_folder ON space.files(folder_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_space_files_owner  ON space.files(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_space_files_trash  ON space.files(deleted_at)
    WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_files_search ON space.files USING gin(search_vector);

-- 'simple', not 'english' — filenames should not be stemmed, same reasoning
-- as Family's surname note.
CREATE OR REPLACE FUNCTION space.files_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple', coalesce(NEW.name, ''));
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_space_files_search ON space.files;
CREATE TRIGGER trg_space_files_search
    BEFORE INSERT OR UPDATE ON space.files
    FOR EACH ROW EXECUTE FUNCTION space.files_search_vector();

-- ----------------------------------------------------------------------------
-- Shares
-- ----------------------------------------------------------------------------
--
-- A share targets exactly one object (file XOR folder) and exactly one
-- audience (a named user XOR the whole organisation). Both CHECKed, because a
-- row pointing at neither is invisible to every query and simply rots.
--
-- Folder shares CASCADE to contents at QUERY time by walking ancestors — share
-- rows are never copied down to children. Copied rows go stale the moment a
-- folder moves and make "why can this person see this?" unanswerable.
-- Effective permission = the highest grant on the file or any ancestor.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space.shares (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    file_id    uuid REFERENCES space.files(id)   ON DELETE CASCADE,
    folder_id  uuid REFERENCES space.folders(id) ON DELETE CASCADE,
    CONSTRAINT shares_one_target CHECK (num_nonnulls(file_id, folder_id) = 1),

    shared_by_user_id   uuid REFERENCES core.users(id) ON DELETE SET NULL,

    shared_with_user_id uuid REFERENCES core.users(id) ON DELETE CASCADE,
    org_wide            boolean NOT NULL DEFAULT false,
    CONSTRAINT shares_one_audience CHECK (
        (shared_with_user_id IS NOT NULL AND NOT org_wide) OR
        (shared_with_user_id IS NULL     AND org_wide)
    ),

    permission text NOT NULL DEFAULT 'view'
               CHECK (permission IN ('view','comment','edit')),

    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_space_shares_file    ON space.shares(file_id);
CREATE INDEX IF NOT EXISTS idx_space_shares_folder  ON space.shares(folder_id);
CREATE INDEX IF NOT EXISTS idx_space_shares_grantee ON space.shares(shared_with_user_id);

-- One grant per (object, audience). Re-sharing updates the permission on the
-- existing row rather than stacking rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_shares_file_user
    ON space.shares(file_id, shared_with_user_id)
    WHERE file_id IS NOT NULL AND shared_with_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_shares_file_org
    ON space.shares(file_id)
    WHERE file_id IS NOT NULL AND org_wide;
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_shares_folder_user
    ON space.shares(folder_id, shared_with_user_id)
    WHERE folder_id IS NOT NULL AND shared_with_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_shares_folder_org
    ON space.shares(folder_id)
    WHERE folder_id IS NOT NULL AND org_wide;

-- ----------------------------------------------------------------------------
-- Access helper
-- ----------------------------------------------------------------------------
--
-- Can this user reach this folder — as owner, because it is organisational,
-- or through a share on it or ANY ancestor? Used by the RLS policies below.
--
-- SECURITY DEFINER for the same reason as core.reconcile_storage_usage: the
-- walk must read ancestor folders and share rows the CALLER's own policies
-- might not surface, without recursing into those policies. Safe because it
-- takes ids, returns only a boolean, and every row it inspects is pinned to
-- p_tenant. search_path pinned, mandatory on SECURITY DEFINER.
--
-- The depth guard doubles as the cycle guard for reads: even if a cycle
-- slipped past the application's move check, this terminates at 32.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION space.can_access_folder(p_folder uuid, p_tenant uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = space, core, pg_temp
AS $$
    WITH RECURSIVE chain AS (
        SELECT f.id, f.parent_folder_id, f.ownership_type, f.owner_user_id, 1 AS depth
          FROM space.folders f
         WHERE f.id = p_folder AND f.tenant_id = p_tenant
        UNION ALL
        SELECT f.id, f.parent_folder_id, f.ownership_type, f.owner_user_id, c.depth + 1
          FROM space.folders f
          JOIN chain c ON f.id = c.parent_folder_id
         WHERE f.tenant_id = p_tenant AND c.depth < 32
    )
    SELECT EXISTS (
        SELECT 1
          FROM chain c
         WHERE c.ownership_type = 'organisational'
            OR (p_user IS NOT NULL AND c.owner_user_id = p_user)
            OR EXISTS (SELECT 1 FROM space.shares s
                        WHERE s.folder_id = c.id
                          AND s.tenant_id = p_tenant
                          AND (s.org_wide OR s.shared_with_user_id = p_user))
    );
$$;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
--
-- Both settings are read as nullif(current_setting('app.x', true), '')::uuid.
-- The `true` stops an UNSET name from raising; the nullif stops an EMPTY one
-- from raising at the ::uuid cast — the interceptor sends an empty string for
-- a request with no person behind it. Both are needed (the Family dev broke
-- their own tests learning this). Either way the result is NULL, every
-- comparison is false, and the query fails closed.
--
-- Visibility = tenant AND (organisational OR mine OR shared to me, directly
-- or via any ancestor folder). The view/comment/edit LEVEL is enforced in the
-- application — RLS answers "can they see it at all".
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['folders','files','shares']
    LOOP
        EXECUTE format('ALTER TABLE space.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE space.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON space.%I', t);
    END LOOP;

    EXECUTE '
        CREATE POLICY tenant_isolation ON space.folders
        USING (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND space.can_access_folder(id,
                    nullif(current_setting(''app.tenant_id'', true), '''')::uuid,
                    nullif(current_setting(''app.user_id'',   true), '''')::uuid)
        )
        WITH CHECK (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
        )';

    EXECUTE '
        CREATE POLICY tenant_isolation ON space.files
        USING (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND (
                ownership_type = ''organisational''
                OR owner_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
                OR EXISTS (SELECT 1 FROM space.shares s
                            WHERE s.file_id = space.files.id
                              AND (s.org_wide
                                   OR s.shared_with_user_id =
                                      nullif(current_setting(''app.user_id'', true), '''')::uuid))
                OR (folder_id IS NOT NULL AND space.can_access_folder(folder_id,
                        nullif(current_setting(''app.tenant_id'', true), '''')::uuid,
                        nullif(current_setting(''app.user_id'',   true), '''')::uuid))
            )
        )
        WITH CHECK (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
        )';

    -- Shares: you see a grant if you made it, you are its grantee, or it is
    -- org-wide in your tenant. Deliberately does NOT consult files/folders —
    -- that would recurse into their policies, which consult this table.
    EXECUTE '
        CREATE POLICY tenant_isolation ON space.shares
        USING (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND (
                org_wide
                OR shared_by_user_id   = nullif(current_setting(''app.user_id'', true), '''')::uuid
                OR shared_with_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
            )
        )
        WITH CHECK (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
        )';
END $$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA space TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA space TO tatvaos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA space TO tatvaos_app;
GRANT EXECUTE ON FUNCTION space.can_access_folder(uuid, uuid, uuid) TO tatvaos_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA space
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- The mail edge gets NOTHING. Postfix routes mail; it has no business
-- reading a tenant's files.

-- ----------------------------------------------------------------------------
-- Storage roll-up — extend core.reconcile_storage_usage to cover Space
-- ----------------------------------------------------------------------------
--
-- Same shape as 17-storage-usage.sql, now writing TWO product rows per
-- tenant: 'mail' from mail.mailboxes, 'drive' from space.files. Derived, not
-- incremented — a derivation cannot drift (the incremental version of this
-- shipped once and reported zero for months).
--
-- TRASHED FILES STILL COUNT: the sum has no deleted_at filter, deliberately.
-- The bytes are still on the volume until the purge worker removes them, and
-- quota that promises space the disk does not have is worse than showing
-- trash against the meter. The number drops when the purge runs.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.reconcile_storage_usage(p_tenant uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, mail, space, pg_temp
AS $$
DECLARE
    v_rows  integer;
    v_total integer := 0;
BEGIN
    -- Mail, from the per-mailbox figures (maintained at ingest/send/delete).
    WITH usage AS (
        SELECT m.tenant_id, COALESCE(SUM(m.used_bytes), 0)::bigint AS used
          FROM mail.mailboxes m
         WHERE p_tenant IS NULL OR m.tenant_id = p_tenant
         GROUP BY m.tenant_id
    )
    INSERT INTO core.storage_allocations (tenant_id, product_code, used_bytes, updated_at)
    SELECT u.tenant_id, 'mail', u.used, now()
      FROM usage u
    ON CONFLICT (tenant_id, product_code) DO UPDATE
        SET used_bytes = EXCLUDED.used_bytes,
            updated_at = now()
      WHERE core.storage_allocations.used_bytes IS DISTINCT FROM EXCLUDED.used_bytes;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;

    -- Space, from the file rows. Trash included — see the note above.
    WITH usage AS (
        SELECT f.tenant_id, COALESCE(SUM(f.size_bytes), 0)::bigint AS used
          FROM space.files f
         WHERE p_tenant IS NULL OR f.tenant_id = p_tenant
         GROUP BY f.tenant_id
    )
    INSERT INTO core.storage_allocations (tenant_id, product_code, used_bytes, updated_at)
    SELECT u.tenant_id, 'drive', u.used, now()
      FROM usage u
    ON CONFLICT (tenant_id, product_code) DO UPDATE
        SET used_bytes = EXCLUDED.used_bytes,
            updated_at = now()
      WHERE core.storage_allocations.used_bytes IS DISTINCT FROM EXCLUDED.used_bytes;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;

    -- A tenant whose last mailbox / file is gone produces no row above and
    -- would keep its final non-zero figure forever, reading as full.
    UPDATE core.storage_allocations a
       SET used_bytes = 0, updated_at = now()
     WHERE a.product_code = 'mail'
       AND (p_tenant IS NULL OR a.tenant_id = p_tenant)
       AND a.used_bytes <> 0
       AND NOT EXISTS (SELECT 1 FROM mail.mailboxes m WHERE m.tenant_id = a.tenant_id);

    UPDATE core.storage_allocations a
       SET used_bytes = 0, updated_at = now()
     WHERE a.product_code = 'drive'
       AND (p_tenant IS NULL OR a.tenant_id = p_tenant)
       AND a.used_bytes <> 0
       AND NOT EXISTS (SELECT 1 FROM space.files f WHERE f.tenant_id = a.tenant_id);

    RETURN v_total;
END;
$$;

GRANT EXECUTE ON FUNCTION core.reconcile_storage_usage(uuid) TO tatvaos_app;

-- ----------------------------------------------------------------------------
DO $$
DECLARE v_rows integer;
BEGIN
    SELECT core.reconcile_storage_usage() INTO v_rows;
    RAISE NOTICE '';
    RAISE NOTICE '  TatvaOS Space schema ready — product ''drive'' now displays as Space.';
    RAISE NOTICE '  reconcile_storage_usage now covers mail AND space (% row(s) touched).', v_rows;
    RAISE NOTICE '  Audit goes to core.audit_logs (product_code ''drive''); no local copy.';
    RAISE NOTICE '';
END $$;

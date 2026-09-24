-- ============================================================================
--  TatvaOS Docs — collaborative documents, stored in Space
-- ============================================================================
--
--  A document IS a Space file: a space.files row with mime type
--  'application/vnd.tatvaos.document'. That row carries everything Space
--  already does and Docs must not reinvent —
--
--    name / folder / trash / stars / recent   space.files, space.stars, ...
--    who may open it, and at what level       space.shares (view|comment|edit)
--                                             + the owner + folder ancestry
--    quota                                    space.files.size_bytes
--
--  and its blob is an HTML rendering of the document, refreshed on every
--  checkpoint, so every Space path that reads a blob (download, public link,
--  attach-from-Space in Mail) hands out a readable document rather than a
--  binary nobody can open.
--
--  What this schema adds is only what Space cannot hold:
--
--    docs.documents   the live content: a compacted Yjs state + its seq
--    docs.updates     Yjs updates received since that state (append-only
--                     until a checkpoint folds them in)
--    docs.versions    snapshots: automatic, named, and "before restore"
--    docs.comments    threads anchored to text by Yjs relative positions
--    docs.images      pictures pasted or inserted into a document
--
--  THE SERVER NEVER PARSES YJS. It stores and relays opaque updates; the
--  merging happens in the browser. A checkpoint is a browser saying "here is
--  the whole state, and it contains every update up to seq N", after which
--  the server may fold those updates away. That claim is trusted — an editor
--  can already delete everything by typing — which is why versions exist and
--  why folded updates are KEPT for a day (see DocsEndpoints.CheckpointAsync)
--  instead of deleted at once.
--
--  Every child table hangs off docs.documents, which hangs off space.files,
--  both ON DELETE CASCADE: when Space purges a file from the trash, its
--  document, history, comments and pictures go with it in the same
--  statement. Pictures are bytea rather than blobs for exactly that reason —
--  Space has three separate purge paths that delete a file's ONE blob, and a
--  document's pictures in the blob store would be orphaned by all three.
--
--  Isolation: tenant AND "can the caller see the space.files row". The
--  EXISTS below runs under the CALLER's space.files policy, so a document is
--  visible to exactly the people Space shows the file to — share, owner,
--  organisational, or folder ancestry — with no copy of that logic here.
--  The LEVEL (view < comment < edit < owner) is enforced in the application,
--  same split as Space.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS docs;

-- ----------------------------------------------------------------------------
-- Documents
-- ----------------------------------------------------------------------------
--
-- state is a Yjs update encoding the whole document as of state_seq. An empty
-- bytea is a new, blank document. Updates with seq > state_seq are the ones a
-- joining browser must replay on top of it.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS docs.documents (
    file_id    uuid PRIMARY KEY REFERENCES space.files(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    state      bytea  NOT NULL DEFAULT '\x'::bytea,
    state_seq  bigint NOT NULL DEFAULT 0,

    -- Plain text as of the last checkpoint. For search and for AI features
    -- that need the document without a browser in the loop.
    text_content text NOT NULL DEFAULT '',

    checkpoint_at          timestamptz,
    checkpoint_by_user_id  uuid REFERENCES core.users(id) ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_documents_tenant ON docs.documents(tenant_id);

-- ----------------------------------------------------------------------------
-- Updates
-- ----------------------------------------------------------------------------
--
-- seq is a bigserial and therefore global, not per document. That is enough:
-- the application appends and broadcasts under one lock per document, so
-- within a document seq order IS arrival order, and "every update up to N"
-- means the same thing to every browser.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS docs.updates (
    seq        bigserial PRIMARY KEY,
    file_id    uuid NOT NULL REFERENCES docs.documents(file_id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id    uuid REFERENCES core.users(id) ON DELETE SET NULL,
    data       bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_updates_file_seq ON docs.updates(file_id, seq);

-- ----------------------------------------------------------------------------
-- Versions
-- ----------------------------------------------------------------------------
--
-- kind: 'auto'    taken by a checkpoint when the newest version is old enough
--       'named'   someone chose File > Name current version
--       'restore' the state as it was immediately before a restore, so a
--                 restore is itself undoable
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS docs.versions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id    uuid NOT NULL REFERENCES docs.documents(file_id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    kind       text NOT NULL DEFAULT 'auto'
               CHECK (kind IN ('auto','named','restore')),
    name       text CHECK (name IS NULL OR length(name) <= 200),

    state      bytea NOT NULL,
    html       text  NOT NULL DEFAULT '',

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_versions_file ON docs.versions(file_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Comments
-- ----------------------------------------------------------------------------
--
-- A thread is a root (parent_id NULL, carries the anchor and the quote) and
-- its replies (parent_id = root). Resolution belongs to the root.
--
-- anchor is opaque to the server: two Yjs relative positions, serialised by
-- the browser. It survives edits around the quoted text, which a character
-- offset would not. quote is the text as it was when the comment was made,
-- shown when the anchored text has since been deleted.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS docs.comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id    uuid NOT NULL REFERENCES docs.documents(file_id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    parent_id  uuid REFERENCES docs.comments(id) ON DELETE CASCADE,

    author_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),

    anchor     jsonb,
    quote      text CHECK (quote IS NULL OR length(quote) <= 2000),

    resolved_at          timestamptz,
    resolved_by_user_id  uuid REFERENCES core.users(id) ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_docs_comments_file   ON docs.comments(file_id, created_at);
CREATE INDEX IF NOT EXISTS idx_docs_comments_parent ON docs.comments(parent_id);

-- ----------------------------------------------------------------------------
-- Images
-- ----------------------------------------------------------------------------
--
-- Raster types only. SVG is refused in the application: an SVG is a document
-- that can carry script, served from our own origin.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS docs.images (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id    uuid NOT NULL REFERENCES docs.documents(file_id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    mime_type  text NOT NULL
               CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
    data       bytea NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_docs_images_file ON docs.images(file_id);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
--
-- Same nullif(current_setting(..., true), '') reading as Space, for the same
-- two reasons (unset name, empty string from a request with no person).
--
-- documents: tenant AND the caller can see the space.files row.
-- children:  tenant AND the caller can see the parent document — which
--            recurses into the documents policy, which recurses into
--            space.files. Neither of those consults docs.*, so there is no
--            cycle.
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['documents','updates','versions','comments','images']
    LOOP
        EXECUTE format('ALTER TABLE docs.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE docs.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON docs.%I', t);
    END LOOP;

    EXECUTE '
        CREATE POLICY tenant_isolation ON docs.documents
        USING (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND EXISTS (SELECT 1 FROM space.files f WHERE f.id = docs.documents.file_id)
        )
        WITH CHECK (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
        )';

    FOREACH t IN ARRAY ARRAY['updates','versions','comments','images']
    LOOP
        EXECUTE format('
            CREATE POLICY tenant_isolation ON docs.%1$I
            USING (
                tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                AND EXISTS (SELECT 1 FROM docs.documents d WHERE d.file_id = docs.%1$I.file_id)
            )
            WITH CHECK (
                tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            )', t);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA docs TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA docs TO tatvaos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA docs TO tatvaos_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA docs
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA docs
    GRANT USAGE, SELECT ON SEQUENCES TO tatvaos_app;

-- The mail edge gets NOTHING, as with Space.

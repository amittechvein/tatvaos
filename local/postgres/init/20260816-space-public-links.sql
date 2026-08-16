-- ============================================================================
--  Space public links — a download for someone with no account
-- ============================================================================
--
--  Contract: docs/SPACE_API_PUBLIC_LINKS_ADDENDUM.md (v1.3, APPROVED).
--  Plan:     docs/plans/LARGE_ATTACHMENTS.md. Mail's oversize attachments
--  become "upload to Space, send a link"; the link must work for a stranger.
--
--  A link is a CAPABILITY and is treated like a credential: 128 bits of
--  randomness, stored only as a SHA-256 hash — the plaintext exists once, in
--  the response that created it. A database leak yields no working links,
--  the same rule as MFA recovery codes.
--
--  The resolve path has NO SESSION: app.tenant_id is unset and RLS cannot
--  protect it. The ONLY database access on that path is the two SECURITY
--  DEFINER functions below. Their gating predicate is TEXTUALLY IDENTICAL,
--  comment for comment — reviewers diff them, and a difference between the
--  two is a bug by definition.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Space's own per-tenant policy. NOT on core.tenants — the identity table is
-- not a junk drawer for every product's flags (Core's ruling, same ownership
-- argument as the gateway). An absent row means the defaults.
--
-- allow_public_links = false closes the TAP, not the handle: the resolve
-- predicate checks it, so existing links stop working immediately — and
-- reversibly, because rows survive. The school scenario.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS space.tenant_settings (
    tenant_id  uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    allow_public_links boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- The links.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS space.public_links (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- The link follows the FILE: moving it does not break it, trashing it
    -- 404s it (predicate below), purging it deletes this row by cascade.
    file_id    uuid NOT NULL REFERENCES space.files(id) ON DELETE CASCADE,

    -- SHA-256 hex of the token. Never the token. Lookup is by this unique
    -- index, which makes a timing attack a preimage problem.
    token_hash text NOT NULL,

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    -- Required. A link that never expires outlives the reason it was made.
    expires_at timestamptz NOT NULL,

    max_downloads  integer CHECK (max_downloads IS NULL OR max_downloads > 0),
    download_count integer NOT NULL DEFAULT 0,

    -- Reserved for v2 password protection: a feature later, not a migration.
    password_hash text,

    -- Revocation is a stamp, not a delete — the count and the audit story
    -- survive, and revoking twice is a no-op.
    revoked_at timestamptz,

    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_space_public_links_token
    ON space.public_links(token_hash);
CREATE INDEX IF NOT EXISTS idx_space_public_links_file
    ON space.public_links(file_id);

-- ----------------------------------------------------------------------------
-- RLS — tenant-scoped, for the AUTHENTICATED management endpoints. The
-- anonymous path never touches these tables under RLS; it goes through the
-- definer functions and nothing else.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tenant_settings','public_links']
    LOOP
        EXECUTE format('ALTER TABLE space.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE space.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON space.%I', t);
        EXECUTE format('
            CREATE POLICY tenant_isolation ON space.%I
            USING      (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON space.tenant_settings, space.public_links TO tatvaos_app;
-- The mail edge gets NOTHING, as everywhere in the space schema.

-- ----------------------------------------------------------------------------
-- The anonymous resolvers. SECURITY DEFINER because there is no session to
-- satisfy RLS; pinned search_path, mandatory on SECURITY DEFINER. Both take
-- the HASH — the plaintext token never reaches SQL.
--
-- peek:    metadata for the landing page. Reads, counts NOTHING.
-- consume: the download. The atomic UPDATE **is** the check — the count
--          increments in the same statement that validates every condition,
--          so max_downloads cannot be raced past. No row = the caller
--          answers 404, one string for every failure, no oracle.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION space.peek_public_link(p_token_hash text)
RETURNS TABLE (file_id uuid, name text, mime_type text, size_bytes bigint,
               shared_by text, expires_at timestamptz)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = space, core, pg_temp
AS $$
    SELECT f.id, f.name, f.mime_type, f.size_bytes,
           u.display_name, l.expires_at
      FROM space.public_links l
      JOIN space.files   f ON f.id = l.file_id
      JOIN core.tenants  t ON t.id = f.tenant_id
      LEFT JOIN space.tenant_settings s ON s.tenant_id = f.tenant_id
      LEFT JOIN core.users u ON u.id = l.created_by_user_id
     WHERE l.token_hash = p_token_hash
       -- THE PREDICATE — textually identical in consume_public_link below.
       -- Diff them in review; any difference between the two is a bug.
       AND l.revoked_at IS NULL                                        -- not revoked
       AND l.expires_at > now()                                        -- not expired
       AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads)  -- under the cap
       AND f.deleted_at IS NULL                                        -- file is live
       AND t.status IN ('active','trial')                              -- tenant is live
       AND COALESCE(s.allow_public_links, true)                        -- tap is open (absent row = default on)
$$;

CREATE OR REPLACE FUNCTION space.consume_public_link(p_token_hash text)
RETURNS TABLE (blob_key text, name text, mime_type text, size_bytes bigint)
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
       -- THE PREDICATE — textually identical in peek_public_link above.
       -- Diff them in review; any difference between the two is a bug.
       AND l.revoked_at IS NULL                                        -- not revoked
       AND l.expires_at > now()                                        -- not expired
       AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads)  -- under the cap
       AND f.deleted_at IS NULL                                        -- file is live
       AND t.status IN ('active','trial')                              -- tenant is live
       AND COALESCE(s.allow_public_links, true)                        -- tap is open (absent row = default on)
    RETURNING f.blob_key, f.name, f.mime_type, f.size_bytes
$$;

REVOKE ALL ON FUNCTION space.peek_public_link(text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION space.consume_public_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION space.peek_public_link(text)    TO tatvaos_app;
GRANT EXECUTE ON FUNCTION space.consume_public_link(text) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Space public links ready — tokens hashed at rest, resolve via';
    RAISE NOTICE '  SECURITY DEFINER only, consume counts atomically. The predicate';
    RAISE NOTICE '  appears twice and must stay textually identical.';
    RAISE NOTICE '';
END $$;

-- ============================================================================
--  Space Drive-view — per-user activity and stars
-- ============================================================================
--
--  Backs the Drive-shaped UI (docs/SPACE_API_DRIVE_ADDENDUM.md, approved
--  v1.2): Recent/Home from activity, Starred from stars. Space's FIRST
--  tables keyed on the person rather than only the tenant.
--
--  Numbering: 29. 27 is Mail's delegation, 28 is Core's product catalogue —
--  checked before taking it, per the collision history (13/14/15 all doubled
--  once).
--
--  RLS NOTE, the reason both policies read the null-guard form: the
--  interceptor sends a request with no person behind it as an EMPTY STRING,
--  not NULL. A bare ::uuid cast on '' raises and takes the whole request
--  with it — on the pre-auth path, where it is hardest to diagnose. So:
--    nullif(current_setting('app.user_id', true), '')::uuid
--  The `true` handles unset; the nullif handles set-but-empty. Both needed.
--  Same as every user-keyed policy in core, and the exact trap the Family
--  dev burned a day on.
--
--  These tables are STRICTLY per-user: my recency and my stars are invisible
--  to colleagues, enforced here, not in application code. No existing policy
--  is touched.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Activity — one row per (user, file), UPSERTED. Latest action wins.
-- ----------------------------------------------------------------------------
--
-- Bounded by users x files-they-touched, not by event count — this is "what
-- did I touch last", not an audit trail (core.audit_logs is that).
--
-- Written by the API on three paths only: user download → 'opened',
-- upload → 'created', overwrite → 'modified'. MACHINE reads — the
-- SpaceContentGateway (attach-from-Space) and thumbnail generation — do NOT
-- write here: a Mail composer listing files must not fill Recent with files
-- the person never looked at. Rename/move/share also do not record;
-- Recent answers "what was I working in", not "what did I administer".
-- The upsert is failure-isolated in the API: not recording recency must
-- never fail a download.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space.file_activity (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES core.users(id)   ON DELETE CASCADE,
    file_id     uuid NOT NULL REFERENCES space.files(id)  ON DELETE CASCADE,

    action      text NOT NULL CHECK (action IN ('opened','created','modified')),
    occurred_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, file_id)
);

-- The /recent read: my rows, newest first.
CREATE INDEX IF NOT EXISTS idx_space_activity_recent
    ON space.file_activity(user_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Stars — (user, one object), same XOR discipline as shares.
-- ----------------------------------------------------------------------------
--
-- Unique per (user, object) via partial indexes, so PUT star is an
-- idempotent no-op on a starred item rather than a duplicate row. Purging
-- the item cascades the star away; a trashed item keeps its star (it leaves
-- /starred because listings are live-only, and restore brings it back).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space.stars (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES core.users(id)   ON DELETE CASCADE,

    file_id    uuid REFERENCES space.files(id)   ON DELETE CASCADE,
    folder_id  uuid REFERENCES space.folders(id) ON DELETE CASCADE,
    CONSTRAINT stars_one_target CHECK (num_nonnulls(file_id, folder_id) = 1),

    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_space_stars_file
    ON space.stars(user_id, file_id)   WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_stars_folder
    ON space.stars(user_id, folder_id) WHERE folder_id IS NOT NULL;

-- The /starred read: my stars, most recently starred first.
CREATE INDEX IF NOT EXISTS idx_space_stars_mine
    ON space.stars(user_id, created_at DESC);

-- The isStarred batch on every listing: "which of these page ids did I star".
CREATE INDEX IF NOT EXISTS idx_space_stars_file   ON space.stars(file_id);
CREATE INDEX IF NOT EXISTS idx_space_stars_folder ON space.stars(folder_id);

-- ----------------------------------------------------------------------------
-- RLS — tenant AND me, both null-guarded (see header)
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['file_activity','stars']
    LOOP
        EXECUTE format('ALTER TABLE space.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE space.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON space.%I', t);
        EXECUTE format('
            CREATE POLICY tenant_isolation ON space.%I
            USING (
                tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
            )
            WITH CHECK (
                tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
            )', t);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Grants — the default privileges from 25 cover tables postgres creates, but
-- stating it keeps the intent visible next to the tables.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON space.file_activity, space.stars TO tatvaos_app;

-- The mail edge gets NOTHING, as everywhere in the space schema.

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Space Drive-view tables ready — file_activity (upserted, latest-wins)';
    RAISE NOTICE '  and stars (per-user, XOR target). Both RLS-forced to tenant AND user.';
    RAISE NOTICE '';
END $$;

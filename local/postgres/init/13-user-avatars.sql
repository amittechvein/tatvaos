-- ============================================================================
--  Profile photos
-- ============================================================================
--
--  A SEPARATE table, not a column on core.users. The people list joins and
--  projects core.users for every row — a school with 400 students loads it
--  constantly — and dragging image bytes through that query is the difference
--  between a page that loads and one that times out. Keeping photos out of the
--  hot table is the whole point.
--
--  CONTENT, so RLS-forced and tenant-scoped exactly like audit_logs and the
--  mail store — a photo is a tenant's data. Deliberately NO grant to
--  tatvaos_mailedge: resolving a recipient never needs to see a face.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.user_avatars (
    user_id    uuid PRIMARY KEY REFERENCES core.users(id)   ON DELETE CASCADE,
    tenant_id  uuid NOT NULL    REFERENCES core.tenants(id)  ON DELETE CASCADE,
    -- The image itself. Small by design: the API caps uploads and the UI crops
    -- to a square before sending, so this is kilobytes, not megabytes.
    image      bytea NOT NULL,
    mime       text  NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_core_user_avatars_tenant ON core.user_avatars(tenant_id);

ALTER TABLE core.user_avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_avatars FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.user_avatars;
CREATE POLICY tenant_isolation ON core.user_avatars
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.user_avatars TO tatvaos_app;

DO $$ BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Profile photos ready — core.user_avatars, RLS-forced, no mail-edge grant';
    RAISE NOTICE '';
END $$;

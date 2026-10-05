-- ============================================================================
--  TatvaOS Sheets — its own on/off switch, per organisation
-- ============================================================================
--
--  A spreadsheet is a Docs file (docs.documents holds its content; see the
--  header of 20260924-docs-schema.sql), but whether an organisation HAS
--  Sheets is a separate decision from whether it has Docs — Amit, 24 Sept
--  2026: "Give Sheets its own switch", so a school can take one without
--  the other.
--
--  Same shape and rules as docs.tenant_settings:
--    · no row = off. Sheets ships dark, so a deploy changes nothing any
--      customer sees;
--    · written only through the SuperAdmin console route
--      (SheetsAdminEndpoints), audited; the organisation has no route to it;
--    · everyone in the organisation may READ it (the editor and the home
--      page ask "is Sheets on here?").
--
--  Additive: one new table, nothing existing altered. Idempotent: every
--  statement is safe to re-run, as every file here is on every deploy.
--  Sorts after 20260924-docs-schema.sql, which creates the docs schema.
-- ============================================================================

CREATE TABLE IF NOT EXISTS docs.sheets_tenant_settings (
    tenant_id  uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    enabled    boolean NOT NULL DEFAULT false,
    updated_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE docs.sheets_tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.sheets_tenant_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON docs.sheets_tenant_settings;
CREATE POLICY tenant_isolation ON docs.sheets_tenant_settings
    USING (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    );

-- The docs schema's default privileges already cover a new table; stated
-- again so this file does not depend on who ran the earlier one.
GRANT SELECT, INSERT, UPDATE, DELETE ON docs.sheets_tenant_settings TO tatvaos_app;

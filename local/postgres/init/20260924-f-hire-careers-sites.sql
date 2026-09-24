-- ============================================================================
--  TatvaOS Hire — careers sites (the public job pages), switched OFF
-- ============================================================================
--
--  Depends on 20260924-b-hire-job-openings.sql (hire schema). Independent of
--  -c/-d/-e; sorts after them.
--
--  Decision 0010 §1 (proposed, awaiting Mr. Singh): an organisation's open
--  jobs are listed at  hire.tatvaos.com/careers/{site}  and each at
--  /careers/{site}/{job-slug}. This file adds the {site} half: a Hire-owned
--  row per organisation with its public short name.
--
--  TWO SWITCHES, BOTH OFF, BOTH FAIL CLOSED:
--    1. hire.careers_sites.is_enabled — the organisation's own. Default false,
--       and it cannot be true without an erasure contact (0010 §7: the notice
--       names who answers "delete my data").
--    2. core.platform_settings 'hire.careers_portal_enabled' — Techvein's.
--       Inserted as 'false' here. NOTHING is public anywhere until someone
--       sets it to 'true', which waits for Mr. Singh's rulings on 0010 and the
--       lawyer's answer on retention (Amit, 24 Sept 2026). A missing row
--       reads as false, never as true.
--  hire.resolve_careers_site() checks both, plus that the organisation itself
--  is trial or active. Any failure answers exactly like an unknown slug.
--
--  NOT A COLUMN ON core.tenants. A public short name is a Hire decision; an
--  organisation without Hire must not have one, and Core's table stays as it
--  is.
--
--  The slug is unique ACROSS THE PLATFORM (it is the first path segment of a
--  public URL). Row-level security means an organisation cannot see which
--  slugs others hold; a taken slug surfaces as the unique index refusing the
--  insert, which the API turns into "that address is taken".
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hire.careers_sites (
    tenant_id        uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- 3..40 characters: lower-case letters, digits, single hyphens inside.
    slug             text NOT NULL CHECK (slug ~ '^[a-z0-9](-?[a-z0-9])+$' AND length(slug) BETWEEN 3 AND 40),
    -- The name candidates see ("Techvein IT Solutions"). Plain text.
    display_name     text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    -- Who answers "see / correct / delete my data" (Amit, 24 Sept 2026: the
    -- organisation's owner unless they name someone else; 30 days).
    erasure_contact  text CHECK (erasure_contact IS NULL
                                 OR (length(erasure_contact) <= 320
                                     AND erasure_contact ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
    is_enabled       boolean NOT NULL DEFAULT false,
    updated_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_careers_enabled_needs_contact CHECK (NOT is_enabled OR erasure_contact IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_hire_careers_sites_slug ON hire.careers_sites (slug);

COMMENT ON TABLE hire.careers_sites IS
    'Public careers page per organisation (decision 0010). Off by default; also gated by '
    'core.platform_settings hire.careers_portal_enabled.';

GRANT SELECT, INSERT, UPDATE ON hire.careers_sites TO tatvaos_app;
ALTER TABLE hire.careers_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE hire.careers_sites FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hire.careers_sites;
CREATE POLICY tenant_isolation ON hire.careers_sites
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The platform switch. DO NOTHING on conflict: once someone turns it on (or
-- deliberately off), a deploy must not quietly reset it — the lesson of
-- 20260909-hire-people-products.sql.
INSERT INTO core.platform_settings (key, value)
VALUES ('hire.careers_portal_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- ---- the pre-tenant resolver -------------------------------------------------
-- The same circle every public path here breaks: row-level security needs a
-- tenant, and the tenant is not known until the slug is found. One row, by
-- the slug the caller already holds, and ONLY when everything says yes.
CREATE OR REPLACE FUNCTION hire.resolve_careers_site(p_slug text)
RETURNS TABLE (tenant_id uuid, display_name text, erasure_contact text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = hire, core, pg_temp
AS $$
    SELECT s.tenant_id, s.display_name, s.erasure_contact
      FROM hire.careers_sites s
      JOIN core.tenants t ON t.id = s.tenant_id
     WHERE s.slug = lower(p_slug)
       AND s.is_enabled
       AND t.status IN ('trial', 'active')
       AND coalesce((SELECT value FROM core.platform_settings
                      WHERE key = 'hire.careers_portal_enabled'), 'false') = 'true';
$$;
REVOKE ALL ON FUNCTION hire.resolve_careers_site(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hire.resolve_careers_site(text) TO tatvaos_app;

DO $$
DECLARE
    pol int;
    sw  text;
BEGIN
    SELECT count(*) INTO pol FROM pg_policies
     WHERE schemaname = 'hire' AND tablename = 'careers_sites' AND policyname = 'tenant_isolation';
    SELECT value INTO sw FROM core.platform_settings WHERE key = 'hire.careers_portal_enabled';
    RAISE NOTICE '';
    RAISE NOTICE '  hire.careers_sites tenant_isolation: %; platform switch hire.careers_portal_enabled = %',
        CASE WHEN pol = 1 THEN 'present' ELSE 'MISSING' END, coalesce(sw, '(missing - reads as false)');
    RAISE NOTICE '';
END $$;

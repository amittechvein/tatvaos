-- The minimum core.domains this migration needs, as it stood BEFORE it:
-- fqdn unique outright, which is the rule the migration replaces.
CREATE SCHEMA IF NOT EXISTS core;
CREATE TABLE IF NOT EXISTS core.domains (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL,
    fqdn                  text NOT NULL,
    is_active             boolean NOT NULL DEFAULT false,
    is_platform           boolean NOT NULL DEFAULT false,
    ownership_verified_at timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT domains_fqdn_key UNIQUE (fqdn)
);

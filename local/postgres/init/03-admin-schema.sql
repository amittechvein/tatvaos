-- ============================================================================
--  TatvaOS Mail — administration schema
-- ============================================================================
--
--  Adds what the admin panels and the .NET API need on top of 01-schema.sql:
--  plans, user categories, and the organisation/mailbox columns that back the
--  onboarding wizard.
--
--  Written as idempotent ALTERs rather than a fresh CREATE, so it applies to a
--  database that already holds seeded tenants and mail. Files in this folder
--  only run on an EMPTY volume, so for an existing stack use:
--
--      ./scripts/apply-schema.sh
--
--  Safe to run repeatedly.
--
--  The RLS boundary from 01-schema.sql is preserved exactly: routing tables
--  stay readable by the mail edge, content tables stay RLS-forced and out of
--  its reach. Every new table here is routing data, so none of them get RLS —
--  and the grants at the end say so explicitly rather than by omission.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Plans — global, not tenant-scoped
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    text NOT NULL,
    max_users               integer,
    storage_model           text NOT NULL DEFAULT 'per_user'
                            CHECK (storage_model IN ('per_user','pooled')),
    per_user_quota_bytes    bigint,
    pooled_storage_bytes    bigint,
    max_domains             integer,
    price_per_user_monthly  numeric(10,2),
    price_monthly           numeric(10,2),
    created_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (id, name, max_users, storage_model, per_user_quota_bytes, pooled_storage_bytes, max_domains, price_per_user_monthly, price_monthly)
VALUES
    ('a0000000-0000-0000-0000-000000000001','Starter',      10,  'per_user',  5368709120,    NULL,           1,   49,    NULL),
    ('a0000000-0000-0000-0000-000000000002','Business',     100, 'per_user',  32212254720,   NULL,           5,   99,    NULL),
    ('a0000000-0000-0000-0000-000000000003','Institution',  500, 'pooled',    NULL,          2199023255552,  10,  NULL,  14999),
    ('a0000000-0000-0000-0000-000000000004','Enterprise',   NULL,'pooled',    NULL,          10995116277760, NULL,NULL,  49999)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Organisations — the onboarding wizard's fields
-- ----------------------------------------------------------------------------

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS type                 text NOT NULL DEFAULT 'business',
    ADD COLUMN IF NOT EXISTS plan_id              uuid,
    -- 'per_user' or 'pooled'. Every quota decision reads this.
    ADD COLUMN IF NOT EXISTS storage_model        text NOT NULL DEFAULT 'per_user',
    ADD COLUMN IF NOT EXISTS max_users            integer,
    ADD COLUMN IF NOT EXISTS per_user_quota_bytes bigint,
    ADD COLUMN IF NOT EXISTS pooled_storage_bytes bigint,
    ADD COLUMN IF NOT EXISTS admin_name           text,
    ADD COLUMN IF NOT EXISTS admin_email          text,
    ADD COLUMN IF NOT EXISTS phone                text,
    ADD COLUMN IF NOT EXISTS country              text NOT NULL DEFAULT 'India',
    ADD COLUMN IF NOT EXISTS gstin                text,
    ADD COLUMN IF NOT EXISTS suspended_at         timestamptz,
    ADD COLUMN IF NOT EXISTS trial_ends_at        timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_storage_model_check') THEN
        ALTER TABLE tenants ADD CONSTRAINT tenants_storage_model_check
            CHECK (storage_model IN ('per_user','pooled'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_plan_fk') THEN
        ALTER TABLE tenants ADD CONSTRAINT tenants_plan_fk
            FOREIGN KEY (plan_id) REFERENCES plans(id);
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Domains — ownership verification
-- ----------------------------------------------------------------------------
--
--  ownership_verified_at is the gate. Until it is set, no mail is accepted for
--  the domain and no mailbox on it can send. That single rule is what stops
--  anyone claiming a domain they do not control.
-- ----------------------------------------------------------------------------

ALTER TABLE domains
    ADD COLUMN IF NOT EXISTS verification_token     text,
    ADD COLUMN IF NOT EXISTS ownership_verified_at  timestamptz,
    ADD COLUMN IF NOT EXISTS mx_verified_at         timestamptz,
    ADD COLUMN IF NOT EXISTS dkim_selector          text,
    ADD COLUMN IF NOT EXISTS dkim_private_key_ref   text,
    ADD COLUMN IF NOT EXISTS dmarc_policy           text NOT NULL DEFAULT 'none';

-- Existing seeded domains were already trusted, so carry verified_at across
-- rather than silently breaking delivery for the local stack.
UPDATE domains
   SET ownership_verified_at = COALESCE(ownership_verified_at, verified_at),
       mx_verified_at        = COALESCE(mx_verified_at, verified_at)
 WHERE verified_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- User categories
-- ----------------------------------------------------------------------------
--
--  A category carries the defaults applied to every user created in it —
--  quota, role, group membership, and whether members may send externally.
--  Creating fifty accounts with identical settings one at a time is the most
--  tedious part of onboarding an organisation; this is what removes it.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_categories (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                text NOT NULL,
    description         text,
    default_quota_bytes bigint,
    default_role        text NOT NULL DEFAULT 'employee',
    -- False for students. A school requirement, and a genuine abuse control.
    can_send_external   boolean NOT NULL DEFAULT true,
    auto_groups         text[] NOT NULL DEFAULT '{}',
    colour              text NOT NULL DEFAULT '#3563f0',
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_categories_tenant ON user_categories(tenant_id);

-- ----------------------------------------------------------------------------
-- Mailboxes — category link and identity fields
-- ----------------------------------------------------------------------------

ALTER TABLE mailboxes
    ADD COLUMN IF NOT EXISTS category_id     uuid REFERENCES user_categories(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS display_name    text,
    ADD COLUMN IF NOT EXISTS role            text NOT NULL DEFAULT 'employee',
    ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS mfa_secret_ref  text,
    ADD COLUMN IF NOT EXISTS last_login_at   timestamptz;

CREATE INDEX IF NOT EXISTS idx_mailboxes_category ON mailboxes(tenant_id, category_id);

-- ----------------------------------------------------------------------------
-- Backfill so the seeded local data works with the new API
-- ----------------------------------------------------------------------------

UPDATE tenants SET
    plan_id = COALESCE(plan_id, 'a0000000-0000-0000-0000-000000000002'),
    storage_model = COALESCE(NULLIF(storage_model,''), 'per_user'),
    max_users = COALESCE(max_users, 100),
    per_user_quota_bytes = COALESCE(per_user_quota_bytes, 32212254720)
WHERE plan_id IS NULL;

UPDATE mailboxes
   SET display_name = COALESCE(display_name, initcap(replace(local_part, '.', ' ')))
 WHERE display_name IS NULL;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
--
--  Stated explicitly rather than left to ALTER DEFAULT PRIVILEGES, because the
--  mail edge's access is a security boundary and should be visible in the file
--  that creates the tables.
--
--  user_categories is ROUTING data — Dovecot needs can_send_external to decide
--  whether a submission is permitted. It carries no message content.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON plans, user_categories TO tatvaos_app;
GRANT SELECT ON user_categories, plans TO tatvaos_mailedge;

-- The mail edge still gets nothing on content tables. Unchanged, and asserted
-- on every run by tests/isolation/test-isolation.sh.

-- ----------------------------------------------------------------------------
DO $$
DECLARE n_plans int; n_cats int; n_cols int;
BEGIN
    SELECT count(*) INTO n_plans FROM plans;
    SELECT count(*) INTO n_cats  FROM user_categories;
    SELECT count(*) INTO n_cols  FROM information_schema.columns
     WHERE table_name = 'tenants';
    RAISE NOTICE '';
    RAISE NOTICE '  Admin schema applied';
    RAISE NOTICE '    plans: %  categories: %  tenant columns: %', n_plans, n_cats, n_cols;
    RAISE NOTICE '';
END $$;

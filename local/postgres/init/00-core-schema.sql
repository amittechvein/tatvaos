-- ============================================================================
--  TatvaOS Core — the platform layer
-- ============================================================================
--
--  Core is NOT the admin section of Mail. It is the layer every TatvaOS
--  product plugs into: Mail, People, Payroll, Drive, Sheet, Word.
--
--  Core owns          Products own
--  ─────────          ────────────
--  tenants            their own data, keyed by core.users.id
--  domains            mail.mailboxes, drive.files, people.employees …
--  users (identity)
--  categories
--  plans, billing
--  storage pools
--
--  The rule that makes a second product cheap: A PERSON EXISTS ONCE, IN CORE.
--  Mail grants that person a mailbox; Drive grants them a file store; Payroll
--  grants them a record. One login, one password reset, and one suspend action
--  that removes access to everything at once.
--
--  Getting this wrong is the expensive mistake. Identity duplicated per product
--  means six passwords per employee and six places to revoke on the day someone
--  leaves — and the one you forget is the one that matters.
--
--  Postgres schemas give the namespace separation: core.*, mail.*, drive.*.
--  Grants are then per schema, so a compromised product cannot read another's
--  tables even by accident.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mail;

-- ----------------------------------------------------------------------------
-- Roles
-- ----------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tatvaos_app') THEN
        CREATE ROLE tatvaos_app LOGIN PASSWORD 'dev_app_pw' NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tatvaos_mailedge') THEN
        CREATE ROLE tatvaos_mailedge LOGIN PASSWORD 'dev_mail_pw' NOBYPASSRLS;
    END IF;
END $$;

-- ============================================================================
--  PRODUCT REGISTRY
-- ============================================================================
--
--  Every TatvaOS product registers here. Access, billing and storage all key
--  off this table, so adding Drive later is a row plus a schema — not a change
--  to how tenants or users work.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.products (
    code         text PRIMARY KEY,
    name         text NOT NULL,
    description  text,
    is_available boolean NOT NULL DEFAULT false,
    sort_order   int NOT NULL DEFAULT 100
);

INSERT INTO core.products (code, name, description, is_available, sort_order) VALUES
    ('mail',    'TatvaOS Mail',    'Business email hosting',        true,  10),
    ('drive',   'TatvaOS Drive',   'File storage and sharing',      false, 20),
    ('people',  'TatvaOS People',  'HR and employee records',       false, 30),
    ('payroll', 'TatvaOS Payroll', 'Salary and compliance',         false, 40),
    ('sheet',   'TatvaOS Sheet',   'Spreadsheets',                  false, 50),
    ('word',    'TatvaOS Word',    'Documents',                     false, 60)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
--  TENANTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    type        text NOT NULL DEFAULT 'business'
                CHECK (type IN ('business','school','hospital','nonprofit','government','other')),
    status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','trial','active','suspended','deleted')),

    admin_name  text,
    admin_email citext,
    phone       text,
    country     text NOT NULL DEFAULT 'India',
    gstin       text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    suspended_at  timestamptz,
    trial_ends_at timestamptz
);

-- ============================================================================
--  DOMAINS
-- ============================================================================
--
--  Owned by Core, not Mail. A domain is a tenant's identity across every
--  product — the same domain that receives mail signs people in and appears on
--  a shared Drive link.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.domains (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    fqdn      citext NOT NULL UNIQUE,
    type      text NOT NULL DEFAULT 'primary'
              CHECK (type IN ('primary','alias','independent')),
    is_active boolean NOT NULL DEFAULT false,

    -- Until ownership_verified_at is set, nothing is accepted for this domain
    -- and nobody can sign in on it. The single rule that stops a customer
    -- claiming a domain they do not control.
    verification_token    text,
    ownership_verified_at timestamptz,
    mx_verified_at        timestamptz,

    dkim_selector        text,
    dkim_private_key_ref text,
    dmarc_policy         text NOT NULL DEFAULT 'none',

    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_domains_tenant ON core.domains(tenant_id);

-- ============================================================================
--  USERS — identity, owned by Core
-- ============================================================================
--
--  THIS TABLE IS THE POINT OF THE WHOLE STRUCTURE.
--
--  A person has ONE row here regardless of how many products they use.
--  Password, MFA and status live here and nowhere else, so:
--
--    • one sign-on covers Mail, Drive, Payroll and everything after
--    • suspending someone removes every product at once
--    • a password reset is one action, not six
--
--  Product-specific data hangs off this id: mail.mailboxes.user_id,
--  drive.accounts.user_id, people.employees.user_id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.users (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    domain_id uuid REFERENCES core.domains(id) ON DELETE SET NULL,

    -- Sign-in identity. Usually matches the mailbox address, but not by
    -- necessity — a Payroll-only user needs a login and no mailbox at all.
    email        citext NOT NULL UNIQUE,
    display_name text NOT NULL,

    -- Argon2id. The local stack seeds SHA512-CRYPT because every Dovecot build
    -- supports it; that is a development convenience and must never ship.
    password_hash text,
    mfa_secret_ref text,
    mfa_enabled   boolean NOT NULL DEFAULT false,

    department_id uuid,
    role        text NOT NULL DEFAULT 'employee',
    status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','suspended','deleted')),

    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_users_tenant   ON core.users(tenant_id);

-- The department index, foreign key and mail-edge grant live in
-- 09-departments.sql, AFTER the renames that file performs. Creating them
-- here broke every deploy against a database born before the rename: this
-- file said category_id, production said department_id, and the deploy log
-- said [FAIL] under enough NOTICE noise that nobody read it. One file owns
-- the rename; the same file owns everything that depends on its outcome.
DROP INDEX IF EXISTS core.idx_core_users_category;

-- ============================================================================
--  DEPARTMENTS
-- ============================================================================
--
--  Teachers, Students, Doctors, Engineering. Carries defaults for new users
--  ACROSS products — which products they get, their storage, their role.
--  Creating fifty accounts with identical settings one at a time is what makes
--  an admin abandon a platform. 09-departments.sql turns this into a tree.
--
--  Guarded: on a database old enough to still have core.user_categories, this
--  must NOT create core.departments — 09's RENAME would then collide with it.
--  On such a database the rename in 09 produces this exact table instead.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'core' AND table_name = 'user_categories') THEN
        CREATE TABLE IF NOT EXISTS core.departments (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
            name        text NOT NULL,
            description text,

            default_role      text NOT NULL DEFAULT 'employee',
            default_quota_bytes bigint,
            -- Which products a new user in this department receives. Students
            -- might get mail and drive but not payroll.
            default_products  text[] NOT NULL DEFAULT ARRAY['mail'],
            -- False for students: a school requirement and a real abuse control.
            can_send_external boolean NOT NULL DEFAULT true,

            auto_groups text[] NOT NULL DEFAULT '{}',
            colour      text NOT NULL DEFAULT '#3563f0',
            created_at  timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, name)
        );
    END IF;
END $$;

-- The old constraint, under either historical name. The current one is added
-- in 09-departments.sql once the rename has definitely happened.
ALTER TABLE core.users DROP CONSTRAINT IF EXISTS core_users_category_fk;

-- ============================================================================
--  PRODUCT ACCESS
-- ============================================================================
--
--  Which user may use which product. Separate from core.users so granting
--  Drive to an existing employee is one row, not a schema change.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.product_access (
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    product_code text NOT NULL REFERENCES core.products(code),
    granted_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    PRIMARY KEY (user_id, product_code)
);
CREATE INDEX IF NOT EXISTS idx_core_access_tenant ON core.product_access(tenant_id, product_code);

-- ============================================================================
--  PLANS AND SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.plans (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   text NOT NULL,
    max_users              integer,
    storage_model          text NOT NULL DEFAULT 'per_user'
                           CHECK (storage_model IN ('per_user','pooled')),
    per_user_quota_bytes   bigint,
    pooled_storage_bytes   bigint,
    max_domains            integer,
    included_products      text[] NOT NULL DEFAULT ARRAY['mail'],
    price_per_user_monthly numeric(10,2),
    price_monthly          numeric(10,2),
    created_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.plans (id, name, max_users, storage_model, per_user_quota_bytes,
                        pooled_storage_bytes, max_domains, included_products,
                        price_per_user_monthly, price_monthly) VALUES
 ('a0000000-0000-0000-0000-000000000001','Starter',    10,  'per_user', 5368709120,   NULL,           1,   ARRAY['mail'],                 49,   NULL),
 ('a0000000-0000-0000-0000-000000000002','Business',   100, 'per_user', 32212254720,  NULL,           5,   ARRAY['mail','drive'],         99,   NULL),
 ('a0000000-0000-0000-0000-000000000003','Institution',500, 'pooled',   NULL,         2199023255552,  10,  ARRAY['mail','drive','people'],NULL, 14999),
 ('a0000000-0000-0000-0000-000000000004','Enterprise', NULL,'pooled',   NULL,         10995116277760, NULL,ARRAY['mail','drive','people','payroll','sheet','word'], NULL, 49999)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.subscriptions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    plan_id    uuid NOT NULL REFERENCES core.plans(id),
    status     text NOT NULL DEFAULT 'trial'
               CHECK (status IN ('trial','active','past_due','cancelled')),
    seats      integer NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT now(),
    renews_at  timestamptz,
    cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_core_subs_tenant ON core.subscriptions(tenant_id);

-- ============================================================================
--  STORAGE — one tenant pool, split across products
-- ============================================================================
--
--  The customer buys ONE number. Their admin decides how it is divided:
--  2 TB total, 1.5 TB to Mail, 0.5 TB to Drive, rebalanced whenever they like.
--
--  Why not a single free-for-all pool: Mail would fill it and Drive would
--  silently stop working, with no way for the admin to see it coming.
--  Why not separate purchases: the customer has to guess the split up front,
--  and will guess wrong.
--
--  An allocation of NULL means "draw from whatever is left" — useful for
--  products the customer does not want to think about.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.storage_pools (
    tenant_id      uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    storage_model  text NOT NULL DEFAULT 'per_user'
                   CHECK (storage_model IN ('per_user','pooled')),
    total_bytes    bigint NOT NULL DEFAULT 0,
    per_user_quota_bytes bigint,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.storage_allocations (
    tenant_id      uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    product_code   text NOT NULL REFERENCES core.products(code),
    allocated_bytes bigint,
    -- Maintained incrementally by each product. Never SUM() on read; a mailbox
    -- check runs on every inbound message.
    used_bytes     bigint NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, product_code)
);

-- Allocations must not exceed the pool. Enforced in the application because a
-- CHECK cannot see another table, but stated here so the intent is not lost.
CREATE OR REPLACE FUNCTION core.pool_overcommitted(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(a.allocated_bytes), 0) > COALESCE(p.total_bytes, 0)
      FROM core.storage_allocations a
      JOIN core.storage_pools p ON p.tenant_id = a.tenant_id
     WHERE a.tenant_id = p_tenant
     GROUP BY p.total_bytes;
$$;

-- ============================================================================
--  AUDIT
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.audit_logs (
    id            bigserial PRIMARY KEY,
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    product_code  text REFERENCES core.products(code),
    actor_user_id uuid,
    -- text, not inet. Npgsql maps a C# string to text and PostgreSQL has no
    -- implicit text -> inet cast, so an inet column here means every audit
    -- write fails at runtime. Nothing queries this by subnet; if that ever
    -- changes, cast at read time rather than breaking the write path.
    actor_ip      text,
    action        text NOT NULL,
    target_type   text,
    target_id     text,
    before_state  jsonb,
    after_state   jsonb,
    occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_audit ON core.audit_logs(tenant_id, occurred_at DESC);

-- ============================================================================
--  ROW LEVEL SECURITY
-- ============================================================================
--
--  Same boundary as before, now expressed across schemas.
--
--  ROUTING data — tenants, domains, users, categories — carries no RLS,
--  because the mail edge must resolve a recipient before any tenant is known.
--  It gets SELECT on those and nothing else.
--
--  CONTENT — audit logs here, messages in mail.* — is RLS-forced.
-- ============================================================================

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['audit_logs','product_access','subscriptions',
                             'storage_pools','storage_allocations']
    LOOP
        EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE core.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON core.%I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON core.%I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
    END LOOP;
END $$;

-- ============================================================================
--  GRANTS
-- ============================================================================

GRANT USAGE ON SCHEMA core, mail TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA core TO tatvaos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA core TO tatvaos_app;

-- The mail edge: routing lookups only. No billing, no audit, no product access.
-- The departments grant is in 09-departments.sql — the table may still be
-- called user_categories when this file runs.
GRANT USAGE  ON SCHEMA core TO tatvaos_mailedge;
GRANT SELECT ON core.tenants, core.domains, core.users
      TO tatvaos_mailedge;

ALTER DEFAULT PRIVILEGES IN SCHEMA core
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- ----------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM core.products;
    RAISE NOTICE '';
    RAISE NOTICE '  TatvaOS Core schema ready — % products registered', n;
    RAISE NOTICE '  Identity lives in core.users. Products key off it.';
    RAISE NOTICE '';
END $$;

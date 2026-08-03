-- ============================================================================
--  TatvaOS Mail - local development schema
-- ============================================================================
--
--  THE CENTRAL DESIGN POINT OF THIS FILE
--
--  Not every table can be tenant-isolated, and pretending otherwise produces
--  a mail server that cannot deliver mail.
--
--  The MTA is inherently cross-tenant: an SMTP connection arrives with no
--  authentication and no tenant context. Postfix must answer "does this
--  recipient exist anywhere on the platform?" before it can reply 250 or 550.
--  That is a cross-tenant question by definition.
--
--  So the boundary is drawn between two kinds of table:
--
--    ROUTING tables    domains, mailboxes, aliases
--                      No RLS. Read by the mail edge across all tenants.
--                      Addresses and password hashes - no message content.
--
--    CONTENT tables    messages, folders, attachments, audit_logs
--                      RLS enabled AND forced. The mail edge has no grant
--                      on these at all.
--
--  Two database roles express this:
--
--    tatvaos_app       the API. RLS applies. Sees only its own tenant.
--    tatvaos_mailedge  Postfix/Dovecot. SELECT on routing tables only.
--                      Cannot read a message body even if fully compromised.
--
--  A compromised mail edge therefore leaks the address list, not the mail.
--  That is the correct blast radius, and it is a deliberate choice rather
--  than an accident of which grants happened to get written.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";      -- case-insensitive email addresses

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
END
$$;

-- ============================================================================
--  ROUTING TABLES  -  cross-tenant by necessity, no message content
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','suspended','deleted')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domains (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    fqdn        citext      NOT NULL UNIQUE,      -- globally unique across the platform
    type        text        NOT NULL DEFAULT 'primary'
                            CHECK (type IN ('primary','alias','independent')),
    is_active   boolean     NOT NULL DEFAULT false,
    verified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_domains_tenant ON domains(tenant_id);

CREATE TABLE IF NOT EXISTS mailboxes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain_id     uuid   NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    address       citext NOT NULL UNIQUE,          -- full address: amit@techvein.local
    local_part    citext NOT NULL,
    type          text   NOT NULL DEFAULT 'user'
                         CHECK (type IN ('user','shared','group')),
    -- Local dev uses SHA512-CRYPT because every Dovecot build supports it.
    -- PRODUCTION USES ARGON2ID (architecture section 9). Do not ship this scheme.
    password_hash text,
    quota_bytes   bigint  NOT NULL DEFAULT 1073741824,   -- 1 GiB
    used_bytes    bigint  NOT NULL DEFAULT 0,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_tenant ON mailboxes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain_id);

CREATE TABLE IF NOT EXISTS aliases (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain_id         uuid   NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    address           citext NOT NULL UNIQUE,
    target_mailbox_id uuid   NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aliases_tenant ON aliases(tenant_id);

-- ============================================================================
--  CONTENT TABLES  -  RLS enforced, mail edge has no access
-- ============================================================================

CREATE TABLE IF NOT EXISTS folders (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mailbox_id   uuid   NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    parent_id    uuid   REFERENCES folders(id) ON DELETE CASCADE,
    name         text   NOT NULL,
    special_use  text,                       -- \Inbox \Sent \Drafts \Junk \Trash
    -- IMAP requires these. Retro-fitting them is painful; design them in now.
    uid_validity bigint NOT NULL DEFAULT (extract(epoch from now())::bigint),
    uid_next     bigint NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mailbox_id, name)
);
CREATE INDEX IF NOT EXISTS idx_folders_tenant ON folders(tenant_id);

CREATE TABLE IF NOT EXISTS messages (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mailbox_id        uuid   NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    folder_id         uuid   NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    imap_uid          bigint NOT NULL DEFAULT 1,
    message_id_header text,
    thread_id         uuid,
    from_addr         citext,
    to_addrs          text[],
    subject           text,
    sent_at           timestamptz,
    received_at       timestamptz NOT NULL DEFAULT now(),
    size_bytes        bigint  NOT NULL DEFAULT 0,
    is_read           boolean NOT NULL DEFAULT false,
    is_flagged        boolean NOT NULL DEFAULT false,
    spam_score        real,
    -- Bodies live in object storage in production (architecture 7.1).
    -- Local dev keeps them inline so the stack has no S3 dependency.
    blob_key          text,
    raw_body          text,
    headers           jsonb,
    search_vector     tsvector
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant  ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_folder  ON messages(folder_id, imap_uid);
CREATE INDEX IF NOT EXISTS idx_messages_search  ON messages USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS attachments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    message_id   uuid   NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename     text   NOT NULL,
    content_type text,
    size_bytes   bigint NOT NULL DEFAULT 0,
    sha256       text,                      -- dedup key, WITHIN a tenant only
    blob_key     text,
    scan_status  text NOT NULL DEFAULT 'pending'
                 CHECK (scan_status IN ('pending','clean','infected','error'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant ON attachments(tenant_id);
-- Dedup is scoped to the tenant. Cross-tenant dedup would be a side channel:
-- "does another organisation hold this exact file?" is information you must not leak.
CREATE INDEX IF NOT EXISTS idx_attachments_dedup ON attachments(tenant_id, sha256);

CREATE TABLE IF NOT EXISTS audit_logs (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_user_id  uuid,
    actor_ip       inet,
    action         text NOT NULL,
    target_type    text,
    target_id      text,
    before_state   jsonb,
    after_state    jsonb,
    occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, occurred_at DESC);

-- ============================================================================
--  ROW LEVEL SECURITY  -  content tables only
-- ============================================================================
--
--  FORCE matters. Without it the table OWNER bypasses the policy, and in dev
--  the owner is usually who you are connected as - so the policy silently does
--  nothing while you believe you are protected.
--
--  Superusers and BYPASSRLS roles skip policies even with FORCE, which is why
--  both application roles are created NOBYPASSRLS above.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['folders','messages','attachments','audit_logs']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
            t);
    END LOOP;
END
$$;

-- current_setting(..., true) returns NULL rather than raising when unset.
-- NULL = anything is NULL, never true, so an unset tenant context yields zero
-- rows. Failing closed is the only acceptable default here.

-- ============================================================================
--  GRANTS
-- ============================================================================

-- The API: access to everything, constrained by RLS at runtime.
GRANT USAGE ON SCHEMA public TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO tatvaos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO tatvaos_app;

-- The mail edge: read-only, routing tables ONLY.
-- Deliberately absent: messages, attachments, folders, audit_logs.
GRANT USAGE  ON SCHEMA public                        TO tatvaos_mailedge;
GRANT SELECT ON tenants, domains, mailboxes, aliases TO tatvaos_mailedge;

-- Anything created later inherits the same posture.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- ============================================================================
--  Convenience: standard folder set for every new mailbox
-- ============================================================================

--  Deliberately SECURITY INVOKER (the default), not SECURITY DEFINER.
--
--  DEFINER would run as the function owner and quietly bypass RLS, so folder
--  creation would always succeed. INVOKER runs as the caller, which means the
--  WITH CHECK policy on `folders` still applies - and if the API ever creates
--  a mailbox for tenant A while its connection is scoped to tenant B, this
--  insert fails loudly instead of silently writing a row across the boundary.
--
--  A trigger that cannot fail is a trigger that cannot catch your mistakes.

CREATE OR REPLACE FUNCTION create_default_folders() RETURNS trigger AS $$
BEGIN
    INSERT INTO folders (tenant_id, mailbox_id, name, special_use)
    VALUES
        (NEW.tenant_id, NEW.id, 'INBOX',  '\Inbox'),
        (NEW.tenant_id, NEW.id, 'Sent',   '\Sent'),
        (NEW.tenant_id, NEW.id, 'Drafts', '\Drafts'),
        (NEW.tenant_id, NEW.id, 'Junk',   '\Junk'),
        (NEW.tenant_id, NEW.id, 'Trash',  '\Trash');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_default_folders ON mailboxes;
CREATE TRIGGER trg_default_folders
    AFTER INSERT ON mailboxes
    FOR EACH ROW EXECUTE FUNCTION create_default_folders();

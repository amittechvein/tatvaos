-- ============================================================================
--  TatvaOS Mail — the first product on Core
-- ============================================================================
--
--  Mail owns mailboxes and messages. It does NOT own people — every mailbox
--  points at a core.users row.
--
--  The distinction that makes this work:
--
--    core.users     a person who can sign in
--    mail.mailboxes a store that receives mail
--
--  They are not the same thing, and conflating them breaks three real cases:
--    • shared mailboxes (support@) have no person behind them
--    • a departed employee's mailbox is retained after the user is suspended
--    • a Payroll-only user needs a login and no mailbox at all
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS mail;

-- ----------------------------------------------------------------------------
-- Mailboxes
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mail.mailboxes (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    domain_id uuid NOT NULL REFERENCES core.domains(id) ON DELETE CASCADE,

    -- NULL for shared mailboxes and groups: they have no person behind them.
    -- Also NULL after a user is deleted but their mail is retained.
    user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    address    citext NOT NULL UNIQUE,
    local_part citext NOT NULL,
    type       text NOT NULL DEFAULT 'user'
               CHECK (type IN ('user','shared','group')),

    -- Authentication for IMAP/SMTP clients that cannot do OAuth. Distinct from
    -- the Core password: an app password is scoped, revocable and listed, so
    -- revoking Thunderbird does not lock the person out of Payroll.
    imap_password_hash text,

    quota_bytes bigint NOT NULL DEFAULT 15728640000,
    used_bytes  bigint NOT NULL DEFAULT 0,

    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mail_mailboxes_tenant ON mail.mailboxes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mail_mailboxes_user   ON mail.mailboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_mail_mailboxes_domain ON mail.mailboxes(domain_id);

CREATE TABLE IF NOT EXISTS mail.aliases (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    domain_id uuid NOT NULL REFERENCES core.domains(id) ON DELETE CASCADE,
    target_mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    address   citext NOT NULL UNIQUE,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Delegated access to a shared mailbox. Attribution stays with the human.
CREATE TABLE IF NOT EXISTS mail.mailbox_permissions (
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    permission text NOT NULL CHECK (permission IN ('read','send_as','send_on_behalf','full')),
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mailbox_id, user_id, permission)
);

-- ----------------------------------------------------------------------------
-- Content — RLS forced, mail edge has no access
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mail.folders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    parent_id  uuid REFERENCES mail.folders(id) ON DELETE CASCADE,
    name       text NOT NULL,
    special_use text,
    uid_validity bigint NOT NULL DEFAULT (extract(epoch from now())::bigint),
    uid_next     bigint NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mailbox_id, name)
);

CREATE TABLE IF NOT EXISTS mail.messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    folder_id  uuid NOT NULL REFERENCES mail.folders(id) ON DELETE CASCADE,
    thread_id  uuid,
    imap_uid   bigint NOT NULL DEFAULT 1,

    message_id_header text,
    from_addr  citext,
    to_addrs   text[],
    subject    text,
    sent_at     timestamptz,
    received_at timestamptz NOT NULL DEFAULT now(),
    size_bytes  bigint NOT NULL DEFAULT 0,
    is_read     boolean NOT NULL DEFAULT false,
    is_flagged  boolean NOT NULL DEFAULT false,
    spam_score  real,

    blob_key   text,
    raw_body   text,
    headers    jsonb,
    search_vector tsvector
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_tenant  ON mail.messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox ON mail.messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_messages_folder  ON mail.messages(folder_id, imap_uid);
CREATE INDEX IF NOT EXISTS idx_mail_messages_search  ON mail.messages USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS mail.attachments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES mail.messages(id) ON DELETE CASCADE,
    filename   text NOT NULL,
    content_type text,
    size_bytes bigint NOT NULL DEFAULT 0,
    sha256     text,
    blob_key   text,
    scan_status text NOT NULL DEFAULT 'pending'
                CHECK (scan_status IN ('pending','clean','infected','error'))
);
-- Dedup within a tenant only. Cross-tenant dedup answers "does another
-- organisation hold this exact file?" — a side channel, not an optimisation.
CREATE INDEX IF NOT EXISTS idx_mail_attach_dedup ON mail.attachments(tenant_id, sha256);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['folders','messages','attachments','mailbox_permissions']
    LOOP
        EXECUTE format('ALTER TABLE mail.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE mail.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON mail.%I', t);
    END LOOP;

    -- mailbox_permissions has no tenant_id of its own; scope it through the mailbox.
    EXECUTE 'CREATE POLICY tenant_isolation ON mail.mailbox_permissions
             USING (EXISTS (SELECT 1 FROM mail.mailboxes m
                             WHERE m.id = mailbox_id
                               AND m.tenant_id = current_setting(''app.tenant_id'', true)::uuid))';

    FOREACH t IN ARRAY ARRAY['folders','messages','attachments']
    LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON mail.%I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA mail TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA mail TO tatvaos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA mail TO tatvaos_app;

-- The mail edge: routing only. Postfix needs to know an address exists;
-- Dovecot needs the IMAP password. Neither needs a single message.
GRANT USAGE  ON SCHEMA mail TO tatvaos_mailedge;
GRANT SELECT ON mail.mailboxes, mail.aliases TO tatvaos_mailedge;

ALTER DEFAULT PRIVILEGES IN SCHEMA mail
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- ----------------------------------------------------------------------------
-- Standard folders for every new mailbox
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mail.create_default_folders() RETURNS trigger AS $$
BEGIN
    INSERT INTO mail.folders (tenant_id, mailbox_id, name, special_use)
    VALUES (NEW.tenant_id, NEW.id, 'INBOX',  '\Inbox'),
           (NEW.tenant_id, NEW.id, 'Sent',   '\Sent'),
           (NEW.tenant_id, NEW.id, 'Drafts', '\Drafts'),
           (NEW.tenant_id, NEW.id, 'Junk',   '\Junk'),
           (NEW.tenant_id, NEW.id, 'Trash',  '\Trash');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mail_default_folders ON mail.mailboxes;
CREATE TRIGGER trg_mail_default_folders
    AFTER INSERT ON mail.mailboxes
    FOR EACH ROW EXECUTE FUNCTION mail.create_default_folders();

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  TatvaOS Mail schema ready — mailboxes key off core.users';
    RAISE NOTICE '';
END $$;

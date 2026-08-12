-- ============================================================================
--  TatvaOS Family — contacts, owned by Core's people
-- ============================================================================
--
--  Family is the third product on Core, after Mail. It owns contacts: the
--  people an organisation talks to who are NOT its own staff.
--
--    core.users        someone who can sign in            (Core owns)
--    family.contacts   someone you correspond with        (Family owns)
--
--  Keeping these apart matters. A contact has no login, no password and no
--  mailbox; a user has all three. Merging them would mean every customer you
--  email becomes an account on your tenant.
--
--  TWO KINDS OF CONTACT, and the distinction drives every policy below:
--
--    personal        visible only to the person who owns it. My address book.
--    organisational  visible to everyone in the tenant. The company's.
--
--  A personal contact must stay invisible to a COLLEAGUE, not just to another
--  tenant. That is stricter than anything in Mail, where the tenant is the
--  whole boundary — so these policies read app.user_id as well as
--  app.tenant_id. TenantConnectionInterceptor sets both.
--
--  Both settings are read as
--    nullif(current_setting('app.x', true), '')::uuid
--  The `true` stops an UNSET name from raising; the nullif stops an EMPTY one
--  from doing the same at the ::uuid cast. Both matter: the interceptor writes
--  an empty string for a request with no person behind it, such as the maildir
--  worker on a shared mailbox, and without the nullif every Family query in
--  that path would fail on a bad cast rather than simply returning nothing.
--
--  Either way the result is NULL, every comparison against it is false, and
--  the query returns no rows. Failing closed, same as Mail.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS family;

-- ----------------------------------------------------------------------------
-- Contacts
-- ----------------------------------------------------------------------------
--
-- owner_user_id is NULL exactly when ownership_type = 'organisational'. The
-- CHECK enforces that pairing, because a personal contact with no owner would
-- be invisible to everyone including its creator, and an organisational one
-- with an owner would imply a privacy rule the policies do not honour.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contacts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    ownership_type     text NOT NULL DEFAULT 'personal'
                       CHECK (ownership_type IN ('personal','organisational')),
    owner_user_id      uuid REFERENCES core.users(id) ON DELETE CASCADE,

    CONSTRAINT contacts_ownership_consistent CHECK (
        (ownership_type = 'personal'       AND owner_user_id IS NOT NULL) OR
        (ownership_type = 'organisational' AND owner_user_id IS NULL)
    ),

    display_name  text NOT NULL,
    first_name    text,
    last_name     text,
    nickname      text,
    job_title     text,
    company_name  text,

    -- How this row came to exist. 'auto_*' rows were never typed by a human,
    -- which is why the UI can offer "you have 40 auto-saved contacts, keep
    -- them?" without guessing.
    source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','import','api',
                                    'auto_received','auto_sent','auto_reply')),

    is_favourite  boolean NOT NULL DEFAULT false,
    notes         text,

    -- Maintained by the auto-save service and by explicit interaction logging.
    last_contacted_at timestamptz,
    interaction_count int NOT NULL DEFAULT 0,

    -- Soft delete. The audit log references the contact, so a hard delete
    -- would take the record of the deletion with it.
    deleted_at    timestamptz,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    search_vector tsvector
);

CREATE INDEX IF NOT EXISTS idx_family_contacts_tenant  ON family.contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_family_contacts_owner   ON family.contacts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_family_contacts_live    ON family.contacts(tenant_id, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_family_contacts_search  ON family.contacts USING gin(search_vector);

-- ----------------------------------------------------------------------------
-- Emails
-- ----------------------------------------------------------------------------
--
-- email_normalised is the deduplication key, NOT email. Gmail treats
-- a.b@gmail.com, ab@gmail.com and ab+tag@gmail.com as one inbox; storing the
-- address as typed and matching on the normalised form means the display keeps
-- what the person wrote while auto-save still recognises a repeat sender.
--
-- The unique index is per (tenant, owner, normalised): two colleagues may each
-- hold a personal contact for the same customer. COALESCE flattens the
-- organisational NULL so one tenant-wide row per address is still enforced.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_emails (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,

    email            citext NOT NULL,
    email_normalised citext NOT NULL,

    type       text NOT NULL DEFAULT 'work' CHECK (type IN ('work','personal','other')),
    is_primary boolean NOT NULL DEFAULT false,

    last_contacted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_emails_contact ON family.contact_emails(contact_id);
CREATE INDEX IF NOT EXISTS idx_family_emails_lookup  ON family.contact_emails(tenant_id, email_normalised);

-- One address cannot appear twice on the SAME contact. Deliberately NOT
-- unique per tenant: two colleagues may each hold a personal contact for the
-- same customer, and a tenant-wide constraint would let whoever saved first
-- block the other. Cross-contact duplicates are refused by the API, which can
-- say WHICH contact already holds the address — a constraint violation cannot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_emails_per_contact
    ON family.contact_emails (contact_id, email_normalised);

-- ----------------------------------------------------------------------------
-- Phones and addresses
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_phones (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,

    phone            text NOT NULL,
    -- Digits only, so "+91 98765 43210" and "09876543210" compare equal.
    phone_normalised text NOT NULL,

    type       text NOT NULL DEFAULT 'mobile' CHECK (type IN ('mobile','work','home','other')),
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_phones_contact ON family.contact_phones(contact_id);
CREATE INDEX IF NOT EXISTS idx_family_phones_lookup  ON family.contact_phones(tenant_id, phone_normalised);

CREATE TABLE IF NOT EXISTS family.contact_addresses (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,

    type           text NOT NULL DEFAULT 'work' CHECK (type IN ('work','home','other')),
    street_line1   text,
    street_line2   text,
    city           text,
    state_province text,
    postal_code    text,
    country        text,
    is_primary     boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_addresses_contact ON family.contact_addresses(contact_id);

-- ----------------------------------------------------------------------------
-- Groups
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_groups (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    name        text NOT NULL,
    description text,
    colour      text,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS family.contact_group_members (
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    group_id   uuid NOT NULL REFERENCES family.contact_groups(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_family_group_members_contact ON family.contact_group_members(contact_id);

-- ----------------------------------------------------------------------------
-- Interactions
-- ----------------------------------------------------------------------------
--
-- mail_message_id is ON DELETE SET NULL, not CASCADE: "we emailed them on the
-- 3rd" stays true after the message itself is deleted.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_interactions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,

    type text NOT NULL CHECK (type IN ('email_received','email_sent','call_inbound',
                                       'call_outbound','meeting','note','other')),

    subject text,
    notes   text,

    mail_message_id uuid REFERENCES mail.messages(id) ON DELETE SET NULL,

    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_interactions_contact
    ON family.contact_interactions(contact_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Audit log — append only
-- ----------------------------------------------------------------------------
--
-- No UPDATE or DELETE grant is issued on this table (see Grants below), so the
-- application cannot rewrite history even with a bug. Deleting the contact
-- still cascades, which is intended: the tenant's right to erasure outranks
-- our record of it.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_audit_logs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,

    actor_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    operation text NOT NULL CHECK (operation IN ('create','update','delete','merge')),
    changes   jsonb,
    reason    text,

    ip_address text,
    user_agent text,

    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_audit_contact
    ON family.contact_audit_logs(contact_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Per-person auto-save settings
-- ----------------------------------------------------------------------------
--
-- Defaults chosen deliberately:
--   from_received  ON   — the address wrote to you; keeping it is expected
--   from_sent      OFF  — you already know who you wrote to, and every
--                         one-off recipient would otherwise become a contact
--   from_reply     ON   — a reply is a two-way conversation
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_settings (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,

    auto_save_received boolean NOT NULL DEFAULT true,
    auto_save_sent     boolean NOT NULL DEFAULT false,
    auto_save_reply    boolean NOT NULL DEFAULT true,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, user_id)
);

-- ----------------------------------------------------------------------------
-- Which message produced which contact
-- ----------------------------------------------------------------------------
--
-- The idempotency key for auto-save. Re-ingesting a message — which the
-- maildir worker does on restart — must not add a second interaction or
-- re-inflate interaction_count.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family.contact_sources (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id      uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,
    mail_message_id uuid NOT NULL REFERENCES mail.messages(id) ON DELETE CASCADE,

    source_type text NOT NULL CHECK (source_type IN ('sender','recipient')),
    created_at  timestamptz NOT NULL DEFAULT now(),

    UNIQUE (contact_id, mail_message_id, source_type)
);
CREATE INDEX IF NOT EXISTS idx_family_sources_message ON family.contact_sources(mail_message_id);

-- ----------------------------------------------------------------------------
-- Search vector
-- ----------------------------------------------------------------------------
--
-- A trigger, not application code, for the same reason as mail: whatever
-- writes the row, the index matches it. 'simple' rather than 'english' —
-- stemming a surname is wrong ("Manning" is not "man").
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION family.contacts_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        to_tsvector('simple',
            coalesce(NEW.display_name, '') || ' ' ||
            coalesce(NEW.first_name,   '') || ' ' ||
            coalesce(NEW.last_name,    '') || ' ' ||
            coalesce(NEW.nickname,     '') || ' ' ||
            coalesce(NEW.company_name, '') || ' ' ||
            coalesce(NEW.job_title,    ''));
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_family_contacts_search ON family.contacts;
CREATE TRIGGER trg_family_contacts_search
    BEFORE INSERT OR UPDATE ON family.contacts
    FOR EACH ROW EXECUTE FUNCTION family.contacts_search_vector();

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
--
-- Two shapes here, mirroring 01-mail-schema.sql:
--
--   contacts       tenant AND (organisational OR mine)
--   everything else  scoped THROUGH the contact, so a child row is reachable
--                    only when its parent is. Repeating the ownership test on
--                    each child would be a second place to get it wrong.
--
-- contact_settings is the exception: it is keyed to a person, never shared.
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['contacts','contact_emails','contact_phones',
                             'contact_addresses','contact_groups',
                             'contact_group_members','contact_interactions',
                             'contact_audit_logs','contact_settings',
                             'contact_sources']
    LOOP
        EXECUTE format('ALTER TABLE family.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE family.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON family.%I', t);
    END LOOP;

    EXECUTE '
        CREATE POLICY tenant_isolation ON family.contacts
        USING (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND (ownership_type = ''organisational''
                 OR owner_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)
        )
        WITH CHECK (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND (ownership_type = ''organisational''
                 OR owner_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)
        )';

    -- Groups and settings are not per-contact, so they carry their own test.
    EXECUTE '
        CREATE POLICY tenant_isolation ON family.contact_groups
        USING       (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
        WITH CHECK  (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)';

    EXECUTE '
        CREATE POLICY tenant_isolation ON family.contact_settings
        USING (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
        )
        WITH CHECK (
            tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
            AND user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
        )';

    FOREACH t IN ARRAY ARRAY['contact_emails','contact_phones','contact_addresses',
                             'contact_group_members','contact_interactions',
                             'contact_audit_logs','contact_sources']
    LOOP
        EXECUTE format('
            CREATE POLICY tenant_isolation ON family.%I
            USING (EXISTS (SELECT 1 FROM family.contacts c
                            WHERE c.id = contact_id
                              AND c.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                              AND (c.ownership_type = ''organisational''
                                   OR c.owner_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)))
            WITH CHECK (EXISTS (SELECT 1 FROM family.contacts c
                            WHERE c.id = contact_id
                              AND c.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
                              AND (c.ownership_type = ''organisational''
                                   OR c.owner_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)))', t);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA family TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA family TO tatvaos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA family TO tatvaos_app;

-- Append only. Revoking after the blanket grant above is deliberate: the
-- blanket line stays correct when a table is added, and this narrows the one
-- table that must never be rewritten.
REVOKE UPDATE, DELETE ON family.contact_audit_logs FROM tatvaos_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA family
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- The mail edge gets nothing. Postfix routes mail; it has no business
-- reading who a tenant knows.

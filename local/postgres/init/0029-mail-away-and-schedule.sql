-- ============================================================================
--  Out-of-office replies, scheduled send, and the timezone both depend on.
--
--  Three things that need saying up front.
--
--  1. THE SCHEDULED FOLDER. A scheduled message is a message in a folder,
--     exactly as a draft is - not a table of its own. Same reasoning as
--     drafts: it already needs every field a message has, it should appear
--     and search like one, and a separate table would mean two shapes for one
--     thing plus a migration on the day it is sent.
--
--  2. THIS FILE REDEFINES mail.create_default_folders(). 01-mail-schema.sql
--     creates five folders; this replaces the function with a six-folder
--     version. Both files run on every deploy in name order, so 01 defines it
--     and 29 supersedes it, every time, deterministically. If you are reading
--     01 and wondering why new mailboxes have a Scheduled folder, this is why.
--
--  3. TIMEZONE IS PER USER because an out-of-office window is written in
--     dates. "First day: 15 August" has to start at midnight where the person
--     is, or their responder switches on mid-morning and looks broken. NULL
--     means the platform default; the API decides what that is, because a
--     default living in two places drifts.
--
--  Idempotent, like every file here: it runs on every deploy.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Where the person is
-- ----------------------------------------------------------------------------
ALTER TABLE core.users
    ADD COLUMN IF NOT EXISTS timezone text;

-- ----------------------------------------------------------------------------
--  Scheduled send
--
--  scheduled_at is the only thing that distinguishes a scheduled message from
--  a draft, so it is indexed on its own: the worker's question is "what is due
--  now", across every mailbox on the platform, and that must not be a scan of
--  every message ever stored.
-- ----------------------------------------------------------------------------
ALTER TABLE mail.messages
    ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_mail_messages_scheduled
    ON mail.messages (scheduled_at)
    WHERE scheduled_at IS NOT NULL;

-- Supersedes the five-folder version in 01-mail-schema.sql. See note 2.
CREATE OR REPLACE FUNCTION mail.create_default_folders() RETURNS trigger AS $$
BEGIN
    INSERT INTO mail.folders (tenant_id, mailbox_id, name, special_use)
    VALUES (NEW.tenant_id, NEW.id, 'INBOX',     '\Inbox'),
           (NEW.tenant_id, NEW.id, 'Sent',      '\Sent'),
           (NEW.tenant_id, NEW.id, 'Drafts',    '\Drafts'),
           (NEW.tenant_id, NEW.id, 'Scheduled', '\Scheduled'),
           (NEW.tenant_id, NEW.id, 'Junk',      '\Junk'),
           (NEW.tenant_id, NEW.id, 'Trash',     '\Trash');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every mailbox that already exists. The NOT EXISTS is what makes running
-- this on every deploy free rather than a duplicate folder per deploy.
INSERT INTO mail.folders (tenant_id, mailbox_id, name, special_use)
SELECT m.tenant_id, m.id, 'Scheduled', '\Scheduled'
FROM mail.mailboxes m
WHERE NOT EXISTS (
    SELECT 1 FROM mail.folders f
    WHERE f.mailbox_id = m.id AND f.special_use = '\Scheduled'
);

-- ----------------------------------------------------------------------------
--  Out-of-office
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail.vacation_responders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id)   ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,

    enabled    boolean NOT NULL DEFAULT false,
    -- Dates, not timestamps: the window is read against the owner's timezone
    -- at the moment a message arrives. Storing an instant here would freeze
    -- the answer to "when is midnight" at the time it was saved.
    first_day  date NOT NULL,
    last_day   date,

    subject    text NOT NULL DEFAULT '',
    body_text  text NOT NULL DEFAULT '',
    body_html  text NOT NULL DEFAULT '',

    -- The two narrowing options, both off by default. An out-of-office that
    -- answers strangers is the normal case; these exist for people who would
    -- rather not tell the whole internet they are away.
    contacts_only boolean NOT NULL DEFAULT false,
    org_only      boolean NOT NULL DEFAULT false,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (mailbox_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_vacation_tenant
    ON mail.vacation_responders(tenant_id);

-- ----------------------------------------------------------------------------
--  Who has already been told
--
--  One row per (mailbox, correspondent). This is what enforces "at most once
--  every few days per person", and it is also the only thing standing between
--  a busy mailbox and an automated reply to every message in a thread.
--
--  It is keyed on the address the reply would go TO, lowercased by the API.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail.vacation_sends (
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id)   ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    address    text NOT NULL,
    last_sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (mailbox_id, address)
);

CREATE INDEX IF NOT EXISTS idx_mail_vacation_sends_tenant
    ON mail.vacation_sends(tenant_id);

-- ----------------------------------------------------------------------------
--  RLS - the same shape as the rest of the mail schema
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['vacation_responders','vacation_sends']
    LOOP
        EXECUTE format('ALTER TABLE mail.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE mail.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON mail.%I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON mail.%I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON mail.vacation_responders TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail.vacation_sends      TO tatvaos_app;

-- Neither is granted to tatvaos_mailedge. Postfix and Dovecot route mail; they
-- do not decide who gets told somebody is on leave.

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Away replies and scheduled send ready';
    RAISE NOTICE '    - Scheduled folder created for every mailbox';
    RAISE NOTICE '    - out-of-office windows read against core.users.timezone';
    RAISE NOTICE '';
END $$;

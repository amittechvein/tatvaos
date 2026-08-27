-- ============================================================================
--  Mail categories — the colour system, owned by the person
-- ============================================================================
--
--  A category is a NAME AND A COLOUR that somebody made for themselves. It is
--  not a classification we perform on their behalf: the ruling was that the
--  user creates them and the filter rules that already run at delivery apply
--  them. "From @school.edu, mark it Work" is a sentence a person can write,
--  read back, and disagree with.
--
--  That decision is why this file is short. The rules engine in
--  mail.filter_rules stores its actions as jsonb, so applying a category is a
--  new KEY in an existing column - `{"categoryId": "..."}` - and needs no
--  change to filters at all. What is left is somewhere to keep the names and
--  a column on the message.
--
--  Idempotent - it re-runs on every deploy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.categories (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id)   ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    name       text NOT NULL,

    -- A TOKEN NAME, NOT A HEX VALUE. Storing #7367f0 here would put a literal
    -- colour in the database that no theme change can reach, and dark mode
    -- would show a swatch mixed for a white page. The nine names are the
    -- product's palette; the client maps each to whatever the current theme
    -- says it means.
    colour     text NOT NULL
               CHECK (colour IN ('purple','blue','green','orange','yellow',
                                 'red','pink','cyan','grey')),

    position   int         NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One "Work" per mailbox, whatever case it was typed in. Two categories that
-- differ only by capitalisation are the same category to the person who made
-- them, and a rule pointing at the wrong one is invisible.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mail_categories_mailbox_name
    ON mail.categories(mailbox_id, lower(name));

CREATE INDEX IF NOT EXISTS ix_mail_categories_mailbox
    ON mail.categories(mailbox_id, position);

-- ----------------------------------------------------------------------------
--  The column on the message.
--
--  ON DELETE SET NULL, emphatically. Deleting a category must lose the label
--  and never the mail. CASCADE here would mean that tidying up an unused
--  colour silently deletes every message wearing it - an irreversible action
--  triggered by a cosmetic one.
-- ----------------------------------------------------------------------------
ALTER TABLE mail.messages
    ADD COLUMN IF NOT EXISTS category_id uuid
    REFERENCES mail.categories(id) ON DELETE SET NULL;

-- Filtering a folder down to one colour is the point of having them.
CREATE INDEX IF NOT EXISTS ix_mail_messages_category
    ON mail.messages(mailbox_id, category_id)
    WHERE category_id IS NOT NULL;

-- ----------------------------------------------------------------------------
--  RLS — the same shape as every other table in this schema.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    EXECUTE 'ALTER TABLE mail.categories ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE mail.categories FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON mail.categories';
    EXECUTE 'CREATE POLICY tenant_isolation ON mail.categories '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;

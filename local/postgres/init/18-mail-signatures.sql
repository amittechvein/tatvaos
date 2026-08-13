-- ============================================================================
--  18 — Signatures
-- ============================================================================
--
--  One signature per mailbox. In its own table rather than as columns on
--  mail.mailboxes for one reason: the mail edge holds SELECT on mailboxes so
--  Postfix and Dovecot can route, and a person's signature is content, not
--  routing. Keeping it here means those roles never see it.
--
--  PER MAILBOX, NOT PER PERSON. A shared support@ should sign as Support
--  regardless of who happens to be replying; a per-person signature on a
--  shared mailbox leaks who is on shift. If per-person ever becomes a real
--  requirement it is an extra nullable user_id here plus a lookup order, not
--  a different table.
--
--  Both HTML and plain text are stored. A message goes out as
--  multipart/alternative, and a signature present in only one part means half
--  the recipients see a different message — usually the plain-text half,
--  which is also the half that gets quoted back in replies.
--
--  include_on_reply is separate from enabled because they are genuinely
--  different preferences: most people want their block on a new message but
--  not repeated down every turn of a long thread.
--
--  Idempotent — it re-runs on every deploy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.signatures (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id)   ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    body_html  text NOT NULL DEFAULT '',
    body_text  text NOT NULL DEFAULT '',
    enabled          boolean NOT NULL DEFAULT true,
    include_on_reply boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- One per mailbox. Multiple signatures is a later feature, and this is
    -- what stops the API growing a second row before that feature has decided
    -- how one of them gets chosen.
    UNIQUE (mailbox_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_signatures_tenant
    ON mail.signatures(tenant_id);

-- ----------------------------------------------------------------------------
-- RLS — the same shape as the rest of the mail schema
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    EXECUTE 'ALTER TABLE mail.signatures ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE mail.signatures FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON mail.signatures';
    EXECUTE 'CREATE POLICY tenant_isolation ON mail.signatures '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON mail.signatures TO tatvaos_app;

-- Deliberately NOT granted to tatvaos_mailedge — see the note at the top.

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Signatures ready — one per mailbox, HTML and plain text together';
    RAISE NOTICE '';
END $$;

-- ============================================================================
--  13 — Blocked senders
-- ============================================================================
--
--  "Block sender" in the reading pane. A blocked address keeps arriving — we
--  do NOT reject it at the edge — but the ingest worker files it straight
--  into Junk instead of Inbox.
--
--  WHY NOT REJECT AT SMTP: a rejection is visible to the sender, tells them
--  the address is live, and turns a personal preference into a
--  domain-reputation event. Blocking is one person's view of their own inbox,
--  so it belongs where their mail is filed, not at the front door. It also
--  means unblocking is instant and nothing was lost in between.
--
--  Per MAILBOX, not per tenant: one person blocking a recruiter must not
--  silence that sender for their whole organisation.
--
--  Idempotent, like every file here — it re-runs on each deploy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.blocked_senders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id)   ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    -- Stored lowercased by the API so matching is a plain equality test at
    -- ingest — no per-message lower() over an unindexed column.
    address    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mailbox_id, address)
);

-- The ingest worker's lookup: every blocked address for one mailbox.
CREATE INDEX IF NOT EXISTS idx_mail_blocked_mailbox
    ON mail.blocked_senders(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_mail_blocked_tenant
    ON mail.blocked_senders(tenant_id);

-- ----------------------------------------------------------------------------
-- RLS — same shape as the rest of the mail schema
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    EXECUTE 'ALTER TABLE mail.blocked_senders ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE mail.blocked_senders FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON mail.blocked_senders';
    EXECUTE 'CREATE POLICY tenant_isolation ON mail.blocked_senders '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;

-- Explicit rather than relying on ALTER DEFAULT PRIVILEGES: this table is
-- created by a later file, and a missing grant here is a 500 at block time.
GRANT SELECT, INSERT, UPDATE, DELETE ON mail.blocked_senders TO tatvaos_app;

-- Deliberately NOT granted to tatvaos_mailedge. Postfix and Dovecot route
-- mail; they must not learn who blocked whom.

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Blocked senders ready — blocked mail is filed to Junk, never refused';
    RAISE NOTICE '';
END $$;

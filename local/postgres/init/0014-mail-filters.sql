-- ============================================================================
--  14 — Filter rules
-- ============================================================================
--
--  "Filter messages like this". A rule is a set of conditions and a set of
--  actions, applied by the ingest worker as mail arrives.
--
--  WHY jsonb FOR CONDITIONS AND ACTIONS: the shape of a rule is the thing most
--  likely to grow — today it matches from/to/subject/body, tomorrow it will
--  want size, attachment type, or a header. Columns for each would mean a
--  migration per idea and a table of mostly-NULLs. The trade is that the
--  database cannot validate the shape, so the API owns that: rules are written
--  only through the endpoints, which parse into a strict contract first.
--
--  Per MAILBOX, like blocked senders — one person's filing is not their
--  organisation's.
--
--  position orders evaluation. ALL matching enabled rules apply, in position
--  order, and a later folder move wins; that matches what people expect from
--  Gmail and avoids "why did only one of my two filters run".
--
--  Idempotent — it re-runs on each deploy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.filter_rules (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id)   ON DELETE CASCADE,
    mailbox_id uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
    name       text NOT NULL,
    enabled    boolean NOT NULL DEFAULT true,
    position   int     NOT NULL DEFAULT 0,
    -- true  = every condition must match (AND)
    -- false = any condition may match (OR)
    match_all  boolean NOT NULL DEFAULT true,
    -- [{ "field": "from|to|subject|body", "op": "contains|equals", "value": "…" }]
    conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- { "moveToFolderId": uuid|null, "markRead": bool, "flag": bool }
    actions    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The ingest worker's lookup: enabled rules for one mailbox, in order.
CREATE INDEX IF NOT EXISTS idx_mail_filters_mailbox
    ON mail.filter_rules(mailbox_id, position);
CREATE INDEX IF NOT EXISTS idx_mail_filters_tenant
    ON mail.filter_rules(tenant_id);

-- ----------------------------------------------------------------------------
-- RLS — same shape as the rest of the mail schema
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    EXECUTE 'ALTER TABLE mail.filter_rules ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE mail.filter_rules FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON mail.filter_rules';
    EXECUTE 'CREATE POLICY tenant_isolation ON mail.filter_rules '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON mail.filter_rules TO tatvaos_app;

-- Deliberately NOT granted to tatvaos_mailedge: routing does not read rules.

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Filter rules ready — applied at ingest, in position order';
    RAISE NOTICE '';
END $$;

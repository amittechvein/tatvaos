-- ============================================================================
--  Bounce key for the send-API delivery log.
--
--  The send endpoint writes one mail.api_sends row per recipient with an
--  outcome of 'accepted' (Postfix took custody) or 'refused' (it did not).
--  Neither says whether the RECEIVING server later accepted it — a bounce
--  arrives minutes to days afterwards, out of band, and is the only signal
--  we can honestly record about arrival.
--
--  HOW A BOUNCE FINDS ITS ROW — the "bounce key".
--  Every API message leaves with a per-recipient VERP envelope sender:
--        bounce+<api_sends.id>.<hmac>@tatvaos.com
--  The row id IS the key — it is this table's primary key, so a returning
--  DSN carries the exact row in its own To: address, and correlation is a
--  lookup, not a parse of the bounce body. The <hmac> is a short signature
--  over the id with a server secret; it is COMPUTED and checked, never
--  stored, so junk to bounce+garbage@ is rejected before any query. No new
--  token column is needed here for that reason.
--
--  outcome is deliberately NOT changed. It records the send-time fact and a
--  bounce is a different, later fact; a row is "bounced" precisely when
--  bounced_at IS NOT NULL. Adding a 'bounced' outcome value would have made
--  outcome sometimes mean send-time and sometimes mean arrival.
--
--  Idempotent on purpose (ADD COLUMN IF NOT EXISTS, guarded CHECK, index IF
--  NOT EXISTS): the whole init/ directory re-runs on every deploy and must
--  change nothing the second time. (Cost paid on 3 Sept, when a non-guarded
--  migration blocked every deploy after the first.)
-- ============================================================================

ALTER TABLE mail.api_sends
    ADD COLUMN IF NOT EXISTS bounced_at    timestamptz,
    ADD COLUMN IF NOT EXISTS bounce_type   text,
    ADD COLUMN IF NOT EXISTS bounce_reason text;

-- 'hard' — permanent (no such mailbox, domain refused): suppress the address.
-- 'soft' — transient (mailbox full, greylisted): recorded, not suppressed.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'api_sends_bounce_type_ck'
    ) THEN
        ALTER TABLE mail.api_sends
            ADD CONSTRAINT api_sends_bounce_type_ck
            CHECK (bounce_type IS NULL OR bounce_type IN ('hard','soft'));
    END IF;
END $$;

-- Find a tenant's bounces, newest first — the query the admin bounce screen
-- and the suppression job both run. Partial: only bounced rows are indexed.
CREATE INDEX IF NOT EXISTS ix_api_sends_bounced
    ON mail.api_sends (tenant_id, bounced_at DESC)
    WHERE bounced_at IS NOT NULL;

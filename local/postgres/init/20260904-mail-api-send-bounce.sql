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
--  Every API message leaves with a per-recipient VERP envelope sender on a
--  DEDICATED BOUNCE SUBDOMAIN:
--        <api_sends.id>.<keyid>.<hmac>@bounces.tatvaos.com
--  · The row id IS the correlation key — it is this table's primary key, so
--    a returning DSN carries the exact row in its own To: address and
--    correlation is a lookup, not a parse of the bounce body. No token
--    column is needed here for that reason.
--  · <hmac> is a short signature over the id with a server secret, COMPUTED
--    and checked, never stored, so junk to a random address is rejected
--    before any query.
--  · <keyid> names WHICH secret signed it, so the secret can rotate without
--    silently invalidating bounces already in flight (DSNs arrive days
--    later): old keyids stay verifiable for the bounce window. Committing to
--    a never-rotating secret was the alternative and is the more fragile one.
--
--  WHY A SUBDOMAIN, NOT `bounce+…@tatvaos.com`. On this box recipient_delimiter
--  is unset and virtual-aliases.cf matches addresses exactly, so a `+`
--  extension resolves to nothing and the bounce itself bounces (proven by
--  trace). Setting recipient_delimiter would fix that but GLOBALLY — it would
--  change how every tenant's `name+tag@` address resolves, blast radius across
--  the whole platform. A dedicated subdomain with a catch-all transport has
--  ZERO effect on any existing address and is the provider-standard pattern
--  (SES/Mailgun do the same). The routing itself — MX + SPF for the subdomain
--  and a transport routing it to the bounce intake — is a Postfix change in a
--  separate PR; this migration is only the schema it writes into.
--
--  outcome is deliberately NOT changed. It records the send-time fact and a
--  bounce is a different, later fact; a row is "bounced" precisely when
--  bounced_at IS NOT NULL. Adding a 'bounced' outcome value would have made
--  one column mean send-time on some rows and arrival on others.
--
--  Idempotent on purpose: the whole init/ directory re-runs on every deploy
--  and must change nothing the second time. (Cost paid 3 Sept, when a
--  non-guarded migration blocked every deploy after the first.)
-- ============================================================================

ALTER TABLE mail.api_sends
    ADD COLUMN IF NOT EXISTS bounced_at    timestamptz,
    ADD COLUMN IF NOT EXISTS bounce_type   text,
    -- PERSONAL DATA: this carries the recipient address and the receiving
    -- server's DSN diagnostic text verbatim. It is a log of who we mailed and
    -- what came back, not machine noise — retained under the keep-everything
    -- retention ruling, and named here so nobody later treats it as scratch.
    ADD COLUMN IF NOT EXISTS bounce_reason text;

-- 'hard' — permanent (no such mailbox, domain refused): suppress the address.
-- 'soft' — transient (mailbox full, greylisted): recorded, not suppressed.
--
-- DROP-then-ADD rather than a name-keyed IF NOT EXISTS guard: keying on the
-- constraint NAME cannot tell "absent" from "present but wrong", so a later
-- edit to the predicate would be silently skipped on production while the
-- deploy reported success (the exact shape Connect diagnosed on
-- check_active_keys_have_addresses, 4 Sept). Drop-and-re-add always lands the
-- current predicate. Harmless while the constraint is new; the point is not to
-- leave the wrong shape in the tree to be copied next time.
ALTER TABLE mail.api_sends DROP CONSTRAINT IF EXISTS api_sends_bounce_type_ck;
ALTER TABLE mail.api_sends
    ADD CONSTRAINT api_sends_bounce_type_ck
    CHECK (bounce_type IS NULL OR bounce_type IN ('hard','soft'));

-- Find a tenant's bounces, newest first — the query the admin bounce screen
-- and the suppression job both run. Partial: only bounced rows are indexed.
CREATE INDEX IF NOT EXISTS ix_api_sends_bounced
    ON mail.api_sends (tenant_id, bounced_at DESC)
    WHERE bounced_at IS NOT NULL;

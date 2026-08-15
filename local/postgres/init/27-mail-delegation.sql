-- ============================================================================
--  Shared mailboxes: who sent it, and who may act on it.
--
--  mail.mailbox_permissions has existed since 01-mail-schema.sql and has never
--  been used. This file adds the one column that was missing to make it
--  usable, and an index for the question the client asks on every page load.
--
--  Idempotent, like every file here: it runs on every deploy, so it must be
--  safe to run on every deploy.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Which human pressed send.
--
--  Mail from a shared mailbox goes out AS the mailbox - admissions@ replies as
--  admissions@, so the answer comes back to the queue rather than to whoever
--  happened to be on shift. That is the point of a shared mailbox, and it is
--  why the person is not in any header the recipient sees.
--
--  But "who actually sent this" must still be answerable, so it is recorded
--  here and audited in core.audit_logs with product_code 'mail'.
--
--  NULL for everything that already exists, and NULL forever for inbound mail:
--  nobody at this organisation sent the message that arrived.
-- ----------------------------------------------------------------------------
ALTER TABLE mail.messages
    ADD COLUMN IF NOT EXISTS sent_by_user_id uuid REFERENCES core.users(id);

-- ----------------------------------------------------------------------------
--  "Which mailboxes may I open?" is asked by every client on every page load,
--  and the primary key on (mailbox_id, user_id, permission) answers the other
--  direction. Without this it is a sequential scan of the whole grant table
--  per session.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_mailbox_permissions_user
    ON mail.mailbox_permissions (user_id);

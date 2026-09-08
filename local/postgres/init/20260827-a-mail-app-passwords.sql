-- ============================================================================
--  Mail — app passwords, so a third-party client never holds a real one.
--  Built for the first external SMTP/IMAP customer, 28 August 2026.
-- ============================================================================
--
--  SUPERSEDED IN PART — see 20260912-mail-app-passwords-unique.sql. The
--  reasoning below about LIMIT 1 enforcing one-active-per-mailbox is WRONG;
--  it concealed violations rather than preventing them. The index created
--  here is non-unique and is dropped by that file. last_used_at is dropped
--  there too: nothing could ever write it.
--
--  A person's TatvaOS password opens their mail, their files, their meetings
--  and their organisation's console. The moment it gets typed into a
--  third-party mail client it is stored by software we do not control, on a
--  machine we have never seen. An app password is the answer everywhere:
--  a separate machine-generated secret that opens ONLY SMTP/IMAP, shown
--  once, revocable without touching anything else the person can reach.
--
--  ONE ACTIVE PER MAILBOX — a Dovecot constraint worn honestly: an SQL
--  passdb verifies exactly one returned row, so several named app passwords
--  need a Lua auth hook that does not exist yet. The API revokes the old on
--  generating the new; dovecot-sql-app.conf.ext's LIMIT 1 makes the
--  database agree even if the API ever forgets.
--
--  ROWS ARE REVOKED, NEVER DELETED. "When was a credential issued and when
--  did it stop working" is exactly the question an incident asks, and a
--  deleted row answers it with a shrug.
--
--  This file carries its REAL date. It touches only mail.mailboxes (0001),
--  so it is immune to the September-named sequence problem documented in
--  20260911-connect-captions.sql.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mail.app_passwords (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id    uuid NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,

    -- What the person called it ("Office laptop Thunderbird"). Display only;
    -- never part of authentication.
    label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),

    -- Carries its own {SCHEME} prefix ({SSHA512} from the API). The scheme
    -- travels WITH the hash because the one store that relied on a default
    -- scheme verified every hash against the wrong algorithm for weeks.
    password_hash text NOT NULL,

    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    -- Set by the API on generate-replacing and on explicit revoke; never by
    -- a sweep. An app password has no expiry: phones keep credentials for
    -- years, and silent expiry reads as "mail broke".
    last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS ix_app_passwords_mailbox
    ON mail.app_passwords (mailbox_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE mail.app_passwords IS
    'Per-mailbox app passwords for third-party SMTP/IMAP clients. One active '
    'per mailbox (Dovecot SQL passdb verifies a single row); generating a new '
    'one revokes the previous. Hashes carry their own {SCHEME} prefix.';

-- The mail edge reads it during authentication; the app manages it.
GRANT SELECT ON mail.app_passwords TO tatvaos_mailedge;
GRANT SELECT, INSERT, UPDATE ON mail.app_passwords TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  RLS, the mail-schema way: scoped through the mailbox's tenant.
-- ----------------------------------------------------------------------------
ALTER TABLE mail.app_passwords ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail.app_passwords FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mail.app_passwords;
CREATE POLICY tenant_isolation ON mail.app_passwords
    USING (EXISTS (SELECT 1 FROM mail.mailboxes m
                    WHERE m.id = mailbox_id
                      AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

-- The mail edge authenticates BEFORE any tenant is known. The primary store
-- solves this by mail.mailboxes carrying NO RLS at all (checked: it is
-- absent from 0001's RLS array — routing data, not content). This table gets
-- the stricter arrangement: RLS ON for the app, plus an explicit SELECT-only
-- allowance for the NOBYPASSRLS mailedge role — auth can read every hash,
-- and the app still cannot cross tenants.
DROP POLICY IF EXISTS mailedge_auth ON mail.app_passwords;
CREATE POLICY mailedge_auth ON mail.app_passwords
    FOR SELECT TO tatvaos_mailedge USING (true);

DO $$
BEGIN
    RAISE NOTICE 'mail.app_passwords — one active per mailbox, revoke-not-delete.';
END $$;

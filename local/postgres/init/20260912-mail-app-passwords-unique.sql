-- ============================================================================
--  Mail — make "one active app password per mailbox" a mechanism.
--  Amends 20260828-mail-app-passwords.sql.
-- ============================================================================
--
--  WHAT WAS WRONG. That file asserted the invariant in three places and
--  enforced it in none: a table comment, an API that revokes before it
--  issues, and `ORDER BY created_at DESC LIMIT 1` in the Dovecot passdb
--  query. The index it created was NOT unique.
--
--  The LIMIT does not make the database agree with the API. It CONCEALS a
--  disagreement — and because rows here are revoked and never deleted, the
--  concealment is permanent. Two rows with revoked_at IS NULL is a state
--  nothing rejects, nothing reports, and the auth query silently hides. The
--  day that ORDER BY changes, or the Lua hook for several named passwords
--  arrives, every hidden row becomes a live credential nobody remembers
--  issuing — and "when was this credential issued and when did it stop
--  working" becomes unanswerable in exactly the incident that asks it.
--
--  THE INDEX NAME CHANGES ON PURPOSE. ix_app_passwords_mailbox already
--  exists as a non-unique index. CREATE UNIQUE INDEX IF NOT EXISTS under the
--  SAME name would find a name and skip, leaving nothing enforced while the
--  file read as though something were. Different name, old one dropped.
--
--  DATED AFTER 20260828 ON PURPOSE. These files apply in FILENAME order on
--  every deploy, including into an empty database. A file dated before the
--  one it amends would try to alter a table that does not exist yet.
--
--  Idempotent: re-running drops nothing new, revokes nothing new, and finds
--  the index already there.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1. Reconcile any duplicates BEFORE the index refuses them.
--
--  Keeps the newest active row per mailbox and revokes the rest — the same
--  row the Dovecot query has been serving all along (ORDER BY created_at
--  DESC), so no client's working credential changes. (created_at, id) rather
--  than created_at alone: two rows written in one transaction share a
--  timestamp, and a tie would leave two survivors and fail step 3.
--
--  revoked_at = now(), not a sentinel: these credentials genuinely stopped
--  working the moment the newer one was issued. The row still records it.
-- ----------------------------------------------------------------------------
UPDATE mail.app_passwords a
   SET revoked_at = now()
 WHERE a.revoked_at IS NULL
   AND EXISTS (
        SELECT 1
          FROM mail.app_passwords b
         WHERE b.mailbox_id = a.mailbox_id
           AND b.revoked_at IS NULL
           AND (b.created_at, b.id) > (a.created_at, a.id)
   );

-- ----------------------------------------------------------------------------
--  2. The old, non-unique index is superseded, not kept alongside.
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS mail.ix_app_passwords_mailbox;

-- ----------------------------------------------------------------------------
--  3. The mechanism.
--
--  Partial: revoked rows are the audit trail and there may be any number of
--  them per mailbox. Only the live ones are constrained.
--
--  Note for anyone touching the API: a partial unique index CANNOT be made
--  DEFERRABLE — it is not a constraint. So a revoke-then-issue must send the
--  UPDATE before the INSERT, and MailAppPasswordEndpoints.GenerateAsync now
--  does that in an explicit transaction rather than leaving the order to
--  EF's batch preparer.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ix_app_passwords_mailbox_active
    ON mail.app_passwords (mailbox_id) WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
--  4. last_used_at goes.
--
--  Three readers, zero writers. Only Dovecot sees a successful IMAP or SMTP
--  authentication; its passdb query is SELECT-only, and tatvaos_mailedge
--  holds GRANT SELECT alone — so nothing could write this column even if
--  someone added the statement. It was NULL for every row and always would
--  have been, and the settings page rendered that as "never used yet".
--
--  That is not a cosmetic problem. A person deciding whether to revoke a
--  credential reads "never used" as evidence that nothing depends on it.
--  "Never recorded" is the truth and points the opposite way. A field that
--  reliably misleads at the moment of a security decision is worse than an
--  absent one.
--
--  Recording real usage would mean granting UPDATE to the role that sits on
--  the authentication path. That is privilege expansion on our most exposed
--  surface to power a nice-to-have, and if it comes back it comes back as
--  its own decision with that trade-off named.
-- ----------------------------------------------------------------------------
ALTER TABLE mail.app_passwords DROP COLUMN IF EXISTS last_used_at;

COMMENT ON TABLE mail.app_passwords IS
    'Per-mailbox app passwords for third-party SMTP/IMAP clients. Exactly one '
    'active per mailbox, ENFORCED by ix_app_passwords_mailbox_active (partial '
    'unique, WHERE revoked_at IS NULL) - not by the API and not by the LIMIT 1 '
    'in the Dovecot passdb query. Revoked rows are kept as the audit trail. '
    'Hashes carry their own {SCHEME} prefix.';

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM (
        SELECT mailbox_id FROM mail.app_passwords
         WHERE revoked_at IS NULL GROUP BY mailbox_id HAVING count(*) > 1) d;
    IF n > 0 THEN
        RAISE EXCEPTION 'mail.app_passwords still has % mailbox(es) with more than one active password', n;
    END IF;
    RAISE NOTICE 'mail.app_passwords - one active per mailbox is now enforced by the database.';
END $$;

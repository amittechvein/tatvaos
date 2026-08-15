-- ============================================================================
--  A shared mailbox's public name.
--
--  Mail from a shared mailbox goes out AS the mailbox, which meant the From
--  name was the local part: "admissions <admissions@school.in>". Recipients
--  read the From name, and "admissions" is the address twice rather than a
--  name — "Admissions Office" is what a school would put on a letter.
--
--  NULL everywhere else, and NULL is the honest default: a personal mailbox
--  already has a name, on the person.
--
--  Migration 29 is reserved for the Space lane (file_activity + stars); this
--  is 30 by agreement, not by accident.
-- ============================================================================

ALTER TABLE mail.mailboxes
    ADD COLUMN IF NOT EXISTS display_name text;

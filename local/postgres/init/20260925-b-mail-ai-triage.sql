-- ============================================================================
--  Mail — TatvaOS AI sorts incoming mail (step 3 of 3). Default OFF.
--  Amit, 25 September 2026: "start step 3".
-- ============================================================================
--
--  THE STEP WHERE MAIL LEAVES WITH NOBODY CLICKING. Help me write sends what
--  a person typed when they ask; suggested replies send a message when it is
--  opened. Sorting sends every NEW inbox message, in the background. So it is
--  consent of its own, on top of allow_ai and allow_mail_ai:
--
--    mail_ai_triage_since   NULL = off. When set, the moment an administrator
--                           switched it on — and the worker sorts only mail
--                           that ARRIVED after it. Turning it on never sends
--                           the organisation's existing mail.
--
--  THE LABELS ARE NOT CATEGORIES. mail.categories are "a name and a colour
--  somebody made for themselves… nothing in this file infers anything"
--  (MailCategoryEndpoints). An AI guess written into category_id would break
--  that ruling, so the guess lives in its own two columns, is shown with the
--  AI mark, and is wiped when sorting is turned off:
--
--    ai_label        one of four fixed words, CHECKed
--    ai_labelled_at  when the worker claimed it (also the "done" marker —
--                    a message with a time and no label was looked at and
--                    deliberately left unlabelled, e.g. mail you sent)
--
--  Additive only. ADD COLUMN with no default is a catalogue change; the CHECK
--  on an all-NULL new column scans once and passes. Re-runs are no-ops.
-- ============================================================================

ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS mail_ai_triage_since timestamptz;

COMMENT ON COLUMN core.tenants.mail_ai_triage_since IS
    'TatvaOS AI sorts incoming inbox mail for this organisation since this '
    'moment; NULL = off. Needs allow_ai and allow_mail_ai too. Only mail that '
    'arrived after it is ever sent. Enforced in the AI gateway on the '
    '"mail.triage" label.';

ALTER TABLE mail.messages
    ADD COLUMN IF NOT EXISTS ai_label text
        CONSTRAINT messages_ai_label_check
        CHECK (ai_label IN ('needs_reply', 'fyi', 'updates', 'promotions'));

ALTER TABLE mail.messages
    ADD COLUMN IF NOT EXISTS ai_labelled_at timestamptz;

COMMENT ON COLUMN mail.messages.ai_label IS
    'TatvaOS AI''s guess at what kind of mail this is (needs_reply, fyi, '
    'updates, promotions). NOT a category: categories are made by people. '
    'Cleared when the organisation turns sorting off.';

DO $$
DECLARE on_count integer;
BEGIN
    SELECT count(*) INTO on_count FROM core.tenants WHERE mail_ai_triage_since IS NOT NULL;
    RAISE NOTICE 'Mail AI sorting: per organisation, default OFF. % organisation(s) on.', on_count;
END $$;

-- ============================================================================
--  Mail — each TatvaOS AI feature in Mail has its own on/off switch.
--  Amit, 26 September 2026: "in /org/ai give option inside mail ai turn on
--  and off … so client able to save tokens".
-- ============================================================================
--
--  allow_mail_ai stays the organisation's consent to Mail AI at all. Inside
--  it, an administrator can now turn each feature off to spend less:
--
--    mail_ai_rewrite   Help me write           DEFAULT true
--    mail_ai_suggest   Suggested replies       DEFAULT true
--    mail_ai_summary   Summarise conversation  DEFAULT false
--    (sorting keeps its own switch, mail_ai_triage_since, 25 Sept)
--
--  WHY THE DEFAULTS DIFFER. Help me write and suggested replies existed when
--  an organisation said yes to Mail AI, so they stay on — switching Mail AI
--  on meant them. Summarise is new: it sends a whole conversation, which no
--  earlier yes covered. Mr. Singh, 25 Sept: "nobody's yes gets stretched to
--  cover something they weren't told about." So it starts OFF everywhere,
--  Techvein included, and an administrator turns it on knowingly.
--
--  Enforced in the AI gateway on each feature's label (AiProductSwitch).
--  core.tenants is a handful of rows; a constant DEFAULT is a catalogue
--  change. Additive; re-runs are no-ops.
-- ============================================================================

ALTER TABLE core.tenants ADD COLUMN IF NOT EXISTS mail_ai_rewrite boolean NOT NULL DEFAULT true;
ALTER TABLE core.tenants ADD COLUMN IF NOT EXISTS mail_ai_suggest boolean NOT NULL DEFAULT true;
ALTER TABLE core.tenants ADD COLUMN IF NOT EXISTS mail_ai_summary boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.tenants.mail_ai_rewrite IS
    'Help me write, inside Mail AI (allow_mail_ai). Default on: it existed when Mail AI was agreed to.';
COMMENT ON COLUMN core.tenants.mail_ai_suggest IS
    'Suggested replies, inside Mail AI (allow_mail_ai). Default on: it existed when Mail AI was agreed to.';
COMMENT ON COLUMN core.tenants.mail_ai_summary IS
    'Summarise conversation, inside Mail AI (allow_mail_ai). Default OFF: it sends a whole conversation, '
    'which no earlier consent covered.';

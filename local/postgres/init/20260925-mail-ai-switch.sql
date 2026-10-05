-- ============================================================================
--  Mail — TatvaOS AI in Mail has its OWN switch, default OFF.
--  Amit, 25 September 2026: "Mail ai on/off switch".
-- ============================================================================
--
--  core.tenants.allow_ai is the organisation's consent to send content to the
--  AI provider AT ALL. Until today the only thing that sent anything was
--  Connect's meeting minutes, so one switch meant one thing.
--
--  Mail changes that. A school may be content for meeting notes to be written
--  by AI and still not want a single email body to leave the building — and
--  the Translate button was deliberately kept on our own server for exactly
--  that reason (TranslateService: "a child's medical letter"). One switch
--  would force them to choose between both or neither.
--
--  So Mail AI needs BOTH:
--    allow_ai       — the organisation consents to the provider   (existing)
--    allow_mail_ai  — and to Mail using it                          (this)
--
--  ENFORCED IN THE GATEWAY (MeteredAiGateway, AiProductSwitch), keyed by the
--  feature label every request must carry since PR 280: anything labelled
--  "mail.*" is refused, unsent and unmetered, while this is false. The same
--  reasoning as allow_ai: a caller who has to remember the check will forget.
--
--  Idempotent and additive; re-runs on every deploy. Deliberately NO UPDATE —
--  a blanket enable would re-enable an organisation that switched it off.
-- ============================================================================

ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS allow_mail_ai boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.tenants.allow_mail_ai IS
    'Whether TatvaOS AI may be used in Mail for this organisation (Help me '
    'write, and later suggested replies and triage). Needs allow_ai as well. '
    'Default false. Enforced inside the AI gateway on the "mail." feature '
    'label, fail-closed.';

DO $$
DECLARE enabled_count integer;
BEGIN
    SELECT count(*) INTO enabled_count FROM core.tenants WHERE allow_mail_ai;
    RAISE NOTICE 'core.tenants.allow_mail_ai: Mail AI, per organisation, default OFF.';
    RAISE NOTICE '  % organisation(s) currently have Mail AI on.', enabled_count;
END $$;

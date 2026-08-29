-- ============================================================================
--  Core — AI is a per-organisation decision, default OFF.
--  Amit's ruling, 27 August 2026, on Mail's finding.
-- ============================================================================
--
--  THE GAP MAIL FOUND: the AI gateway is well built — one key, one path,
--  tokens counted, content never logged — and it is DEPLOYMENT-WIDE. The
--  moment a key exists, ANY organisation's content can reach OpenAI, without
--  that organisation having agreed, and nothing distinguishes their spend.
--  For a hospital that is not a footnote; it is the conversation that ends
--  the deal. The Azure-India story this platform tells is only honest if
--  consent is per-organisation from the start.
--
--  Same shape as allow_connect_recording, for the same reason it defaults
--  false there: sending an organisation's content to a third party is a
--  decision an organisation makes once, knowingly — not something that
--  happens because the platform deployed on a Tuesday.
--
--  ENFORCED IN THE GATEWAY, not in callers. A caller who has to remember a
--  consent check is a caller who will forget it; OpenAiGateway refuses for a
--  tenant whose flag is off (and for NO tenant at all), so forgetting is not
--  possible. The refusal is a sentence, and features degrade exactly as they
--  do when no key is configured.
--
--  NOTE ON THE FILENAME: 20260823 in August — sorts after Connect's
--  September-named sequence. See 20260823-connect-captions.sql for the full
--  account; the real fix is still Connect's renames.
--
--  Idempotent and additive, like every migration here.
-- ============================================================================

ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS allow_ai boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.tenants.allow_ai IS
    'Whether this organisation''s content may be sent to the configured AI '
    'provider (meeting minutes, mail summaries — everything on IAiGateway). '
    'Default false: consent is per-organisation, decided knowingly, never '
    'assumed from deployment. Enforced inside the gateway, fail-closed.';

-- Deliberately NO UPDATE here — this file re-runs on every deploy, and a
-- blanket enable would keep re-enabling an organisation somebody switched
-- off. Same restraint, same reasoning, as the retention-default migration.
DO $$
DECLARE enabled_count integer;
BEGIN
    SELECT count(*) INTO enabled_count FROM core.tenants WHERE allow_ai;
    RAISE NOTICE 'core.tenants.allow_ai: per-organisation AI consent, default OFF.';
    RAISE NOTICE '  % organisation(s) currently enabled.', enabled_count;
    IF enabled_count = 0 THEN
        RAISE NOTICE '  NOTHING can reach the AI provider until one is enabled by hand:';
        RAISE NOTICE '    UPDATE core.tenants SET allow_ai = true WHERE id = ''<tenant-id>'';';
        RAISE NOTICE '  (Techvein''s own tenant first, or Connect minutes stop being written by model.)';
    END IF;
END $$;

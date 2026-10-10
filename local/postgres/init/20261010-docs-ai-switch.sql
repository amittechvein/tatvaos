-- ============================================================================
--  Docs — TatvaOS AI in Docs has its OWN switch, default OFF.
--  #406 (found 7 Oct 2026), built 10 Oct 2026. Exactly like allow_mail_ai
--  (20260925-mail-ai-switch.sql).
-- ============================================================================
--
--  The approved sentence AiDisclosure.DocsWhoDecides tells an administrator:
--  "Docs AI is off by default. Only your organisation's administrator can
--  turn it on, and they can turn it off again at any time." Until this,
--  Docs AI was governed by allow_ai alone — the switch that sends MEETING
--  TRANSCRIPTS for minutes. So an organisation with minutes on would have
--  had Docs AI the moment it joined ai.docs.organisations, without its
--  administrator choosing it, and could not turn Docs AI off without losing
--  minutes. Nothing was exposed: the list was empty.
--
--  So Docs AI needs BOTH:
--    allow_ai       — the organisation consents to the provider   (existing)
--    allow_docs_ai  — and to Docs using it                          (this)
--
--  ENFORCED IN THE GATEWAY (MeteredAiGateway, AiProductSwitch.DocsAllowedAsync)
--  on every "docs.*" feature label, fail-closed, unsent and unmetered while
--  false. Turned on only by an organisation administrator, only once the
--  organisation is on ai.docs.organisations, and audited (OrgAiEndpoints).
--
--  Idempotent and additive; re-runs on every deploy. Deliberately NO UPDATE —
--  a blanket enable would switch it on for organisations that never chose it.
-- ============================================================================

ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS allow_docs_ai boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.tenants.allow_docs_ai IS
    'Whether TatvaOS AI may be used in Docs for this organisation (Summarise, '
    'rewrite, Translate, Write). Needs allow_ai as well. Default false. Enforced '
    'inside the AI gateway on the "docs." feature label, fail-closed.';

-- The personal house has no organisation-level AI (20260926-zz-personal-
-- isolation.sql, constraint tenants_house_no_org_ai). That constraint is
-- added once and never rebuilt, so Docs gets its OWN, beside it: additive,
-- nothing existing changed. Reset first, so the constraint can be added.
UPDATE core.tenants SET allow_docs_ai = false
 WHERE kind = 'personal_house' AND allow_docs_ai;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'tenants_house_no_docs_ai' AND conrelid = 'core.tenants'::regclass) THEN
        ALTER TABLE core.tenants ADD CONSTRAINT tenants_house_no_docs_ai
            CHECK (kind <> 'personal_house' OR NOT allow_docs_ai);
    END IF;
END $$;

-- The plan catalogue's entry, beside mail.ai (20260926-plan-features.sql;
-- product 'drive': a document is a Space file). Added here, after that file
-- has created core.features; DO NOTHING keeps a re-run from touching an edit.
INSERT INTO core.features (code, product_code, name, description, kind, unit, sort_order) VALUES
  ('docs.ai', 'drive', 'Docs AI', 'Summarise, improve, translate and write in documents', 'switch', NULL, 20)
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE enabled_count integer;
BEGIN
    SELECT count(*) INTO enabled_count FROM core.tenants WHERE allow_docs_ai;
    RAISE NOTICE 'core.tenants.allow_docs_ai: Docs AI, per organisation, default OFF.';
    RAISE NOTICE '  % organisation(s) currently have Docs AI on.', enabled_count;
END $$;

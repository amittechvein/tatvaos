-- ============================================================================
--  Features inside modules, plans built from them, and per-client exceptions.
--
--  Amit, 26 Sept 2026: "add features like AI, and modules client-wise, and
--  modules inside features, so I can make better plans". Decided with him the
--  same day:
--    * the catalogue below (module -> features; AI is platform-wide)
--    * EXISTING CUSTOMERS KEEP EVERYTHING
--    * at a limit, WARN FIRST — nothing in this file, or in the code that
--      reads it, stops anybody doing anything
--
--  Same shape as the product-level design (20260910-entitlement-overrides):
--  entitlement is DERIVED — plan features, plus grants, minus revokes — never
--  copied into per-organisation rows (rule 10). A feature's own switch that
--  the organisation flips (core.tenants.allow_mail_ai and friends) is NOT
--  entitlement and stays where it is: "may they have it" is ours, "do they
--  want it on" is theirs.
--
--  Additive only. Re-runs on every deploy (README.md here), so every statement
--  is guarded, and the one data change (the legacy flag) runs exactly once.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1. The feature catalogue. Platform-wide reference data like core.products:
--     no RLS, changed by a migration, never by an operator — a list a screen
--     must agree with is served from here, not copied (see ProductsAsync).
--
--     product_code NULL = platform-wide (AI spans every module).
--     kind 'switch' = included or not; 'limit' = a number, NULL = no limit.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.features (
    code          text PRIMARY KEY,
    product_code  text REFERENCES core.products(code),
    name          text NOT NULL,
    description   text,
    kind          text NOT NULL CHECK (kind IN ('switch', 'limit')),
    unit          text,
    sort_order    int  NOT NULL DEFAULT 100
);

INSERT INTO core.features (code, product_code, name, description, kind, unit, sort_order) VALUES
  ('mail.ai',                        'mail',    'Mail AI',                   'Help me write, suggested replies and inbox sorting', 'switch', NULL, 10),
  ('mail.shared_mailboxes',          'mail',    'Shared mailboxes',          'Mailboxes like support@ that several people answer', 'switch', NULL, 20),
  ('mail.shared_mailboxes.max',      'mail',    'Shared mailboxes allowed',  'How many shared mailboxes',                          'limit',  'mailboxes', 21),
  ('mail.send_api',                  'mail',    'Send API',                  'Send mail from their own software with a key',       'switch', NULL, 30),
  ('mail.aliases',                   'mail',    'Aliases',                   'Extra addresses delivering to one mailbox',          'switch', NULL, 40),
  ('connect.recording',              'connect', 'Recording',                 'Record meetings',                                    'switch', NULL, 10),
  ('connect.ai_minutes',             'connect', 'AI minutes',                'Meeting notes written by AI',                        'switch', NULL, 20),
  ('connect.guests',                 'connect', 'Guests',                    'People outside the organisation join meetings',     'switch', NULL, 30),
  ('connect.public_recording_links', 'connect', 'Public recording links',    'Share a recording with anyone who has the link',    'switch', NULL, 40),
  ('space.public_links',             'drive',   'Public share links',        'Share a file with anyone who has the link',         'switch', NULL, 10),
  ('hire.careers_page',              'hire',    'Careers page',              'A public page listing open jobs',                    'switch', NULL, 10),
  ('ai.enabled',                     NULL,      'AI',                        'Any TatvaOS AI feature, in any module',              'switch', NULL, 10),
  ('ai.monthly_tokens',              NULL,      'AI tokens per month',       'Across the whole organisation',                      'limit',  'tokens', 20)
ON CONFLICT (code) DO UPDATE SET
  product_code = EXCLUDED.product_code, name = EXCLUDED.name,
  description = EXCLUDED.description, kind = EXCLUDED.kind,
  unit = EXCLUDED.unit, sort_order = EXCLUDED.sort_order;

GRANT SELECT ON core.features TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  2. What a plan includes, and its limits.
--
--     included_features NULL = every switch of every included product, plus
--     the platform-wide ones: exactly what a plan meant before this file, so
--     no existing plan changes meaning. An operator who ticks boxes turns it
--     into an explicit list.
-- ----------------------------------------------------------------------------
ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS included_features text[];

COMMENT ON COLUMN core.plans.included_features IS
    'Feature codes (core.features) this plan includes. NULL = every feature of '
    'the included products plus the platform-wide ones - the meaning every plan '
    'had before 20260926-plan-features.sql.';

CREATE TABLE IF NOT EXISTS core.plan_feature_limits (
    plan_id       uuid NOT NULL REFERENCES core.plans(id) ON DELETE CASCADE,
    feature_code  text NOT NULL REFERENCES core.features(code),
    limit_value   bigint NOT NULL CHECK (limit_value >= 0),
    PRIMARY KEY (plan_id, feature_code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON core.plan_feature_limits TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  3. Per-client exceptions: "give X Mail AI free for 30 days", "hold Y's
--     public links", "Z may have 20 shared mailboxes". Org-level only; the
--     same rules as core.entitlement_overrides — who and why are NOT NULL,
--     expiry is read in the query (no sweeper), one live row per feature.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.feature_overrides (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    feature_code  text NOT NULL REFERENCES core.features(code),
    mode          text NOT NULL CHECK (mode IN ('grant', 'revoke', 'limit')),
    -- Only for mode = 'limit', and required there.
    limit_value   bigint CHECK (limit_value >= 0),
    expires_at    timestamptz,
    granted_by    uuid NOT NULL,
    reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    withdrawn_at  timestamptz,
    CONSTRAINT feature_overrides_limit_shape
        CHECK ((mode = 'limit') = (limit_value IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_feature_overrides_live
    ON core.feature_overrides (tenant_id, feature_code)
    WHERE withdrawn_at IS NULL;

ALTER TABLE core.feature_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.feature_overrides FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.feature_overrides;
CREATE POLICY tenant_isolation ON core.feature_overrides
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON core.feature_overrides TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  4. Existing customers keep everything (Amit, 26 Sept).
--
--     Set ONCE, in the same transaction that adds the column. A plain UPDATE
--     here would re-run on every deploy and quietly hand "everything" to every
--     customer who signed up since the last one — the guard is the point.
--     The operator can clear it per organisation later; nothing re-sets it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    n int;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'tenants'
           AND column_name = 'keeps_everything'
    ) THEN
        ALTER TABLE core.tenants
            ADD COLUMN keeps_everything boolean NOT NULL DEFAULT false;
        UPDATE core.tenants SET keeps_everything = true;
        GET DIAGNOSTICS n = ROW_COUNT;
        RAISE NOTICE 'plan-features: % existing organisation(s) marked keeps_everything', n;
    END IF;
END $$;

COMMENT ON COLUMN core.tenants.keeps_everything IS
    'Customer from before plan features (26 Sept 2026): every feature, no plan '
    'warnings. Set once by 20260926-plan-features.sql; cleared per organisation '
    'by the operator; never set again by a migration.';

-- Report what is here, rather than assert what should be.
DO $$
DECLARE f int; kept int; explicit_plans int;
BEGIN
    SELECT count(*) INTO f FROM core.features;
    SELECT count(*) INTO kept FROM core.tenants WHERE keeps_everything;
    SELECT count(*) INTO explicit_plans FROM core.plans WHERE included_features IS NOT NULL;
    RAISE NOTICE 'plan-features: % features, % organisation(s) keep everything, % plan(s) with an explicit feature list',
        f, kept, explicit_plans;
END $$;

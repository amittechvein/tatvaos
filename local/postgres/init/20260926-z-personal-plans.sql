-- ============================================================================
--  Personal accounts, part A: a plan per PERSON, on PR 309's features model.
--  Build plan: personal-plans-build-plan.md (Mr. Singh, 26 Sept 2026) §2.
--
--  DEPENDS ON, and must sort after (the "z-" is for that, README rule 2):
--    20260926-a-personal-join.sql  core.tenants.kind, personal_accounts
--    20260926-plan-features.sql    core.features, plan_feature_limits,
--                                  plans.included_features, keeps_everything
-- ============================================================================
--
--  ONE model, not two. PR 309 made plans out of features (switch = included
--  or not, limit = a number) for organisations, WARN FIRST. Personal plans
--  are three more rows in core.plans, built from the same catalogue, with a
--  few more features added below. What differs is not the data but what is
--  done with it: EffectiveSettings reads an organisation's answer exactly as
--  PlanEntitlements does (warnings, nothing stops), and a personal account's
--  answer as HARD limits (§4, §5 — the 6th person refused, the 51st recipient
--  held). The enforcement itself is part D; this file and part A only make
--  the answer exist.
--
--  1. core.plans.audience — 'organisation' (every existing plan) or
--     'personal'. An organisation can never be put on a personal plan, and
--     the reverse; the console groups them.
--  2. The features personal plans need that the catalogue lacked (§2.3).
--     Generic codes, because an organisation plan may use them too — for an
--     organisation they are warnings, like every other limit today.
--  3. Personal Free / Basic / Premium, with the §2.3 numbers. Inserted ONCE
--     (ON CONFLICT DO NOTHING on fixed ids, and limits only where none
--     exist): the operator edits them in the console, and a re-run must never
--     put a changed number back.
--  4. core.subscriptions.user_id — a personal subscription points to the
--     person. NULL = an organisation's subscription, as every row is today.
--     No row for a person = Free, derived when asked (decision 0002: derive,
--     don't copy); a row is written only when the operator moves them.
--  5. core.ai_trials — one AI trial per phone number, EVER (D6). Keyed by the
--     same HMAC fingerprint as personal_accounts, and it outlives the
--     account (user_id SET NULL on delete), so deleting and signing up again
--     does not buy a second trial (§8).
--  6. The house never "keeps everything". 309 marked every tenant that
--     existed when its column arrived; a house created before that (local
--     seed, or an early prod setup) would otherwise bypass every personal
--     limit. Re-asserted on every run: for the house, false is the only
--     correct value.
--
--  Additive. Re-runs on every deploy; the second run changes nothing.
-- ============================================================================

-- ---- 1. Plan audience --------------------------------------------------------
ALTER TABLE core.plans ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'organisation';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'plans_audience_check' AND conrelid = 'core.plans'::regclass) THEN
        ALTER TABLE core.plans ADD CONSTRAINT plans_audience_check
            CHECK (audience IN ('organisation', 'personal'));
    END IF;
END $$;
COMMENT ON COLUMN core.plans.audience IS
    '''organisation'' or ''personal''. A personal plan is held by one person in the '
    'personal house (subscriptions.user_id) and its limits are enforced; an '
    'organisation plan is warn-first (PlanEntitlements).';

-- ---- 2. Features the personal plans need --------------------------------------
INSERT INTO core.features (code, product_code, name, description, kind, unit, sort_order) VALUES
  ('mail.daily_recipients',    'mail',    'Recipients per day',     'Sending limit per person, reset at midnight India time', 'limit', 'recipients', 50),
  ('mail.hourly_recipients',   'mail',    'Recipients per hour',    'Burst limit per person, so a stolen account cannot send a day''s limit in a minute', 'limit', 'recipients', 51),
  ('connect.max_participants', 'connect', 'People in a meeting',    'Including guests. The HOST''s plan decides', 'limit', 'people', 50),
  ('connect.max_minutes',      'connect', 'Meeting length',         'Minutes before the meeting ends. Empty = no limit', 'limit', 'minutes', 51),
  ('connect.captions',         'connect', 'Live captions',          'Captions during a meeting', 'switch', NULL, 45),
  ('connect.attendance',       'connect', 'Attendance record',      'A plain record of who joined and when, no AI', 'switch', NULL, 46),
  ('ai.trial_days',            NULL,      'AI trial length',        'Days of AI meeting minutes on a plan without them, once per phone number', 'limit', 'days', 30)
ON CONFLICT (code) DO NOTHING;

-- ---- 3. The three personal plans ---------------------------------------------
--  Numbers from §2.3. Basic/Premium sending limits are Mr. Singh's starting
--  suggestion; the hourly ones are ours (Free 20 is his example) — all
--  editable in the console. Prices NULL: nobody can buy these yet.
INSERT INTO core.plans (id, name, audience, max_users, storage_model, per_user_quota_bytes,
                        max_domains, included_products, included_features,
                        price_per_user_monthly, price_monthly) VALUES
 ('b0000000-0000-0000-0000-000000000001', 'Personal Free', 'personal', NULL, 'per_user', 1073741824, 0,
  ARRAY['mail','drive','calendar','connect'],
  ARRAY['connect.captions'], NULL, NULL),
 ('b0000000-0000-0000-0000-000000000002', 'Personal Basic', 'personal', NULL, 'per_user', 5368709120, 0,
  ARRAY['mail','drive','calendar','connect'],
  ARRAY['connect.captions','connect.attendance','space.public_links'], NULL, NULL),
 ('b0000000-0000-0000-0000-000000000003', 'Personal Premium', 'personal', NULL, 'per_user', 10737418240, 0,
  ARRAY['mail','drive','calendar','connect'],
  ARRAY['connect.captions','connect.attendance','space.public_links',
        'connect.recording','connect.ai_minutes','ai.enabled'], NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Limits: written only for a plan that has NONE yet, so an operator's edit
-- (or an operator clearing one to mean "no limit") survives every deploy.
-- Absent limit = no limit (meeting length on Basic and Premium; the trial on
-- Premium, which has AI minutes outright).
INSERT INTO core.plan_feature_limits (plan_id, feature_code, limit_value)
SELECT v.plan_id::uuid, v.code, v.value
FROM (VALUES
  ('b0000000-0000-0000-0000-000000000001', 'connect.max_participants', 5),
  ('b0000000-0000-0000-0000-000000000001', 'connect.max_minutes',      60),
  ('b0000000-0000-0000-0000-000000000001', 'mail.daily_recipients',    50),
  ('b0000000-0000-0000-0000-000000000001', 'mail.hourly_recipients',   20),
  ('b0000000-0000-0000-0000-000000000001', 'ai.trial_days',            15),
  ('b0000000-0000-0000-0000-000000000002', 'connect.max_participants', 20),
  ('b0000000-0000-0000-0000-000000000002', 'mail.daily_recipients',    300),
  ('b0000000-0000-0000-0000-000000000002', 'mail.hourly_recipients',   60),
  ('b0000000-0000-0000-0000-000000000002', 'ai.trial_days',            15),
  ('b0000000-0000-0000-0000-000000000003', 'connect.max_participants', 50),
  ('b0000000-0000-0000-0000-000000000003', 'mail.daily_recipients',    500),
  ('b0000000-0000-0000-0000-000000000003', 'mail.hourly_recipients',   100)
) AS v(plan_id, code, value)
WHERE NOT EXISTS (SELECT 1 FROM core.plan_feature_limits l WHERE l.plan_id = v.plan_id::uuid);

-- ---- 4. A subscription can belong to a person ----------------------------------
ALTER TABLE core.subscriptions
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES core.users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_core_subs_user ON core.subscriptions(user_id) WHERE user_id IS NOT NULL;
-- One live plan per person. Cancelled rows are history and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS ux_core_subs_one_live_per_user
    ON core.subscriptions(user_id)
    WHERE user_id IS NOT NULL AND status IN ('trial', 'active', 'past_due');
COMMENT ON COLUMN core.subscriptions.user_id IS
    'Set for a personal account''s plan (house tenant); NULL for an organisation''s. '
    'Every organisation-level reader filters user_id IS NULL.';

-- ---- 5. AI trials ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.ai_trials (
    phone_hash  text PRIMARY KEY,                  -- one per number, ever
    user_id     uuid REFERENCES core.users(id) ON DELETE SET NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    ends_at     timestamptz NOT NULL,
    CHECK (ends_at > started_at)
);
CREATE INDEX IF NOT EXISTS idx_core_ai_trials_user ON core.ai_trials(user_id) WHERE user_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.ai_trials TO tatvaos_app;
COMMENT ON TABLE core.ai_trials IS
    'One AI trial per phone fingerprint, ever (build plan D6, §8). Outlives the '
    'account. Started by the person''s first AI switch-on (part D).';

-- ---- 6. The house never keeps everything ----------------------------------------
UPDATE core.tenants SET keeps_everything = false
 WHERE kind = 'personal_house' AND keeps_everything;

DO $$
DECLARE plans int; on_plan int; trials int;
BEGIN
    SELECT count(*) INTO plans   FROM core.plans WHERE audience = 'personal';
    SELECT count(*) INTO on_plan FROM core.subscriptions WHERE user_id IS NOT NULL AND status <> 'cancelled';
    SELECT count(*) INTO trials  FROM core.ai_trials;
    RAISE NOTICE 'personal plans: % plan(s); % person(s) on a plan other than Free; % AI trial(s) recorded.',
        plans, on_plan, trials;
END $$;

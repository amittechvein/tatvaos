-- ============================================================================
--  Personal accounts, part B: /join signup.
--  Build plan: personal-plans-build-plan.md (Mr. Singh, 26 Sept 2026), §2.1,
--  §2.4 and §3. Part A (plans per person, the effective-settings function)
--  is NOT here — it waits on the console's plan-features model.
-- ============================================================================
--
--  1. core.tenants.kind — 'organisation' (every existing row) or
--     'personal_house'. At most ONE personal house, enforced by a partial
--     unique index, not by code that remembers to check.
--
--     Why not core.tenants.type (business/school/...)? Widening that CHECK is
--     a constraint change on a live column, and "what kind of organisation"
--     is a different question from "is this the house strangers live in".
--
--     NOTHING here creates the house. On production it has to own the domain
--     personal addresses live on, and which organisation holds tatvaos.com
--     today is a ruling for Mr. Singh, not a migration's guess. Until a house
--     exists (and personal.signup_open is on), /join answers "not open".
--     Locally, 20260926-b-personal-house-seed.sql makes one.
--
--  2. core.reserved_usernames — refused addresses, editable by the operator.
--     Removal is a soft delete (removed_at), because this file re-seeds the
--     starter list on every deploy with ON CONFLICT DO NOTHING: a hard delete
--     would be quietly undone by the next deploy.
--
--  3. core.personal_signups — the in-progress signup. It holds the phone
--     number in plain text ONLY while a code may still need sending; it is
--     nulled when the signup completes and the row is deleted a day later if
--     it never does (JoinEndpoints, on each new start — no sweeper).
--
--  4. core.personal_signup_attempts — every code sent or refused, for the
--     rate limits and abuse review. A KEYED hash of the phone number, never
--     the number (§2.4). Kept 90 days, pruned the same way.
--
--  5. core.personal_accounts — one row per personal account: the phone
--     fingerprint (UNIQUE: one personal account per number), the adult
--     declaration's time (NEVER the date of birth, §3.3), and which terms and
--     privacy versions were accepted.
--
--  No RLS on 3-5, like core.users and core.signup_drafts: signup runs before
--  any tenant exists, and the uniqueness checks are platform-wide by design.
--  personal_accounts carries tenant_id and an EF query filter, which exactly
--  TWO reads bypass (IgnoreQueryFilters), both "one personal account per
--  number" across every tenant: JoinEndpoints.StartAsync (before a code is
--  sent) and JoinEndpoints.CompleteAsync (again, just before the account is
--  created). Mr. Singh accepted this on PR 311; a third bypass needs a reason.
--
--  Additive only. Re-runs on every deploy; the second run changes nothing.
-- ============================================================================

-- ---- 1. The house tenant marker --------------------------------------------
ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'organisation';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'tenants_kind_check'
                     AND conrelid = 'core.tenants'::regclass) THEN
        ALTER TABLE core.tenants ADD CONSTRAINT tenants_kind_check
            CHECK (kind IN ('organisation', 'personal_house'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_core_tenants_one_personal_house
    ON core.tenants ((kind)) WHERE kind = 'personal_house';

COMMENT ON COLUMN core.tenants.kind IS
    '''organisation'' (default) or ''personal_house'' — the one organisation '
    'that personal accounts live in. At most one (uq_core_tenants_one_personal_house). '
    'Read through PersonalHouse in the API, never compared inline.';

-- ---- 2. Reserved usernames -------------------------------------------------
CREATE TABLE IF NOT EXISTS core.reserved_usernames (
    name        citext PRIMARY KEY,
    match       text NOT NULL DEFAULT 'exact' CHECK (match IN ('exact', 'contains')),
    category    text NOT NULL DEFAULT 'other'
                CHECK (category IN ('system', 'product', 'lookalike', 'other')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    removed_at  timestamptz,
    removed_by  uuid
);

INSERT INTO core.reserved_usernames (name, match, category) VALUES
  -- System and role names (§3.2)
  ('admin','exact','system'), ('administrator','exact','system'), ('root','exact','system'),
  ('postmaster','exact','system'), ('abuse','exact','system'), ('hostmaster','exact','system'),
  ('webmaster','exact','system'), ('support','exact','system'), ('help','exact','system'),
  ('billing','exact','system'), ('security','exact','system'), ('info','exact','system'),
  ('hello','exact','system'), ('contact','exact','system'), ('noreply','exact','system'),
  ('no-reply','exact','system'), ('no_reply','exact','system'), ('alerts','exact','system'),
  ('bugs','exact','system'), ('sales','exact','system'), ('privacy','exact','system'),
  ('legal','exact','system'), ('team','exact','system'), ('mail','exact','system'),
  ('www','exact','system'), ('bounces','exact','system'), ('mailer-daemon','exact','system'),
  -- Product and company names, and anything containing them
  ('tatvaos','contains','product'), ('tatva','contains','product'), ('techvein','contains','product'),
  -- Look-alikes: a starter list, the operator edits it
  ('sbi','exact','lookalike'), ('hdfc','contains','lookalike'), ('icici','contains','lookalike'),
  ('axisbank','contains','lookalike'), ('kotak','contains','lookalike'), ('uidai','contains','lookalike'),
  ('aadhaar','contains','lookalike'), ('incometax','contains','lookalike'), ('gov','exact','lookalike'),
  ('govt','exact','lookalike'), ('epfo','contains','lookalike'), ('rbi','exact','lookalike'),
  ('npci','contains','lookalike'), ('google','contains','lookalike'), ('gmail','contains','lookalike'),
  ('microsoft','contains','lookalike'), ('outlook','contains','lookalike'), ('apple','exact','lookalike'),
  ('amazon','contains','lookalike'), ('flipkart','contains','lookalike'), ('paytm','contains','lookalike'),
  ('phonepe','contains','lookalike'), ('gpay','contains','lookalike'), ('whatsapp','contains','lookalike'),
  ('facebook','contains','lookalike'), ('instagram','contains','lookalike')
ON CONFLICT (name) DO NOTHING;

-- ---- 3. In-progress signups ------------------------------------------------
CREATE TABLE IF NOT EXISTS core.personal_signups (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    local_part         citext NOT NULL,
    display_name       text NOT NULL,
    phone              text,               -- plain text only until completion
    phone_hash         text NOT NULL,
    adult_declared_at  timestamptz NOT NULL,
    code_hash          text,
    code_sent_at       timestamptz,
    code_attempts      integer NOT NULL DEFAULT 0,
    phone_verified_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    completed_user_id  uuid
);
CREATE INDEX IF NOT EXISTS idx_core_personal_signups_created
    ON core.personal_signups (created_at) WHERE completed_at IS NULL;

-- ---- 4. Attempts: rate limits and abuse review -----------------------------
CREATE TABLE IF NOT EXISTS core.personal_signup_attempts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone_hash   text,
    ip           text,
    outcome      text NOT NULL,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_psa_phone ON core.personal_signup_attempts (phone_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_core_psa_ip    ON core.personal_signup_attempts (ip, occurred_at);
CREATE INDEX IF NOT EXISTS idx_core_psa_time  ON core.personal_signup_attempts (occurred_at);

-- ---- 5. Personal accounts --------------------------------------------------
CREATE TABLE IF NOT EXISTS core.personal_accounts (
    user_id            uuid PRIMARY KEY REFERENCES core.users(id) ON DELETE CASCADE,
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    phone_hash         text NOT NULL,
    adult_declared_at  timestamptz NOT NULL,
    terms_version      text NOT NULL,
    privacy_version    text NOT NULL,
    terms_accepted_at  timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_core_personal_accounts_phone
    ON core.personal_accounts (phone_hash);
CREATE INDEX IF NOT EXISTS idx_core_personal_accounts_tenant
    ON core.personal_accounts (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON
    core.reserved_usernames, core.personal_signups,
    core.personal_signup_attempts, core.personal_accounts
    TO tatvaos_app;

DO $$
DECLARE houses int; reserved int;
BEGIN
    SELECT count(*) INTO houses   FROM core.tenants WHERE kind = 'personal_house';
    SELECT count(*) INTO reserved FROM core.reserved_usernames WHERE removed_at IS NULL;
    RAISE NOTICE 'Personal signup (/join): % personal house(s), % reserved name(s) in force.', houses, reserved;
    IF houses = 0 THEN
        RAISE NOTICE '  No personal house yet — /join stays closed until one exists and personal.signup_open is on.';
    END IF;
END $$;

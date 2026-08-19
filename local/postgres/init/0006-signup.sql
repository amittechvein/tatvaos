-- ============================================================================
--  Self-service signup
-- ============================================================================
--
--  A signup that fails at the domain step is the most valuable row on the
--  screen: somebody typed their organisation's name, their own name and their
--  phone number because they wanted this, then hit a step needing DNS access
--  they may not have.
--
--  So nothing is thrown away, and NO TENANT EXISTS until verification passes.
--  The alternative — creating the tenant immediately and marking it incomplete —
--  produces organisation rows with no verified domain and no owner who can sign
--  in, indistinguishable from real customers in every count and report.
--
--  One state, not two half-states.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.signup_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Step 1 — organisation
    org_name text NOT NULL,
    org_type text NOT NULL DEFAULT 'business',
    country  text NOT NULL DEFAULT 'India',
    gstin    text,

    -- Step 2 — the person
    admin_name  text NOT NULL,
    admin_email citext NOT NULL,
    admin_phone text,

    -- Step 3 — the domain
    fqdn text,

    -- Step 4 — verification
    verification_token  text NOT NULL,
    verification_method text CHECK (verification_method IN ('txt','cname','html','meta')),
    attempts int NOT NULL DEFAULT 0,
    last_attempt_at   timestamptz,
    last_attempt_error text,

    -- Where they stopped. Drives both "resume where you left off" and the
    -- sales queue — knowing someone abandoned at step 4 rather than step 1 is
    -- the difference between a lead worth calling and a bounced visitor.
    reached_step int NOT NULL DEFAULT 1 CHECK (reached_step BETWEEN 1 AND 4),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- Set when it becomes a real tenant. Kept rather than deleted, so the
    -- funnel can be measured: how many drafts convert, and how long they took.
    completed_at        timestamptz,
    converted_tenant_id uuid REFERENCES core.tenants(id) ON DELETE SET NULL
);

-- One live draft per email address. Someone retrying the form should resume,
-- not accumulate a dozen rows that make the sales queue useless.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_drafts_email_open
    ON core.signup_drafts(admin_email) WHERE completed_at IS NULL;

-- A domain can only be claimed once, even by an unfinished signup — otherwise
-- two organisations race to verify the same name and the loser's work is
-- silently discarded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_drafts_fqdn_open
    ON core.signup_drafts(fqdn) WHERE completed_at IS NULL AND fqdn IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signup_drafts_queue
    ON core.signup_drafts(created_at DESC) WHERE completed_at IS NULL;

-- ----------------------------------------------------------------------------
--  NO RLS on this table, deliberately.
--
--  A draft belongs to nobody yet — there is no tenant to scope it to. It is
--  read by the anonymous signup flow (by id, from a resume link) and by
--  Techvein's sales queue. Access is controlled by the endpoints, and the
--  anonymous ones take a 128-bit id which cannot be enumerated.
--
--  The mail edge gets nothing here. Postfix has no business reading leads.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON core.signup_drafts TO tatvaos_app;

-- ============================================================================
--  Verification method on real domains too
-- ============================================================================
--
--  Recorded so support can answer "it stopped working" — a CNAME or HTML-file
--  verification lapses when the customer moves their website, and knowing which
--  method was used is the difference between a five-minute answer and an hour.

ALTER TABLE core.domains ADD COLUMN IF NOT EXISTS verification_method text
    CHECK (verification_method IN ('txt','cname','html','meta'));

-- ============================================================================
--  Email confirmation
-- ============================================================================
--
--  Kept even though verification now gates access, because the two prove
--  different things. Domain verification proves they control the DOMAIN; this
--  proves the address they gave us is one they can actually read — which is
--  where every password reset and every invoice goes.
--
--  Hashed, like every other bearer token here.

ALTER TABLE core.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS confirm_token_hash text;
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS confirm_sent_at    timestamptz;

CREATE INDEX IF NOT EXISTS idx_core_users_confirm
    ON core.users(confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;

-- ============================================================================
--  How the tenant came to exist
-- ============================================================================
--  Both paths stay: self-signup for inbound interest, super-admin onboarding
--  for deals closed directly — schools and hospitals are sold to, not signed
--  up. They warrant different trust, so the origin is recorded.

ALTER TABLE core.tenants ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'signup'
    CHECK (origin IN ('signup', 'onboarded'));

-- ============================================================================
--  THE OUTBOUND GATE
-- ============================================================================
--
--  A view, not a column. A boolean would need recomputing every time a domain
--  is verified, unverified, added or removed — and the one path that forgets to
--  update it is the path that lets a spammer send.
--
--  Read by Postfix via sender-external-gate.cf.
-- ============================================================================

CREATE OR REPLACE VIEW mail.senders_allowed_external AS
SELECT m.address,
       m.tenant_id
  FROM mail.mailboxes m
  JOIN core.tenants   t ON t.id = m.tenant_id
 WHERE m.is_active
   AND t.status IN ('active', 'trial')
   AND EXISTS (
       SELECT 1 FROM core.domains d
        WHERE d.tenant_id = m.tenant_id
          AND d.ownership_verified_at IS NOT NULL
          -- MX must point here too. Ownership alone means they proved control;
          -- it does not mean mail for that domain routes to us, and sending as
          -- a domain whose MX is elsewhere is what receivers read as spoofing.
          AND d.mx_verified_at IS NOT NULL
          AND NOT d.is_platform
   );

COMMENT ON VIEW mail.senders_allowed_external IS
    'Mailboxes permitted to send OFF-PLATFORM. Requires a domain of the '
    'tenant''s own with BOTH ownership and MX verified. The abuse control the '
    'Linode SMTP unblock rests on.';

GRANT SELECT ON mail.senders_allowed_external TO tatvaos_mailedge;
GRANT SELECT ON mail.senders_allowed_external TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Signup ready — drafts captured, no tenant until verified';
    RAISE NOTICE '  Outbound requires ownership AND MX on the customer''s own domain';
    RAISE NOTICE '';
END $$;

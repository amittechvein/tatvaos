-- ============================================================================
--  Domain claims: exclusivity comes from VERIFICATION, not from claiming
-- ============================================================================
--
--  Mr. Singh, 24 September 2026:
--
--    "Nothing stops an organisation adding domains it does not own. Each
--     unverified claim locks that name for everyone. So a competitor, or one
--     disgruntled customer, can add the domains of every school in a district
--     ... and every one of those schools is then unable to onboard
--     themselves. The victim sees only 'already in use', cannot prove
--     ownership through the product, and has to find your support desk."
--
--  Today core.domains.fqdn is UNIQUE outright (domains_fqdn_key), so the
--  first claim — verified or not — locks the name platform-wide. That is a
--  denial of service anyone with an account can perform, and in this market
--  a targeted one.
--
--  After this migration:
--    · several organisations may hold a PENDING claim on the same domain
--    · only ONE may hold a VERIFIED one
--    · whoever publishes the TXT record and verifies takes it; the others
--      are superseded (see superseded_at) and told, without being told BY
--      WHOM — naming the winner would tell a squatter which school they
--      were targeting, or tell one customer who a competitor's customer is.
--
--  Losing a claim cannot destroy anything: checked on 24 Sept, both mailbox
--  paths (UserEndpoints.CreateAsync and SharedMailboxEndpoints) refuse
--  unless the domain is verified AND active, so nothing can attach to a
--  pending claim. If that ever stops being true, the endpoint must freeze
--  the losing claim for support instead of superseding it.
--
--  Every file in this directory re-runs on every deploy, so all of it is
--  idempotent and safe on a database that already holds pending rows.
-- ============================================================================

-- Why a claim is no longer live. NULL for every claim that still stands.
ALTER TABLE core.domains
    ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

COMMENT ON COLUMN core.domains.superseded_at IS
    'Set when another organisation proved ownership of this fqdn. The row is '
    'kept so the losing organisation can be told why its claim ended.';

-- The old rule: one row per fqdn, whoever asked first.

-- The new rule: one VERIFIED row per fqdn. Pending claims may coexist.
--
--  Superseded rows are excluded as well as unverified ones: a claim that
--  lost cannot block the winner, and the winner's own row is the only one
--  that will ever carry ownership_verified_at with superseded_at NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_core_domains_verified_unique
    ON core.domains (fqdn)
    WHERE ownership_verified_at IS NOT NULL AND superseded_at IS NULL;

-- The sweeper reads exactly this shape: claims that never proved anything.
CREATE INDEX IF NOT EXISTS idx_core_domains_pending_age
    ON core.domains (created_at)
    WHERE ownership_verified_at IS NULL AND superseded_at IS NULL;

DO $$
DECLARE
    dupes int;
BEGIN
    -- If two VERIFIED rows for one fqdn somehow existed, the unique index
    -- above would have refused to build and this file would have failed
    -- loudly. Saying so here means the next person reading the log knows the
    -- check happened rather than assuming it did.
    SELECT count(*) INTO dupes FROM (
        SELECT fqdn FROM core.domains
         WHERE ownership_verified_at IS NOT NULL AND superseded_at IS NULL
         GROUP BY fqdn HAVING count(*) > 1
    ) d;

    RAISE NOTICE '';
    RAISE NOTICE '  Domain claims: exclusivity now comes from verification.';
    RAISE NOTICE '  Pending claims may share an fqdn; verified ones may not.';
    RAISE NOTICE '  Duplicate verified fqdns found: %', dupes;
    RAISE NOTICE '';
END $$;

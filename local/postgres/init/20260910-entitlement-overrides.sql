-- ============================================================================
--  Entitlement overrides — the exceptions a plan cannot express.
--
--  CTO ruling, 9 Sept 2026: entitlement is DERIVED from the plan, not copied
--  into rows. `core.product_access` said what was granted while `core.plans`
--  said what was included, nothing kept them equal, and they disagreed. That
--  disagreement was not a symptom of the bug, it was the bug — two copies of
--  one fact (rule 10).
--
--  But not everything comes from a plan: trials, goodwill, a migration in
--  progress, a customer given something extra while a contract is signed, a
--  compliance hold that must take something away. Without somewhere to put
--  those, the first exception forces someone to invent a bespoke plan, and we
--  are back to making copies.
--
--  So: entitlement = the plan's products, plus grants, minus revokes.
--
--  ONE TABLE, TWO SCOPES, TWO DIRECTIONS.
--
--    user_id IS NULL  ->  applies to the whole organisation
--    user_id IS SET   ->  applies to that person only
--    mode = 'grant'   ->  adds a product
--    mode = 'revoke'  ->  takes one away
--
--  Per-user assignment lives here rather than in the plan, because the plan is
--  what the organisation buys and this is who inside it may use it.
--
--  ORG REVOKE IS AN ABSOLUTE VETO (CTO, 13 Sept 2026). A user-level 'grant'
--  does NOT defeat an organisation-level 'revoke'. The directions are not
--  symmetric: a revoke exists for a hold, a grant for goodwill. Decided on
--  failure modes rather than specificity — org-revoke-wins fails as "someone
--  cannot use a product they were promised", visible and fixable in one row;
--  the inverse fails as "data flowed during a hold", invisible and
--  unrecoverable. The read path applies org rows first and a revoke there is
--  final; the unique index below is unchanged by this, because org and user
--  rows are different scopes and legitimately coexist.
--
--  CONSEQUENCE FOR THE UI, NOT FOR THIS FILE: when an admin creates a user
--  grant that an org revoke will shadow, the granting screen must say so at
--  the point of granting. A grant that silently does nothing is this
--  codebase's signature bug.
--
--  WHY granted_by AND reason ARE NOT NULL. An exception nobody can attribute
--  becomes permanent by default — it outlives the person who made it and the
--  situation that justified it, and the next reader cannot tell a deliberate
--  arrangement from an accident. That is how the state this replaces came
--  about. The columns are cheap; the archaeology is not.
--
--  EXPIRY IS EVALUATED IN THE READ QUERY, NOT BY A SWEEPER (CTO, 9 Sept). A
--  sweeper is a second system that can be down, be behind, or have never run,
--  and its absence is silent. `expires_at > now()` in the read cannot be
--  behind, because there is nothing to be behind.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.entitlement_overrides (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id)  ON DELETE CASCADE,

    -- NULL means the whole organisation. Deliberately nullable rather than two
    -- tables: the read path applies org rows then user rows, and one table
    -- keeps that ordering visible in one place.
    user_id       uuid          REFERENCES core.users(id)    ON DELETE CASCADE,

    -- Referenced, not free text. An override naming a product that does not
    -- exist is the failure this whole change is about.
    product_code  text NOT NULL REFERENCES core.products(code),

    mode          text NOT NULL CHECK (mode IN ('grant', 'revoke')),

    -- NULL = does not expire. Never defaulted to a value: an expiry nobody
    -- chose is an arrangement that ends on a date nobody knows.
    expires_at    timestamptz,

    granted_by    uuid NOT NULL,
    reason        text NOT NULL CHECK (length(btrim(reason)) > 0),

    created_at    timestamptz NOT NULL DEFAULT now(),

    -- Called withdrawn_at, not revoked_at, because `mode` already uses the word
    -- 'revoke' for the opposite thing: a withdrawn revoke restores access.
    withdrawn_at  timestamptz
);

-- ----------------------------------------------------------------------------
--  One live override per scope per product.
--
--  A 'grant' and a 'revoke' for the same organisation and product at the same
--  time is a contradiction with no correct answer, so the database refuses it
--  rather than leaving the read path to pick a winner. COALESCE with the nil
--  UUID makes the org-level row (user_id IS NULL) participate in uniqueness;
--  a plain unique index would not, because NULLs never collide.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_entitlement_overrides_live
    ON core.entitlement_overrides (
        tenant_id,
        COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        product_code
    )
    WHERE withdrawn_at IS NULL;

-- The read path asks "what applies to this person, in this organisation, now".
CREATE INDEX IF NOT EXISTS ix_entitlement_overrides_lookup
    ON core.entitlement_overrides (tenant_id, user_id)
    WHERE withdrawn_at IS NULL;

COMMENT ON TABLE core.entitlement_overrides IS
    'Exceptions to what a plan includes. Entitlement = plan products + grants '
    '- revokes, with org-level rows applied before user-level ones. Expiry is '
    'evaluated in the read query; there is no sweeper. Every row carries who '
    'made it and why, because an unattributable exception becomes permanent.';

-- ----------------------------------------------------------------------------
--  RLS — same shape as space.tenant_settings and connect.tenant_settings.
-- ----------------------------------------------------------------------------
ALTER TABLE core.entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.entitlement_overrides FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.entitlement_overrides;
CREATE POLICY tenant_isolation ON core.entitlement_overrides
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.entitlement_overrides TO tatvaos_app;
-- The mail edge gets nothing. It authenticates mailboxes; it does not read
-- entitlement.

-- ----------------------------------------------------------------------------
--  Report what is here, rather than assert what should be (rule 6).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    live int;
    expired int;
BEGIN
    SELECT count(*) FILTER (WHERE withdrawn_at IS NULL
                              AND (expires_at IS NULL OR expires_at > now())),
           count(*) FILTER (WHERE withdrawn_at IS NULL
                              AND expires_at IS NOT NULL AND expires_at <= now())
      INTO live, expired
      FROM core.entitlement_overrides;

    RAISE NOTICE '';
    RAISE NOTICE '  core.entitlement_overrides ready.';
    RAISE NOTICE '    % override(s) in effect, % expired but not withdrawn', live, expired;
    RAISE NOTICE '    entitlement = plan products + grants - revokes';
    RAISE NOTICE '    expiry is evaluated in the read query; there is no sweeper';
    RAISE NOTICE '';
END $$;

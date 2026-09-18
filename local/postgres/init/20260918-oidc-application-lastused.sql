-- ============================================================================
--  OpenID Connect applications — last used (decision 0004; Amit's review,
--  18 Sept 2026, group 3)
-- ============================================================================
--
--  "An integration nobody has used in a year is one to ask about" — which is
--  the question this column answers, and the only one it needs to.
--
--  WRITTEN AT MOST ONCE AN HOUR PER APPLICATION, deliberately. This would
--  otherwise be a row update on every token exchange: a write per sign-in and
--  per refresh, on a four-core box that also carries live meetings.
--  mail.api_keys' last_used_at has the same shape and the same hazard (CTO,
--  18 Sept 2026). Nobody asks this to the second; "last used today" is the
--  real question, so the API skips the write when the stored value is less
--  than an hour old.
--
--  Additive and re-runnable.
-- ----------------------------------------------------------------------------

ALTER TABLE core.oidc_applications
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

COMMENT ON COLUMN core.oidc_applications.last_used_at IS
    'When this application last exchanged a code or refresh token. Updated at most once an hour per application: it is a write on every sign-in otherwise.';

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  OpenID Connect applications: last_used_at ready (0004, group 3)';
    RAISE NOTICE '';
END $$;

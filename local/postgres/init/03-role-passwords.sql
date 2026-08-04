-- ============================================================================
--  Real passwords for the application roles
-- ============================================================================
--
--  00-core-schema.sql creates tatvaos_app and tatvaos_mailedge with fixed
--  development passwords, because the local stack needs them to be knowable.
--  On a real server that is wrong twice over:
--
--    1. The API connects with APP_DB_PASSWORD from .env, which does NOT match
--       'dev_app_pw'. Every query fails authentication while the container
--       reports itself Up and healthy - the failure surfaces as a 503 on
--       /health/db with nothing obviously wrong anywhere else.
--
--    2. A production database whose application role password is 'dev_app_pw'
--       is a production database with no password.
--
--  Runs last, after the roles exist. Idempotent: ALTER ROLE ... PASSWORD is
--  safe to repeat, so apply-schema.sh and deploy.sh can both re-run it.
--
--  ---------------------------------------------------------------------------
--  tatvaos_mailedge is deliberately NOT changed here.
--
--  Postfix and Dovecot read their password from .cf files that are mounted
--  read-only and still say 'dev_mail_pw'. Rotating the role without templating
--  those files would break mail delivery instantly and confusingly. Doing it
--  properly means giving those two containers an entrypoint that substitutes
--  the value at start - tracked separately. Until then this is a known gap,
--  written down rather than quietly left.
--  ---------------------------------------------------------------------------

-- Default first. \getenv leaves the variable UNSET when the environment
-- variable is absent, and :'app_pw' on an unset variable is an error. CI runs
-- these same files with no APP_DB_PASSWORD in scope, so this must be a no-op
-- there rather than a failure.
\set app_pw ''
\getenv app_pw APP_DB_PASSWORD

-- \gexec runs the generated statement. %L quotes the literal properly, so a
-- password containing a quote cannot terminate the string early.
SELECT format('ALTER ROLE tatvaos_app PASSWORD %L', :'app_pw')
WHERE  :'app_pw' <> ''
\gexec

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Application role password applied from APP_DB_PASSWORD';
    RAISE NOTICE '  tatvaos_mailedge still uses the development password -';
    RAISE NOTICE '  see the header of this file before going to production.';
    RAISE NOTICE '';
END $$;

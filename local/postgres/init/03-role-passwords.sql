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
--  tatvaos_mailedge IS rotated here too, as of the production cutover.
--
--  It used to be skipped, because Postfix and Dovecot read their password from
--  files that were bind-mounted read-only and still said 'dev_mail_pw' -
--  rotating the role without changing those files would have broken mail
--  delivery instantly and confusingly.
--
--  Both containers now render those files at start from MAILEDGE_DB_PASSWORD
--  (see local/postfix/entrypoint.sh and local/dovecot/entrypoint.sh), so the
--  two halves move together. If they ever disagree the symptom is Postfix
--  rejecting every recipient and Dovecot rejecting every login, which looks
--  like a database outage - the entrypoints check for that explicitly and
--  refuse to start rather than let it look like something else.
--  ---------------------------------------------------------------------------

-- Defaults first. \getenv leaves the variable UNSET when the environment
-- variable is absent, and :'app_pw' on an unset variable is an error. CI runs
-- these same files with no APP_DB_PASSWORD in scope, so this must be a no-op
-- there rather than a failure.
\set app_pw ''
\getenv app_pw APP_DB_PASSWORD

\set mail_pw ''
\getenv mail_pw MAILEDGE_DB_PASSWORD

-- \gexec runs the generated statement. %L quotes the literal properly, so a
-- password containing a quote cannot terminate the string early.
SELECT format('ALTER ROLE tatvaos_app PASSWORD %L', :'app_pw')
WHERE  :'app_pw' <> ''
\gexec

SELECT format('ALTER ROLE tatvaos_mailedge PASSWORD %L', :'mail_pw')
WHERE  :'mail_pw' <> ''
\gexec

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Role passwords applied from APP_DB_PASSWORD and';
    RAISE NOTICE '  MAILEDGE_DB_PASSWORD. Any role whose variable was empty';
    RAISE NOTICE '  keeps its development password - correct locally, and a';
    RAISE NOTICE '  problem anywhere else.';
    RAISE NOTICE '';
END $$;

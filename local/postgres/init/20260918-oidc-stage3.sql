-- ============================================================================
--  OpenID Connect provider — stage 3 (decision 0004): the unique indexes
--  are named for what they are
-- ============================================================================
--
--  Stage 1 created the two indexes the pre-tenant resolvers rely on as
--  ix_oidc_applications_client_id and ix_oidc_tokens_reference_id. Both are
--  UNIQUE — that uniqueness is what lets each resolver promise ONE row — and
--  this schema's convention names a unique index ux_, so a reader of \d sees
--  the promise in the name (CTO, 17 Sept 2026). The stage 1 file now
--  creates them under the ux_ names; this file carries any database that
--  already has the ix_ names across.
--
--  Every file here re-runs on every deploy, so this must be right in all
--  three states: a fresh database (stage 1 already made ux_, no ix_ — do
--  nothing); production before this deploy (ix_ exists, and the re-run of
--  stage 1 has just built ux_ beside it — drop the duplicate); and a database
--  where only ix_ exists (rename). Never two unique indexes on one column
--  for longer than the moment between those two files.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('core.ix_oidc_applications_client_id') IS NOT NULL THEN
        IF to_regclass('core.ux_oidc_applications_client_id') IS NOT NULL THEN
            DROP INDEX core.ix_oidc_applications_client_id;
        ELSE
            ALTER INDEX core.ix_oidc_applications_client_id RENAME TO ux_oidc_applications_client_id;
        END IF;
    END IF;
    IF to_regclass('core.ix_oidc_tokens_reference_id') IS NOT NULL THEN
        IF to_regclass('core.ux_oidc_tokens_reference_id') IS NOT NULL THEN
            DROP INDEX core.ix_oidc_tokens_reference_id;
        ELSE
            ALTER INDEX core.ix_oidc_tokens_reference_id RENAME TO ux_oidc_tokens_reference_id;
        END IF;
    END IF;
END $$;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  OpenID Connect provider stage 3: unique indexes named ux_ (0004)';
    RAISE NOTICE '';
END $$;

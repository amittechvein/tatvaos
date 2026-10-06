#!/usr/bin/env bash
# =============================================================================
#  extract-production.sh — the copy of production that tests/plans-measure
#  measures PR 313 against (Mr. Singh on PR 313, 28 Sept 2026).
#
#  ON THE SERVER, from the repo root, with Amit's go (a production read):
#      bash tests/plans-measure/extract-production.sh > ~/plans-measure-copy.sql
#  then copy that one file to the laptop, and delete it from the server.
#
#  READ-ONLY: one transaction, SET TRANSACTION READ ONLY; nothing is written.
#
#  WHAT IT CARRIES: only what decides an organisation's plan, features,
#  limits, AI credits and storage. NO PERSONAL DATA:
#    - organisations: name -> "org-<id prefix>"; admin name, email, phone,
#      GSTIN -> empty
#    - domains:       fqdn -> "d<id prefix>.invalid"; DKIM/verification refs -> empty
#    - people:        id, organisation, role, status, storage allowance only;
#                     email -> "<id>@anon.invalid", name -> "u"; no password,
#                     phone, recovery or MFA columns at all
#    - mailboxes:     address -> "m<id prefix>@anon.invalid"; sizes and
#                     quotas kept; no password hash, no display name
#    - plans, features, limits, overrides, subscriptions, storage pools and
#      allocations, AI top-ups, AI usage (counts and tokens; no content
#      exists in that table), product access: as they are
#  plus a MANIFEST of every table's row count, which run.sh checks after
#  loading — so a table that failed to copy cannot pass as "no change".
#
#  The output loads into a database built from the SAME commit production
#  runs (run.sh builds it from .tmp/measure-main).
# =============================================================================
set -uo pipefail
# EXTRACT_PSQL stands in for the server's psql in the local rehearsal
# (tests/plans-measure/rehearse-extract.sh); on the server it is unset.
if [ -n "${EXTRACT_PSQL:-}" ]; then PSQL_CMD="$EXTRACT_PSQL"; else
    PG=$(docker ps --format '{{.Names}}' | grep -m1 postgres)
    [ -n "$PG" ] || { echo "no postgres container" >&2; exit 1; }
    PSQL_CMD="docker exec -i $PG psql -U postgres -d ${MEASURE_PROD_DB:-tatvaos_mail}"
fi

$PSQL_CMD -q -At -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET TRANSACTION READ ONLY;
\echo '-- plans-measure production copy. Anonymised. Load into a database built from production''s commit.'
\echo 'BEGIN;'
\echo 'TRUNCATE core.tenants, core.plans, core.products, core.features CASCADE;'

\echo 'COPY core.tenants (id, name, type, status, country, created_at, suspended_at, trial_ends_at, origin, allow_connect_guests, allow_connect_recording, connect_email_minutes, connect_recording_retention_days, allow_ai, mail_ai_triage_since, allow_mail_ai, ai_credits_override, mail_ai_rewrite, mail_ai_suggest, mail_ai_summary, keeps_everything) FROM stdin;'
COPY (SELECT id, 'org-' || left(id::text, 8), type, status, country, created_at, suspended_at, trial_ends_at, origin,
             allow_connect_guests, allow_connect_recording, connect_email_minutes, connect_recording_retention_days,
             allow_ai, mail_ai_triage_since, allow_mail_ai, ai_credits_override, mail_ai_rewrite, mail_ai_suggest,
             mail_ai_summary, keeps_everything
        FROM core.tenants) TO STDOUT;
\echo '\\.'

\echo 'COPY core.domains (id, tenant_id, fqdn, type, is_active, ownership_verified_at, mx_verified_at, dmarc_policy, created_at, is_platform) FROM stdin;'
COPY (SELECT id, tenant_id, 'd' || left(id::text, 8) || '.invalid', type, is_active, ownership_verified_at, mx_verified_at,
             dmarc_policy, created_at, is_platform
        FROM core.domains) TO STDOUT;
\echo '\\.'

\echo 'COPY core.users (id, tenant_id, domain_id, email, display_name, role, status, created_at, storage_quota_bytes) FROM stdin;'
COPY (SELECT id, tenant_id, domain_id, id::text || '@anon.invalid', 'u', role, status, created_at, storage_quota_bytes
        FROM core.users) TO STDOUT;
\echo '\\.'

\echo 'COPY mail.mailboxes (id, tenant_id, domain_id, user_id, address, local_part, type, quota_bytes, used_bytes, is_active, created_at) FROM stdin;'
COPY (SELECT id, tenant_id, domain_id, user_id, 'm' || left(id::text, 8) || '@anon.invalid', 'm' || left(id::text, 8),
             type, quota_bytes, used_bytes, is_active, created_at
        FROM mail.mailboxes) TO STDOUT;
\echo '\\.'

-- Configuration, whole tables (same column order: same commit).
\echo 'COPY core.plans FROM stdin;'
COPY core.plans TO STDOUT;
\echo '\\.'
\echo 'COPY core.products FROM stdin;'
COPY core.products TO STDOUT;
\echo '\\.'
\echo 'COPY core.features FROM stdin;'
COPY core.features TO STDOUT;
\echo '\\.'
\echo 'COPY core.plan_feature_limits FROM stdin;'
COPY core.plan_feature_limits TO STDOUT;
\echo '\\.'
\echo 'COPY core.feature_overrides FROM stdin;'
COPY core.feature_overrides TO STDOUT;
\echo '\\.'
\echo 'COPY core.subscriptions FROM stdin;'
COPY core.subscriptions TO STDOUT;
\echo '\\.'
\echo 'COPY core.storage_pools FROM stdin;'
COPY core.storage_pools TO STDOUT;
\echo '\\.'
\echo 'COPY core.storage_allocations FROM stdin;'
COPY core.storage_allocations TO STDOUT;
\echo '\\.'
\echo 'COPY core.ai_credit_topups FROM stdin;'
COPY core.ai_credit_topups TO STDOUT;
\echo '\\.'
\echo 'COPY core.ai_usage FROM stdin;'
COPY core.ai_usage TO STDOUT;
\echo '\\.'
\echo 'COPY core.product_access FROM stdin;'
COPY core.product_access TO STDOUT;
\echo '\\.'

\echo 'COMMIT;'
-- The manifest: run.sh compares these with the loaded copy.
SELECT '-- manifest ' || string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
    SELECT 'core.tenants' t, count(*) n FROM core.tenants UNION ALL
    SELECT 'core.domains', count(*) FROM core.domains UNION ALL
    SELECT 'core.users', count(*) FROM core.users UNION ALL
    SELECT 'mail.mailboxes', count(*) FROM mail.mailboxes UNION ALL
    SELECT 'core.plans', count(*) FROM core.plans UNION ALL
    SELECT 'core.products', count(*) FROM core.products UNION ALL
    SELECT 'core.features', count(*) FROM core.features UNION ALL
    SELECT 'core.plan_feature_limits', count(*) FROM core.plan_feature_limits UNION ALL
    SELECT 'core.feature_overrides', count(*) FROM core.feature_overrides UNION ALL
    SELECT 'core.subscriptions', count(*) FROM core.subscriptions UNION ALL
    SELECT 'core.storage_pools', count(*) FROM core.storage_pools UNION ALL
    SELECT 'core.storage_allocations', count(*) FROM core.storage_allocations UNION ALL
    SELECT 'core.ai_credit_topups', count(*) FROM core.ai_credit_topups UNION ALL
    SELECT 'core.ai_usage', count(*) FROM core.ai_usage UNION ALL
    SELECT 'core.product_access', count(*) FROM core.product_access) m;
ROLLBACK;
SQL

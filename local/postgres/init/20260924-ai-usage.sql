-- ============================================================================
--  AI usage — one row per request to the AI gateway, for metering and limits
-- ============================================================================
--
--  Mr. Singh's ruling, 24 Sept 2026 (on TatvaOS Docs' AI): "Metering comes
--  first and is mandatory … you cannot price what you do not measure; you
--  cannot tell a customer why their bill moved; and you cannot detect abuse
--  you are not counting." Until now the only record of AI spend was a log
--  line ("AI ok: … tenant …"), which nothing could sum and nothing enforced.
--
--  Written by MeteredAiGateway (apps/api/Shared/Ai), the one wrapper every AI
--  call passes through — Connect's minutes, the status probe, Docs when it
--  lands. Read by the same wrapper for the limits, by the organisation's AI
--  screen for "used this month", and by the operator console.
--
--  NEVER CONTENT. Counts, the feature that asked, the outcome, who and when.
--  The prompt and the answer are the customer's text and are not stored here
--  or anywhere else (IAiGateway rule 4).
--
--  Additive only: two new tables in core. Nothing existing changes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.ai_usage (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    -- NULL for work no person asked for at that moment (Connect's minutes
    -- worker). Such rows count toward the organisation, not a person.
    user_id     uuid REFERENCES core.users(id) ON DELETE SET NULL,

    -- Which product asked: 'connect.minutes', 'docs', 'platform.probe', …
    feature     text NOT NULL CHECK (length(feature) BETWEEN 1 AND 64),

    -- ok       the provider answered
    -- failed   the provider was asked and failed (may still have cost money)
    -- refused_paused        the operator's platform-wide pause was on
    -- refused_person_limit  this person's hourly limit was reached
    -- refused_org_limit     the organisation's monthly ceiling was reached
    -- Refusals are recorded too: a flood of them is how abuse shows up.
    outcome     text NOT NULL CHECK (outcome IN
                  ('ok','failed','refused_paused','refused_person_limit','refused_org_limit')),

    tokens_in   integer NOT NULL DEFAULT 0 CHECK (tokens_in  >= 0),
    tokens_out  integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),

    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The two limit queries: an organisation's month, a person's last hour.
CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_time ON core.ai_usage(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time   ON core.ai_usage(user_id, created_at)
    WHERE user_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Which ceiling warnings an organisation's administrators have been sent,
-- per month. One row per (organisation, month, level), so each warning goes
-- once — at 80 % and at 100 % — however many requests cross it.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.ai_usage_alerts (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    month       date NOT NULL,          -- first day of the month, India time
    level       smallint NOT NULL CHECK (level IN (80, 100)),
    sent_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, month, level)
);

-- ----------------------------------------------------------------------------
-- RLS — tenant only, forced. The same nullif(current_setting(..., true), '')
-- reading as everywhere else: unset or empty means NULL means no rows.
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['ai_usage','ai_usage_alerts']
    LOOP
        EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE core.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON core.%I', t);
        EXECUTE format('
            CREATE POLICY tenant_isolation ON core.%I
            USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Grants. The usage table is a RECORD: the app appends and reads, never
-- rewrites (the same stance as 20260915-append-only-revokes.sql). Alerts are
-- appended once per level and never changed either.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT ON core.ai_usage, core.ai_usage_alerts TO tatvaos_app;
REVOKE UPDATE, DELETE ON core.ai_usage, core.ai_usage_alerts FROM tatvaos_app;
GRANT USAGE, SELECT ON SEQUENCE core.ai_usage_id_seq TO tatvaos_app;

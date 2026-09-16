-- ============================================================================
--  Sign-in handoff codes — the app's token traded for a browser session.
--
--  docs/decisions/0003-mobile-signin-handoff.md, accepted 15 Sept 2026.
--
--  THE PROBLEM THIS SOLVES. The mobile app holds a bearer token; the web
--  products authenticate by cookie. So a web view inside the app lands on a
--  login page — the person is signed in, looking at a sign-in screen. The app
--  ships the system browser instead, at the cost of one extra sign-in per
--  product, and the brief's web-view plan has been blocked on this table.
--
--  WHAT A ROW IS. A one-time, sixty-second claim on a session, hashed at rest.
--  The plaintext code exists only in the mint response and the app's memory; it
--  reaches the browser in the URL FRAGMENT, which is never sent to a server.
--
--  WHY THE HASH AND NOT THE CODE. Same rule as core.refresh_tokens: the
--  plaintext of a bearer credential is stored nowhere on this platform. A
--  database backup, a stray query log, or a support person reading a row must
--  not yield something that signs in as somebody.
--
--  NO SWEEPER, ON PURPOSE (the rule 20260910-entitlement-overrides.sql states):
--  expiry is decided in the redeem statement, not by a background job that can
--  be down, behind, or never have run. Spent and expired rows are inert — they
--  can only ever fail the redeem predicate. Deleting them is housekeeping, not
--  security, and there is deliberately no job here that has to be running for
--  this table to be safe.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.auth_handoff_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES core.users(id)   ON DELETE CASCADE,

    -- SHA-256 of the code, hex, like core.refresh_tokens.token_hash.
    code_hash   text NOT NULL,

    -- Where the browser lands. Stored as minted and checked against the
    -- allowlist AT MINT (AuthEndpoints, HandoffProducts), so a code cannot
    -- carry a path nobody authorised — and an open redirect cannot be built by
    -- editing the fragment, because the path travels in the row, not the URL.
    -- The URL's own #p= is for the landing page's own use; the redirect the
    -- server answers with comes from HERE.
    path        text NOT NULL CHECK (path LIKE '/%' AND path NOT LIKE '//%'),

    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    redeemed_at timestamptz
);

-- One row per code. A collision would mean two sessions behind one code, and
-- 256 bits makes that impossible in practice — but the constraint is what makes
-- the redeem's "exactly one row" true by construction rather than by argument.
CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_handoff_code_hash
    ON core.auth_handoff_codes (code_hash);

-- For housekeeping deletes; the redeem finds its row by hash.
CREATE INDEX IF NOT EXISTS ix_auth_handoff_expiry
    ON core.auth_handoff_codes (expires_at);

COMMENT ON TABLE core.auth_handoff_codes IS
    'One-time, 60-second codes that trade a mobile bearer token for a browser '
    'session. Hashed at rest; the plaintext travels in a URL fragment and is '
    'never logged. Single use is enforced by core.redeem_handoff_code, not by '
    'the application.';

-- ----------------------------------------------------------------------------
--  RLS — forced, like every other tenant table. Minting runs inside a known
--  tenant and obeys it. Redeeming cannot: the code arrives from a browser with
--  no session, so the tenant is unknown until the row is read. That circle is
--  broken the same way core.refresh_tokens breaks it — one SECURITY DEFINER
--  function that does exactly one thing.
-- ----------------------------------------------------------------------------
ALTER TABLE core.auth_handoff_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.auth_handoff_codes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.auth_handoff_codes;
CREATE POLICY tenant_isolation ON core.auth_handoff_codes
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
--  The redeem — single use by construction.
--
--  ONE STATEMENT, NOT A SELECT THEN AN UPDATE. Two statements can both read an
--  unredeemed row before either writes, and two browsers then both get a
--  session from one code. Here the UPDATE's own WHERE is the check: the second
--  caller matches no row, because the first has already moved redeemed_at.
--  serialises the row lock; the application cannot get this wrong.
--
--  RETURNS NOTHING for invalid, already used, and expired alike. The caller
--  answers the same 401 to all three, so a probe holding a random code cannot
--  learn whether it ever existed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.redeem_handoff_code(p_hash text)
RETURNS TABLE (tenant_id uuid, user_id uuid, path text)
LANGUAGE sql
SECURITY DEFINER
-- Pinned, mandatory on SECURITY DEFINER: without it a caller's search_path
-- could point these names at objects of their own.
SET search_path = core, pg_temp
AS $$
    UPDATE core.auth_handoff_codes
       SET redeemed_at = now()
     WHERE code_hash = p_hash
       AND redeemed_at IS NULL
       AND expires_at > now()
    RETURNING auth_handoff_codes.tenant_id,
              auth_handoff_codes.user_id,
              auth_handoff_codes.path;
$$;

REVOKE ALL ON FUNCTION core.redeem_handoff_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.redeem_handoff_code(text) TO tatvaos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.auth_handoff_codes TO tatvaos_app;
-- The mail edge gets nothing. Postfix authenticates mailboxes; it has no
-- business near session issuance.

-- ----------------------------------------------------------------------------
--  Report what is here, rather than assert what should be (rule 6).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    live    int;
    spent   int;
    stale   int;
BEGIN
    SELECT count(*) FILTER (WHERE redeemed_at IS NULL AND expires_at >  now()),
           count(*) FILTER (WHERE redeemed_at IS NOT NULL),
           count(*) FILTER (WHERE redeemed_at IS NULL AND expires_at <= now())
      INTO live, spent, stale
      FROM core.auth_handoff_codes;

    RAISE NOTICE '';
    RAISE NOTICE '  core.auth_handoff_codes ready.';
    RAISE NOTICE '    % unredeemed and still valid, % spent, % expired unused', live, spent, stale;
    RAISE NOTICE '    single use is enforced by core.redeem_handoff_code, not by the app';
    RAISE NOTICE '    expiry is evaluated in that statement; there is no sweeper';
    RAISE NOTICE '';
END $$;

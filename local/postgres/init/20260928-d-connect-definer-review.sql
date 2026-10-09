-- ============================================================================
--  Decision 0007: the review of Connect's SECURITY DEFINER functions
-- ============================================================================
--
--  A definer function runs as its owner, so neither row-level security nor any
--  EF filter applies inside it: its body is the only guard. The review of all
--  thirty in schema connect (28 Sept 2026) is in
--  docs/decisions/0007-tenantless-paths.md section 3. Every body names its
--  tables schema-qualified, so none was open to a temporary-table hijack, and
--  every input that reaches a content-returning function comes from a signed
--  token, a secret, the session, or a list the worker got from another definer.
--  This file makes three things true by construction rather than by care:
--
--  1. Every connect definer searches pg_catalog FIRST and pg_temp LAST (Mr.
--     Singh's rule from the 24 Sept audit; 11 of the 30 omitted pg_temp, which
--     Postgres then searches FIRST for relations). Done for every connect
--     definer on every run, so an older file's CREATE OR REPLACE - which
--     resets the setting when it re-runs on each deploy - is corrected after.
--  2. No connect definer is executable by PUBLIC. One was:
--     recording_retention_days (functions are PUBLIC-executable unless
--     revoked). Only tatvaos_app may call them.
--  3. minutes_recipients and minutes_unreachable - attendee emails and names,
--     and a count, for ANY meeting id - now also require the meeting to belong
--     to the caller's current organisation (app.tenant_id). Every caller
--     already enters that organisation first (the minutes routes after
--     SeenMeeting/role checks; the worker after EnterAnonymousScope); this
--     makes a future caller that forgets get nothing instead of another
--     organisation's attendees.
--
--  NOT done here, for Mr. Singh: four definers have no caller anywhere
--  (meeting_chat_lines - any meeting's chat -, meetings_with_captions,
--  recording_bytes, share_for_user). Dropping them is not additive.
--
--  Re-runnable.
-- ============================================================================

-- 3. The two attendee functions, guarded by the caller's organisation.
CREATE OR REPLACE FUNCTION connect.minutes_recipients(p_meeting uuid)
RETURNS TABLE (email text, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, connect, core, pg_temp
AS $$
    SELECT DISTINCT ON (lower(u.email)) u.email, COALESCE(NULLIF(u.display_name, ''), u.email)
      FROM connect.participants p
      JOIN core.users u ON u.id = p.user_id
     WHERE p.meeting_id = p_meeting
       AND p.user_id IS NOT NULL
       AND p.first_joined_at IS NOT NULL
       AND u.email <> ''
       AND u.status NOT IN ('deleted', 'suspended')
       AND EXISTS (SELECT 1 FROM connect.meetings m
                    WHERE m.id = p_meeting
                      AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     ORDER BY lower(u.email);
$$;

CREATE OR REPLACE FUNCTION connect.minutes_unreachable(p_meeting uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, connect, core, pg_temp
AS $$
    SELECT COUNT(*)::integer
      FROM connect.participants p
     WHERE p.meeting_id = p_meeting
       AND p.first_joined_at IS NOT NULL
       AND (p.user_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM core.users u
                            WHERE u.id = p.user_id
                              AND u.status NOT IN ('deleted', 'suspended')
                              AND u.email <> ''))
       AND EXISTS (SELECT 1 FROM connect.meetings m
                    WHERE m.id = p_meeting
                      AND m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
$$;

-- 1 and 2, for every connect definer, every run.
DO $$
DECLARE
    f regprocedure;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'connect' AND p.prosecdef
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, connect, core, pg_temp', f);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tatvaos_app', f);
    END LOOP;
END $$;

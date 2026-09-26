-- ============================================================================
--  Connect recording sharing — the READ side, and three defects found wiring it
-- ============================================================================
--
--  26 September 2026. 20260908-b built the tables, the definer functions and
--  the host's routes, and left the feature off (docs/CONNECT_DECISIONS.md §3).
--  Wiring the reader's side against a database built from nothing found three
--  things that would each have broken it the day it was switched on. All three
--  were run, not reasoned about; the output is in the PR.
--
--  1. THE EXPIRY TRIGGER READ A COLUMN THAT DOES NOT EXIST.
--     recording_shares_cap_expiry() used r.tenant_id, and connect.recordings
--     has no tenant_id — it is scoped through its meeting. PL/pgSQL compiles a
--     query on first use, so the file applied cleanly and every INSERT with an
--     expires_at failed:
--         ERROR:  column r.tenant_id does not exist
--     Every link share has an expiry by rule, so no password or public link
--     could ever have been created. Fixed by reading the meeting's tenant.
--
--  2. THE APP COULD NOT CALL resolve_share_token().
--     REVOKE ALL ... FROM PUBLIC and no GRANT to tatvaos_app, so every link
--     holder would have got a 500. share_for_user() worked only by accident:
--     it was never revoked from PUBLIC. Both are now explicit, the same shape
--     as resolve_meeting_code in 20260817-connect.sql.
--
--  3. A SUSPENDED ORGANISATION'S LINKS STILL RESOLVED. §3 case 4, which its
--     author expected to fail and said so. Suspension is core.tenants.status;
--     resolve_meeting_code already refuses anything but 'active' and 'trial',
--     and this uses the same rule, word for word, so the guest door and a
--     recording link cannot disagree about which organisations are open.
--
--  EVERY "IS THIS SHARE STILL GOOD" QUESTION NOW GOES THROUGH ONE FUNCTION,
--  connect.share_is_live(). Before this file the conditions were written out
--  twice (resolve_share_token, share_for_user) and the ticket re-check would
--  have been a third copy. Three copies of a security rule is how one of them
--  ends up missing a clause — which is exactly what happened to suspension.
--
--  Idempotent: CREATE OR REPLACE throughout, and it runs after 20260908-b on
--  every deploy, so its definitions are the ones that stand.
-- ============================================================================


-- ----------------------------------------------------------------------------
--  1. The expiry ceiling, reading the tenant from the meeting.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.recording_shares_cap_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_ceiling timestamptz;
BEGIN
    IF NEW.expires_at IS NULL THEN
        RETURN NEW;
    END IF;

    -- connect.recordings has no tenant_id. The meeting does, and it is the
    -- same organisation the share row names; reading it from the meeting
    -- rather than from NEW.tenant_id means a share row that somehow named the
    -- wrong organisation still gets the recording's real ceiling.
    SELECT COALESCE(r.keep_until_at,
                    r.created_at
                      + make_interval(days => connect.recording_retention_days(m.tenant_id)))
      INTO v_ceiling
      FROM connect.recordings r
      JOIN connect.meetings   m ON m.id = r.meeting_id
     WHERE r.id = NEW.recording_id;

    IF v_ceiling IS NOT NULL AND NEW.expires_at > v_ceiling THEN
        NEW.expires_at := v_ceiling;
    END IF;

    RETURN NEW;
END $$;


-- ----------------------------------------------------------------------------
--  2. The one definition of "this share still lets somebody in".
-- ----------------------------------------------------------------------------
--
--  Not revoked, not expired, the organisation open, and — for 'public' only —
--  the organisation's switch on. Nothing about WHO is asking: that is the
--  caller's half (a named grant, a password, the same organisation).
--
--  Definer because an anonymous link holder has no tenant for RLS to scope
--  by, and a cross-organisation named reader is scoped to the wrong one.
--  Returns one boolean about one id the caller already holds, so it cannot
--  be used to enumerate anything.
CREATE OR REPLACE FUNCTION connect.share_is_live(p_share_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM connect.recording_shares s
          JOIN core.tenants t ON t.id = s.tenant_id
         WHERE s.id = p_share_id
           AND s.revoked_at IS NULL
           AND (s.expires_at IS NULL OR s.expires_at > now())
           -- Case 4. The same two words resolve_meeting_code uses.
           AND t.status IN ('active', 'trial')
           -- The switch, at read time (20260908-b §6). EXISTS, so an
           -- organisation with no settings row reads as off.
           AND (s.level <> 'public'
                OR EXISTS (SELECT 1
                             FROM connect.tenant_settings ts
                            WHERE ts.tenant_id = s.tenant_id
                              AND ts.allow_public_recording_links)));
$$;

REVOKE ALL ON FUNCTION connect.share_is_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.share_is_live(uuid) TO tatvaos_app;

COMMENT ON FUNCTION connect.share_is_live(uuid) IS
    'The single definition of a share that still authorises: not revoked, not '
    'expired, organisation active or trial, and for public the organisation '
    'switch on. Every read path asks this; none restates it.';


-- ----------------------------------------------------------------------------
--  3. Link holders. Same shape as before; the conditions now come from (2).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.resolve_share_token(p_token text)
RETURNS TABLE (
    share_id     uuid,
    recording_id uuid,
    meeting_id   uuid,
    tenant_id    uuid,
    level        text,
    has_password boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_catalog
AS $$
    SELECT s.id, s.recording_id, s.meeting_id, s.tenant_id, s.level,
           s.password_hash IS NOT NULL
      FROM connect.recording_shares s
     WHERE s.token = p_token
       -- Only the two link levels are reached by holding a token. The CHECK
       -- constraint already keeps tokens off the other two; saying it here as
       -- well costs nothing and survives somebody relaxing that constraint.
       AND s.level IN ('password', 'public')
       AND connect.share_is_live(s.id)
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION connect.resolve_share_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.resolve_share_token(text) TO tatvaos_app;


-- ----------------------------------------------------------------------------
--  4. Signed-in readers who were not in the room.
-- ----------------------------------------------------------------------------
--
--  share_for_user() returned the share id alone, and the caller then read the
--  level "under ordinary RLS". For a reader in ANOTHER organisation — the
--  case this function exists for (§3 case 7) — that read is scoped to the
--  reader's tenant, finds nothing, and refuses them. So the cross-organisation
--  grant could never have worked end to end.
--
--  This returns what the caller needs to go on — the share, its level, and
--  the recording's meeting and organisation — only to somebody the share
--  actually covers. The narrower share wins, as before.
CREATE OR REPLACE FUNCTION connect.share_access_for_user(
    p_recording_id uuid,
    p_user_id      uuid,
    p_user_tenant  uuid)
RETURNS TABLE (
    share_id   uuid,
    level      text,
    meeting_id uuid,
    tenant_id  uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_catalog
AS $$
    SELECT s.id, s.level, s.meeting_id, s.tenant_id
      FROM connect.recording_shares s
     WHERE s.recording_id = p_recording_id
       AND connect.share_is_live(s.id)
       AND (
             (s.level = 'organisation' AND s.tenant_id = p_user_tenant)
          OR (s.level = 'named' AND EXISTS (
                SELECT 1 FROM connect.recording_share_grants g
                 WHERE g.share_id = s.id
                   AND g.subject_user_id = p_user_id
                   AND g.revoked_at IS NULL))
           )
     ORDER BY CASE s.level WHEN 'named' THEN 0 ELSE 1 END
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION connect.share_access_for_user(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.share_access_for_user(uuid, uuid, uuid) TO tatvaos_app;

-- Kept for anything that still calls it, now built on the same definition.
CREATE OR REPLACE FUNCTION connect.share_for_user(
    p_recording_id uuid,
    p_user_id      uuid,
    p_user_tenant  uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_catalog
AS $$
    SELECT a.share_id
      FROM connect.share_access_for_user(p_recording_id, p_user_id, p_user_tenant) a;
$$;

REVOKE ALL ON FUNCTION connect.share_for_user(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.share_for_user(uuid, uuid, uuid) TO tatvaos_app;


-- ----------------------------------------------------------------------------
--  5. The re-check behind a download ticket.
-- ----------------------------------------------------------------------------
--
--  A ticket lasts five minutes and is reused for every range request of a
--  playback. §3 case 8 says a link must stop "immediately" when the switch is
--  flipped off, and revoking must too — so the file route asks again on every
--  request rather than trusting a ticket minted before the change.
--
--  p_user_id is NULL for a link holder. For a signed-in reader it is checked
--  against the grant again: removing somebody from a named list must end
--  their access mid-film, not five minutes later.
CREATE OR REPLACE FUNCTION connect.share_still_allows(
    p_share_id     uuid,
    p_recording_id uuid,
    p_user_id      uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM connect.recording_shares s
         WHERE s.id = p_share_id
           -- §3 case 5: a share for recording A never authorises recording B.
           AND s.recording_id = p_recording_id
           AND connect.share_is_live(s.id)
           AND (
                 (p_user_id IS NULL AND s.level IN ('password', 'public'))
              OR (p_user_id IS NOT NULL AND s.level = 'organisation'
                  AND EXISTS (SELECT 1 FROM core.users u
                               WHERE u.id = p_user_id AND u.tenant_id = s.tenant_id))
              OR (p_user_id IS NOT NULL AND s.level = 'named'
                  AND EXISTS (SELECT 1 FROM connect.recording_share_grants g
                               WHERE g.share_id = s.id
                                 AND g.subject_user_id = p_user_id
                                 AND g.revoked_at IS NULL))
               ));
$$;

REVOKE ALL ON FUNCTION connect.share_still_allows(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.share_still_allows(uuid, uuid, uuid) TO tatvaos_app;


DO $$
BEGIN
    RAISE NOTICE 'connect recording sharing, read side:';
    RAISE NOTICE '    recording_shares_cap_expiry  — tenant read from the meeting';
    RAISE NOTICE '    share_is_live()              — one definition; refuses suspended orgs';
    RAISE NOTICE '    resolve_share_token()        — now executable by tatvaos_app';
    RAISE NOTICE '    share_access_for_user()      — cross-organisation named readers';
    RAISE NOTICE '    share_still_allows()         — the per-request ticket re-check';
END $$;

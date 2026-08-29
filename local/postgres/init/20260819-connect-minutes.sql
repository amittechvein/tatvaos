-- ============================================================================
--  TatvaOS Connect — Minutes of Meeting: the chat, and sending them out.
-- ============================================================================
--
--  "Minutes of meeting, record, transcribe, summarize, and analyze your
--  communications." That is the product. 20260818 built the recording,
--  20260818 made notes exist without one. This one turns notes into a
--  DOCUMENT that leaves the platform: chat kept as part of the record, and a
--  minutes email that reaches the people who were in the room.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THREE DECISIONS.
--
--  1. THE CHAT IS PART OF THE MINUTES, SO IT HAS TO BE STORED.
--     Today chat rides LiveKit's data channel and exists only in the browsers
--     that were open. Every link, every "I'll send that by Friday", every
--     question from somebody who could not unmute — gone the moment the tab
--     closes. Half of what a school actually needs from a class is in there.
--
--     It is stored with the SAME tenancy rule as everything else in Connect:
--     RLS enabled AND forced, scoped through the parent meeting, so a chat
--     line is exactly as reachable as the meeting it belongs to and no more.
--
--  2. SENDING MINUTES IS OFF UNTIL AN ADMINISTRATOR TURNS IT ON.
--     This is outbound mail, to attendees, containing what was said in a
--     meeting — including guests who never agreed to anything. It gets the
--     same treatment recording got: a per-tenant flag defaulting to FALSE, so
--     no deployment starts emailing anybody because a migration ran.
--
--  3. A SEND IS RECORDED BEFORE IT IS ATTEMPTED, AND ONLY ONCE.
--     The lesson from calendar.reminder_sends, which learned it the same way:
--     a worker that records after sending re-sends everything it was in the
--     middle of when it restarted. Minutes that arrive three times are how
--     people build a filter rule for you.
--  ─────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

BEGIN;

-- ============================================================================
--  1. Chat, kept.
-- ============================================================================
CREATE TABLE IF NOT EXISTS connect.meeting_chat (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id    uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    -- ── THE ID THE SENDER'S BROWSER MADE UP, AND WHY IT IS NOT OPTIONAL. ──
    --
    -- Chat travels over LiveKit's data channel, which has no server in the
    -- middle to number things. A GUEST cannot post to this API at all, so
    -- their lines are stored by one of the signed-in clients that received
    -- them — and 'one of' is a race the moment two of them try.
    --
    -- With this, the race is harmless: the INSERT is ON CONFLICT DO NOTHING
    -- against the pair below, so five clients storing the same line produce
    -- one row. Without it, a busy class meeting quietly triples its own
    -- minutes, and nobody notices until they read them.
    client_id     uuid NOT NULL,

    -- The LiveKit identity, which is what survives a rejoin. Not a user id:
    -- guests have no user id and are half the people in the room.
    identity      text NOT NULL,

    -- Denormalised on purpose. A display name is what it was AT THE TIME; a
    -- join to the user table would rewrite history every time somebody
    -- changes their name, and minutes that change after the fact are not
    -- minutes.
    display_name  text NOT NULL,
    is_guest      boolean NOT NULL DEFAULT false,

    body          text NOT NULL,
    sent_at       timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- A chat line is bounded. Without this one paste of a log file becomes the
    -- meeting record and the minutes email becomes unsendable.
    CONSTRAINT meeting_chat_body_len CHECK (char_length(body) BETWEEN 1 AND 4000),
    CONSTRAINT meeting_chat_name_len CHECK (char_length(display_name) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS meeting_chat_meeting_idx
    ON connect.meeting_chat (meeting_id, sent_at);

-- The de-duplication. UNIQUE, not just an index: this is the constraint the
-- ON CONFLICT clause names, and without it the clause has nothing to conflict
-- on and every duplicate lands.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_chat_client_idx
    ON connect.meeting_chat (meeting_id, client_id);

ALTER TABLE connect.meeting_chat ENABLE ROW LEVEL SECURITY;
-- FORCE as well as ENABLE. Without FORCE the owning role bypasses the policy,
-- and the owning role is the one migrations run as — so a table that looks
-- protected is not, from the one connection most likely to be used by hand.
ALTER TABLE connect.meeting_chat FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meeting_chat_tenant ON connect.meeting_chat;
CREATE POLICY meeting_chat_tenant ON connect.meeting_chat
    USING (EXISTS (
        SELECT 1 FROM connect.meetings m
         WHERE m.id = connect.meeting_chat.meeting_id
           AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
    WITH CHECK (EXISTS (
        SELECT 1 FROM connect.meetings m
         WHERE m.id = connect.meeting_chat.meeting_id
           AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

GRANT SELECT, INSERT, DELETE ON connect.meeting_chat TO tatvaos_app;

-- ============================================================================
--  2. Where a minutes email has got to.
-- ============================================================================
ALTER TABLE connect.meeting_notes
    ADD COLUMN IF NOT EXISTS emailed_at      timestamptz,
    ADD COLUMN IF NOT EXISTS email_attempts  integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS email_error     text,
    -- How many people it actually reached. 'Sent' with a count of zero is a
    -- different thing from 'sent to eleven people', and an operator reading a
    -- row deserves to be able to tell them apart.
    ADD COLUMN IF NOT EXISTS email_recipients integer NOT NULL DEFAULT 0;

-- ============================================================================
--  3. The switch. Off.
-- ============================================================================
ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS connect_email_minutes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.tenants.connect_email_minutes IS
    'Send minutes of meeting by email to attendees when notes are ready. '
    'FALSE by default: this is outbound mail about what was said in a room, '
    'to people including guests. An administrator turns it on.';

COMMIT;

-- ============================================================================
--  4. Reads that happen before a tenant is known.
--
--  Same rule as every other worker query in this module: the notes worker runs
--  with no user and no tenant, so under FORCED RLS an ordinary SELECT returns
--  nothing — quietly, while the log says the sweep ran. SECURITY DEFINER with
--  a pinned search_path is the way through, and the search_path is pinned
--  because a definer function that resolves 'meetings' through the CALLER's
--  path is a way to run somebody else's table as the owner.
-- ============================================================================

-- Notes that are ready, whose tenant allows sending, and which have not been
-- emailed yet. Three attempts, then it stops: a permanently bad recipient list
-- must not be retried every minute for the life of the deployment.
-- IDS ONLY, like connect.stuck_recordings and for the same reason: a definer
-- function runs as the owner and bypasses RLS, so the less it hands back the
-- smaller the hole. The worker takes the id, enters that tenant's scope, and
-- reads the row the ordinary way — under the policy, like every other read.
CREATE OR REPLACE FUNCTION connect.pending_minutes_email(p_limit integer DEFAULT 20)
RETURNS TABLE (notes_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, core, pg_catalog
AS $$
    SELECT n.id
      FROM connect.meeting_notes n
      JOIN connect.meetings m ON m.id = n.meeting_id
      JOIN core.tenants t     ON t.id = m.tenant_id
     WHERE n.status = 'ready'
       AND n.emailed_at IS NULL
       AND n.email_attempts < 3
       AND t.connect_email_minutes
       -- Notes generated before this migration are history, not a backlog.
       -- Turning the feature on must not post a year of old meetings to
       -- everyone who ever attended one.
       AND n.generated_at > now() - interval '2 days'
     ORDER BY n.generated_at
     LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

REVOKE ALL ON FUNCTION connect.pending_minutes_email(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.pending_minutes_email(integer) TO tatvaos_app;

-- Which tenant a set of notes belongs to. The worker needs this BEFORE it can
-- enter a tenant scope, so it cannot be an ordinary query — under forced RLS
-- that returns nothing, quietly, while the log says the sweep ran.
CREATE OR REPLACE FUNCTION connect.notes_tenant(p_notes uuid)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, pg_catalog
AS $$
    SELECT m.tenant_id
      FROM connect.meeting_notes n
      JOIN connect.meetings m ON m.id = n.meeting_id
     WHERE n.id = p_notes;
$$;

REVOKE ALL ON FUNCTION connect.notes_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.notes_tenant(uuid) TO tatvaos_app;

-- Who to send to.
--
-- ─────────────────────────────────────────────────────────────────────────
--  ONLY PEOPLE THE PLATFORM ALREADY HAS AN ADDRESS FOR, AND NOT ONE MORE.
--
--  Attendance knows everybody who was in the room, including guests who typed
--  a name into a box. It does not know their email, and it must not guess:
--  the display name 'ravi' is not ravi@anything. So this returns the invited
--  participants who have a real user record, plus nobody else, and the minutes
--  email says how many other people attended without being emailed. An honest
--  count beats a silent omission — the host can forward it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION connect.minutes_recipients(p_meeting uuid)
RETURNS TABLE (email text, display_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, core, pg_catalog
AS $$
    SELECT DISTINCT ON (lower(u.email)) u.email, COALESCE(NULLIF(u.display_name, ''), u.email)
      FROM connect.participants p
      JOIN core.users u ON u.id = p.user_id
     WHERE p.meeting_id = p_meeting
       AND p.user_id IS NOT NULL
       AND p.first_joined_at IS NOT NULL
       AND u.email <> ''
       -- CHECKED AGAINST THE SCHEMA, NOT REMEMBERED. core.users has no
       -- deleted_at column — it has a status, and 'deleted' is one of its
       -- values. The first draft of this function used deleted_at and would
       -- have failed the migration outright, which is the cheap version of
       -- this mistake; the expensive version is a column that exists and
       -- means something else.
       AND u.status NOT IN ('deleted', 'suspended')
     ORDER BY lower(u.email);
$$;

REVOKE ALL ON FUNCTION connect.minutes_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.minutes_recipients(uuid) TO tatvaos_app;

-- How many attended that we could NOT email, so the document can say so.
CREATE OR REPLACE FUNCTION connect.minutes_unreachable(p_meeting uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, core, pg_catalog
AS $$
    SELECT COUNT(*)::integer
      FROM connect.participants p
     WHERE p.meeting_id = p_meeting
       AND p.first_joined_at IS NOT NULL
       AND (p.user_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM core.users u
                            WHERE u.id = p.user_id
                              AND u.status NOT IN ('deleted', 'suspended')
                              AND u.email <> ''));
$$;

REVOKE ALL ON FUNCTION connect.minutes_unreachable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.minutes_unreachable(uuid) TO tatvaos_app;

-- The chat for a meeting, read by the worker before a tenant is set.
CREATE OR REPLACE FUNCTION connect.meeting_chat_lines(p_meeting uuid)
RETURNS TABLE (display_name text, is_guest boolean, body text, sent_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, pg_catalog
AS $$
    SELECT c.display_name, c.is_guest, c.body, c.sent_at
      FROM connect.meeting_chat c
     WHERE c.meeting_id = p_meeting
     ORDER BY c.sent_at, c.id
     -- A cap, because this ends up in an email. Beyond this the minutes link
     -- to the meeting rather than carrying the whole log.
     LIMIT 500;
$$;

REVOKE ALL ON FUNCTION connect.meeting_chat_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.meeting_chat_lines(uuid) TO tatvaos_app;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Connect minutes of meeting.';
    RAISE NOTICE '    connect.meeting_chat        chat kept as part of the record (RLS forced)';
    RAISE NOTICE '    meeting_chat_client_idx     de-duplicates a line five clients all tried to store';
    RAISE NOTICE '    meeting_notes.emailed_at    a send is recorded before it is attempted';
    RAISE NOTICE '    tenants.connect_email_minutes = false — nobody is emailed until an admin says so';
    RAISE NOTICE '';
    RAISE NOTICE '  To turn it on for one organisation:';
    RAISE NOTICE '    UPDATE core.tenants SET connect_email_minutes = true WHERE name = ''<Organisation>'';';
    RAISE NOTICE '';
END $$;

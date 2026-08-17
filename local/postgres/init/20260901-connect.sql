-- ============================================================================
--  TatvaOS Connect — schema (Phase 1)
-- ============================================================================
--
--  Media lives in LiveKit; NOTHING about media lives here. These tables answer
--  "may this person join, who was here, and what happened" — the questions the
--  media server cannot answer because it has no idea what a tenant is.
--
--  ─────────────────────────────────────────────────────────────────────────
--  FOUR DECISIONS THAT ARE EXPENSIVE TO CHANGE LATER, MADE HERE.
--
--  1. THE CODE IS THE CAPABILITY, AND IT IS STORED IN PLAINTEXT.
--     16 CSPRNG bytes, base64url, 22 characters — the same recipe as Space's
--     public links. Space HASHES its tokens because they are single-issue and
--     may be shown once; a meeting code must be re-readable for the meeting's
--     whole life, because the host re-sends the link, prints it on an agenda,
--     and pastes it into a calendar invitation. The code alone grants nothing:
--     a LiveKit token is minted only after the join checks pass, so a leaked
--     code is a doorstep, not a key. Reviewed and chosen deliberately.
--
--  2. PRESENCE IS NOT A FLAG. connect.meeting_events records every join and
--     leave; "who is in the room" and every attendance figure in features
--     135–148 is a query over those rows. A running is_present boolean would
--     be wrong the moment a webhook is missed or replayed, and it cannot
--     answer "how many times did she rejoin" at all.
--
--  3. THE LOBBY TOKEN IS A BEARER CREDENTIAL, SO IT IS HASHED.
--     The opposite of decision 1, for the opposite reason: a waiting guest
--     polls with it, it lives for minutes, and it is never re-shared. Stored
--     as SHA-256 only, the Space rule — no application code ever compares
--     token strings.
--
--  4. TWO COLUMNS LIVE IN CORE'S TABLES AND ARE ADDED HERE ON PURPOSE.
--     core.tenants.allow_connect_guests is the org kill-switch, following the
--     allow_public_links precedent exactly — including that turning it OFF
--     closes existing meetings to guests, not merely new ones.
--     connect.meetings.calendar_event_id is reserved now so that Phase 2's
--     "Connect meeting" toggle on a Calendar event is a feature rather than a
--     migration. Both are flagged to Core in the accompanying patch.
--  ─────────────────────────────────────────────────────────────────────────
--
--  Idempotent and additive, like every migration here: it runs on EVERY
--  deploy, and deploy.sh applies it BEFORE app containers are recreated.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS connect;

-- ----------------------------------------------------------------------------
--  Core's table, one column — the organisation's guest kill-switch.
--
--  Default true because guest join is the point of a meeting link; an
--  organisation that cannot invite outsiders has a worse product than a phone
--  call. Turning it off must take effect on links already in circulation,
--  which is why every guest-facing predicate below reads it rather than
--  checking it once at creation.
-- ----------------------------------------------------------------------------
ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS allow_connect_guests boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN core.tenants.allow_connect_guests IS
    'Whether people with no TatvaOS account may join this organisation''s '
    'meetings. OFF closes EXISTING meeting links, not just new ones.';

-- ----------------------------------------------------------------------------
--  Meetings.
--
--  The LiveKit room is named m-{id} and exists only on the media server: it
--  is never shown to a person and never appears in a URL. What travels is the
--  CODE.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.meetings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- 22 chars of base64url over 16 CSPRNG bytes. Globally unique rather than
    -- per-tenant: the guest path resolves a code BEFORE it knows which tenant
    -- it belongs to, so a collision across tenants would be an oracle.
    code               text NOT NULL,

    title              text NOT NULL DEFAULT 'Meeting',
    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    -- 'instant'   started now, no schedule
    -- 'scheduled' has a start, appears in the upcoming list
    kind               text NOT NULL DEFAULT 'instant'
                       CHECK (kind IN ('instant','scheduled')),
    scheduled_start    timestamptz,
    scheduled_end      timestamptz,
    -- Both the instant and the zone, the same reasoning as calendar.events:
    -- "10:00 in Kolkata" survives a clock change somewhere else.
    timezone           text NOT NULL DEFAULT 'Asia/Kolkata',

    status             text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','active','ended','cancelled')),
    -- Stamped by LiveKit's room_started / room_finished webhooks, not by the
    -- API optimistically: the media server is the authority on whether a
    -- meeting actually happened.
    started_at         timestamptz,
    ended_at           timestamptz,

    -- Argon2id via the platform's IPasswordHasher, never a bare hash. NULL
    -- means no password, which is the common case for internal meetings.
    password_hash      text,

    -- Who has to be admitted before they get media.
    --   'everyone' even colleagues wait
    --   'guests'   people with no account wait  (the default, per brief §7)
    --   'off'      anyone with the code walks in
    waiting_room       text NOT NULL DEFAULT 'guests'
                       CHECK (waiting_room IN ('everyone','guests','off')),
    allow_guests       boolean NOT NULL DEFAULT true,
    locked             boolean NOT NULL DEFAULT false,

    -- Phase 2 seam, reserved now — see decision 4.
    calendar_event_id  uuid REFERENCES calendar.events(id) ON DELETE SET NULL,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT meetings_schedule CHECK (
        scheduled_start IS NULL OR scheduled_end IS NULL
        OR scheduled_end >= scheduled_start),

    -- A scheduled meeting without a start would never appear in any list, and
    -- the bug would present as "my meeting vanished".
    CONSTRAINT meetings_scheduled_has_start CHECK (
        kind <> 'scheduled' OR scheduled_start IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_meetings_code ON connect.meetings (code);
CREATE INDEX IF NOT EXISTS ix_meetings_tenant_start
    ON connect.meetings (tenant_id, scheduled_start);
CREATE INDEX IF NOT EXISTS ix_meetings_tenant_status
    ON connect.meetings (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_meetings_calendar_event
    ON connect.meetings (calendar_event_id) WHERE calendar_event_id IS NOT NULL;

-- ----------------------------------------------------------------------------
--  Participants — one row per person per meeting, colleagues and guests alike.
--
--  NOT a presence table (decision 2). first_joined_at / last_seen_at are a
--  convenience for the participant list; the truth is in meeting_events.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.participants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    -- NULL for a guest, and for a colleague from ANOTHER organisation: in
    -- Phase 1 cross-tenant attendance is guest attendance.
    user_id         uuid REFERENCES core.users(id) ON DELETE SET NULL,
    display_name    text NOT NULL,

    role            text NOT NULL DEFAULT 'participant'
                    CHECK (role IN ('host','cohost','participant')),
    is_guest        boolean NOT NULL DEFAULT false,

    -- The LiveKit identity: user:{userId} or guest:{participantId}. Stable
    -- across rejoins, which is what makes attendance aggregate correctly.
    identity        text NOT NULL,

    first_joined_at timestamptz,
    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per signed-in person per meeting. Partial, because guests all have
-- a NULL user_id and NULL is not equal to NULL in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_meeting_user
    ON connect.participants (meeting_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_meeting_identity
    ON connect.participants (meeting_id, identity);

-- ----------------------------------------------------------------------------
--  The waiting room.
--
--  wait_token_hash only — decision 3. The plaintext exists exactly once, in
--  the join response, and is never written down.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.lobby_requests (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id         uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,
    user_id            uuid REFERENCES core.users(id) ON DELETE CASCADE,
    display_name       text NOT NULL,

    wait_token_hash    text NOT NULL,

    --  waiting   → admitted → claimed   (the happy path)
    --            → denied
    --            → cancelled | expired
    --
    --  'claimed' exists so an admission is ONE-SHOT: the poll that collects
    --  the LiveKit token flips the row, atomically, so a wait token that
    --  leaks after admission cannot be replayed into a second seat.
    status             text NOT NULL DEFAULT 'waiting'
                       CHECK (status IN ('waiting','admitted','claimed','denied','expired','cancelled')),

    decided_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    decided_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_lobby_wait_token
    ON connect.lobby_requests (wait_token_hash);
CREATE INDEX IF NOT EXISTS ix_lobby_meeting_status
    ON connect.lobby_requests (meeting_id, status);

-- ----------------------------------------------------------------------------
--  The event log the LiveKit webhooks feed — decision 2.
--
--  payload keeps the raw body so a later phase can recompute a report without
--  re-living the meetings. webhook_id makes replays free: LiveKit retries, and
--  a retried join must not become a second join.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.meeting_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id   uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    kind         text NOT NULL CHECK (kind IN (
                     'room_started','room_finished',
                     'participant_joined','participant_left',
                     'recording_started','recording_finished')),

    -- NULL on room-level events; the LiveKit identity otherwise.
    identity     text,
    display_name text,

    -- When it happened per LiveKit, NOT when we stored it. A retry hours later
    -- must not move the attendance figures.
    occurred_at  timestamptz NOT NULL,

    webhook_id   text,
    payload      jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_meeting_events_webhook
    ON connect.meeting_events (webhook_id) WHERE webhook_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_meeting_events_meeting
    ON connect.meeting_events (meeting_id, occurred_at);

-- ============================================================================
--  RLS — enabled AND forced, on every table.
--
--  Visibility only, the same division Calendar and Space use: RLS answers
--  "does this row exist for me", the application answers "may I change it"
--  (host and cohost checks live in ConnectEndpoints).
--
--  The nullif(...,'') is not optional. The connection interceptor sends an
--  unset tenant as an EMPTY STRING, and a bare ::uuid cast on '' throws and
--  takes the request with it.
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
    -- The parent carries tenant_id.
    EXECUTE 'ALTER TABLE connect.meetings ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE connect.meetings FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON connect.meetings';
    EXECUTE 'CREATE POLICY tenant_isolation ON connect.meetings
             USING      (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
             WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)';

    -- The children carry NO tenant_id and are scoped through the meeting —
    -- one fewer column to keep in step, and no way for a child to disagree
    -- with its parent about which tenant it belongs to.
    FOREACH t IN ARRAY ARRAY['participants','lobby_requests','meeting_events'] LOOP
        EXECUTE format('ALTER TABLE connect.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE connect.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON connect.%I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON connect.%I '
            'USING (EXISTS (SELECT 1 FROM connect.meetings m '
            '                WHERE m.id = meeting_id '
            '                  AND m.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid))', t);
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA connect TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA connect TO tatvaos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA connect
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- ============================================================================
--  THE GUEST PATH — the only three functions it may call.
--
--  A guest carries no JWT, so app.tenant_id is unset and RLS fails CLOSED:
--  every ordinary query returns nothing. Rather than weaken a policy, the
--  anonymous path goes through SECURITY DEFINER functions with a pinned
--  search_path, exactly as Space's public links do — and the API issues NO
--  other query until it has set the tenant context these return.
--
--  Every one of them takes a code or a HASH. The plaintext wait token never
--  reaches SQL, and no application code ever compares token strings.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  The doorstep. SELECT-only; changes nothing, counts nothing.
--
--  The predicate is written ONCE, here, so a reviewer can diff it against the
--  claim in docs/CONNECT_API.md rather than trusting prose.
--
--  'ended' IS included, deliberately: someone clicking a stale link from last
--  week's invitation is usually a real attendee, and "this meeting has ended"
--  is a kinder and no less safe answer than pretending the link never existed.
--  'cancelled' is NOT included — a cancelled meeting is indistinguishable
--  from a bad code, because the fact of cancellation is the organisation's
--  business, not a stranger's.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.resolve_meeting_code(p_code text)
RETURNS TABLE (meeting_id uuid, tenant_id uuid, title text, status text,
               scheduled_start timestamptz, locked boolean,
               has_password boolean, waiting_room text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT m.id, m.tenant_id, m.title, m.status, m.scheduled_start, m.locked,
           (m.password_hash IS NOT NULL), m.waiting_room
      FROM connect.meetings m
      JOIN core.tenants t ON t.id = m.tenant_id
     WHERE m.code = p_code
       AND m.status IN ('scheduled','active','ended')
       AND m.allow_guests
       AND t.allow_connect_guests
       AND t.status IN ('active','trial');
$$;

REVOKE ALL ON FUNCTION connect.resolve_meeting_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.resolve_meeting_code(text) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  The park-bench poll. SELECT-only, by hash, and it consumes nothing — a
--  guest polls this every two seconds while they wait.
--
--  Requests older than 30 minutes resolve to nothing at all, so an abandoned
--  wait token stops working without a sweeper having to run.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.peek_lobby_request(p_token_hash text)
RETURNS TABLE (request_id uuid, meeting_id uuid, tenant_id uuid,
               status text, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT r.id, r.meeting_id, m.tenant_id, r.status, r.display_name
      FROM connect.lobby_requests r
      JOIN connect.meetings m ON m.id = r.meeting_id
     WHERE r.wait_token_hash = p_token_hash
       AND r.created_at > now() - interval '30 minutes';
$$;

REVOKE ALL ON FUNCTION connect.peek_lobby_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.peek_lobby_request(text) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Collecting an admission. THE UPDATE *IS* THE CHECK.
--
--  Space's consume_public_link shape: the row moves to 'claimed' only if every
--  condition still holds at the instant of the write, and the RETURNING tells
--  the caller whether it won. No check-then-act, so two polls racing cannot
--  both be handed a token, and an admission cannot be replayed into a second
--  seat after the wait token has served its purpose.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.claim_lobby_admission(p_token_hash text)
RETURNS TABLE (request_id uuid, meeting_id uuid, tenant_id uuid, display_name text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    UPDATE connect.lobby_requests r
       SET status = 'claimed'
      FROM connect.meetings m
     WHERE m.id = r.meeting_id
       AND r.wait_token_hash = p_token_hash
       AND r.status = 'admitted'
       AND r.created_at > now() - interval '30 minutes'
       AND m.status IN ('scheduled','active')
       AND NOT m.locked
    RETURNING r.id, r.meeting_id, m.tenant_id, r.display_name;
$$;

REVOKE ALL ON FUNCTION connect.claim_lobby_admission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.claim_lobby_admission(text) TO tatvaos_app;

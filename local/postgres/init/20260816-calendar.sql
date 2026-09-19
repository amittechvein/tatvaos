-- ============================================================================
--  TatvaOS Calendar — schema
-- ============================================================================
--
--  DATE-PREFIXED, and every migration from here is. Numbers collided three
--  times in two days (27 twice, 29 twice) because they require a human to ask
--  another human which number is free. A date and a name cannot collide
--  unless two people work on the same feature on the same day, and every date
--  prefix sorts after every two-digit one, so the deploy order is unchanged.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THREE DECISIONS THAT ARE EXPENSIVE TO CHANGE LATER, MADE HERE.
--
--  1. RECURRENCE IS A RULE, NOT ROWS. "Every weekday, forever" is one row
--     with an RFC 5545 RRULE, expanded at query time inside the window being
--     viewed. Materialising occurrences would mean tens of thousands of rows
--     per event, a decision about how far into the future to generate, and a
--     rewrite of every one of them when somebody moves the meeting.
--
--  2. UTC PLUS THE ORIGINATING ZONE, always both. A 10:00 meeting in Kolkata
--     is 10:00 in Kolkata after the clocks change somewhere else; storing an
--     instant alone loses the intent, and storing local time alone loses the
--     instant. Recurrence expansion needs the zone to place each occurrence.
--
--  3. EXCEPTIONS EXIST FROM DAY ONE. "Just this Tuesday, at 11" and "not this
--     week" are what people actually do to a recurring meeting. Retrofitting
--     them means rewriting every read path, so the table is here now even
--     though the first UI will barely use it.
--  ─────────────────────────────────────────────────────────────────────────
--
--  Interoperability is the whole game: an invitation Gmail and Outlook cannot
--  read is a broken product. Column choices follow iCalendar (RFC 5545) so a
--  VEVENT can be produced without inventing a translation layer — uid,
--  sequence, status, transparency, and the participation statuses are theirs,
--  not ours.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS calendar;

-- ----------------------------------------------------------------------------
--  Calendars. Everyone gets one; teams and the organisation get more.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar.calendars (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    -- NULL for an organisation-wide calendar (Holidays, Company events) —
    -- the same ownership split Space uses, for the same reason: it must
    -- survive the person who created it leaving.
    owner_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    name          text NOT NULL,
    description   text,
    colour        text NOT NULL DEFAULT '#4285f4',

    -- 'personal'      one person's own
    -- 'organisation'  everyone in the tenant sees it
    -- 'resource'      a room, a projector, a school hall — bookable, and it
    --                 is a calendar rather than a separate table because
    --                 "is it free" is exactly the question a calendar answers
    kind          text NOT NULL DEFAULT 'personal'
                  CHECK (kind IN ('personal','organisation','resource')),

    -- The zone events default to. A person's calendar takes theirs; a room
    -- takes the building's.
    timezone      text NOT NULL DEFAULT 'Asia/Kolkata',

    -- Exactly one primary calendar per person: the one new events land in.
    is_primary    boolean NOT NULL DEFAULT false,

    created_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS ix_calendars_tenant_owner
    ON calendar.calendars (tenant_id, owner_user_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_calendars_one_primary
    ON calendar.calendars (owner_user_id)
    WHERE is_primary AND owner_user_id IS NOT NULL AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
--  Who can see or change a calendar.
--
--  'free_busy' is a real level and the most important one: it is what lets
--  "find a time" work without exposing what anyone is actually doing. A
--  colleague may need to know I am busy at 3 without learning that I am in
--  "Interview: replacing Priya".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar.calendar_members (
    calendar_id uuid NOT NULL REFERENCES calendar.calendars(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    role        text NOT NULL DEFAULT 'free_busy'
                CHECK (role IN ('free_busy','reader','writer','owner')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (calendar_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_calendar_members_user
    ON calendar.calendar_members (user_id);

-- ----------------------------------------------------------------------------
--  Events.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar.events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    calendar_id   uuid NOT NULL REFERENCES calendar.calendars(id) ON DELETE CASCADE,

    -- RFC 5545 UID. The identity an external system knows this event by, and
    -- what a reply from Outlook arrives quoting — so it is generated once and
    -- never changes, including when the event moves calendars.
    uid           text NOT NULL,

    -- RFC 5545 SEQUENCE. Bumped on every material change (time, place,
    -- cancellation). Receivers use it to decide whether an update is newer
    -- than what they already hold; without it, a re-sent invitation is
    -- ambiguous and clients ignore it.
    sequence      int NOT NULL DEFAULT 0,

    created_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,
    -- The person the event "belongs" to for replies (RFC 5545 ORGANIZER).
    organiser_user_id  uuid REFERENCES core.users(id) ON DELETE SET NULL,

    title         text NOT NULL,
    description   text,
    location      text,
    meeting_url   text,

    -- Both, deliberately: see decision 2 at the top.
    starts_at     timestamptz NOT NULL,
    ends_at       timestamptz NOT NULL,
    timezone      text NOT NULL DEFAULT 'Asia/Kolkata',

    -- An all-day event is a DATE in iCalendar, not an instant. Kept as a flag
    -- over the timestamps so one column set serves both, and so "15 August"
    -- does not become "14 August, 18:30" for a reader in another zone.
    is_all_day    boolean NOT NULL DEFAULT false,

    -- RFC 5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T000000Z.
    -- NULL for a one-off. Stored verbatim so it can be emitted into a VEVENT
    -- unchanged and parsed by anything that speaks the standard.
    recurrence_rule text,

    -- Does this block the organiser's time? A "reminder: send invoices" event
    -- should not make them look busy to a colleague finding a meeting slot.
    transparency  text NOT NULL DEFAULT 'opaque'
                  CHECK (transparency IN ('opaque','transparent')),

    status        text NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed','tentative','cancelled')),

    -- Who may see the detail, as opposed to the fact that time is taken.
    visibility    text NOT NULL DEFAULT 'default'
                  CHECK (visibility IN ('default','private')),

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,

    CONSTRAINT events_end_after_start CHECK (ends_at >= starts_at)
);

-- The query every single view runs: "this calendar, overlapping this window".
CREATE INDEX IF NOT EXISTS ix_events_window
    ON calendar.events (calendar_id, starts_at, ends_at) WHERE deleted_at IS NULL;

-- Recurring events are fetched separately (their stored start is the FIRST
-- occurrence, which is usually outside the window being viewed).
CREATE INDEX IF NOT EXISTS ix_events_recurring
    ON calendar.events (calendar_id) WHERE recurrence_rule IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_uid ON calendar.events (tenant_id, uid);

-- ----------------------------------------------------------------------------
--  Exceptions to a recurring series — decision 3.
--
--  One row per changed occurrence, keyed by the ORIGINAL start of that
--  occurrence (RFC 5545 RECURRENCE-ID). is_cancelled covers "not this week";
--  the nullable overrides cover "this one is at 11, in the other room".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar.event_exceptions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          uuid NOT NULL REFERENCES calendar.events(id) ON DELETE CASCADE,
    occurrence_starts_at timestamptz NOT NULL,

    is_cancelled      boolean NOT NULL DEFAULT false,
    starts_at         timestamptz,
    ends_at           timestamptz,
    title             text,
    location          text,

    UNIQUE (event_id, occurrence_starts_at)
);

-- ----------------------------------------------------------------------------
--  Attendees.
--
--  user_id for a colleague, email for anyone outside — one table, because an
--  invitation list mixes them freely and splitting it would double every read.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar.event_attendees (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    uuid NOT NULL REFERENCES calendar.events(id) ON DELETE CASCADE,

    user_id     uuid REFERENCES core.users(id) ON DELETE CASCADE,
    email       text NOT NULL,
    display_name text,

    -- RFC 5545 ROLE and PARTSTAT, named as the standard names them so the
    -- VEVENT is a copy rather than a translation.
    role        text NOT NULL DEFAULT 'req-participant'
                CHECK (role IN ('req-participant','opt-participant','chair')),
    status      text NOT NULL DEFAULT 'needs-action'
                CHECK (status IN ('needs-action','accepted','declined','tentative')),

    responded_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),

    UNIQUE (event_id, email)
);

CREATE INDEX IF NOT EXISTS ix_attendees_user
    ON calendar.event_attendees (user_id) WHERE user_id IS NOT NULL;

-- ----------------------------------------------------------------------------
--  Reminders.
--
--  Minutes BEFORE the occurrence, not an absolute time: a reminder on a
--  recurring event has to fire before every occurrence, and an absolute
--  timestamp can only describe one.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar.event_reminders (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       uuid NOT NULL REFERENCES calendar.events(id) ON DELETE CASCADE,
    -- NULL means "everyone on the event"; a user id means one person's own.
    user_id        uuid REFERENCES core.users(id) ON DELETE CASCADE,
    minutes_before int NOT NULL CHECK (minutes_before >= 0 AND minutes_before <= 40320),
    method         text NOT NULL DEFAULT 'notification'
                   CHECK (method IN ('notification','email')),
    UNIQUE (event_id, user_id, minutes_before, method)
);

-- Which reminders have already been sent for which occurrence. Without this a
-- restart re-sends every reminder in the window, and a reminder arriving twice
-- is how people learn to ignore them.
CREATE TABLE IF NOT EXISTS calendar.reminder_sends (
    reminder_id          uuid NOT NULL REFERENCES calendar.event_reminders(id) ON DELETE CASCADE,
    occurrence_starts_at timestamptz NOT NULL,
    sent_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reminder_id, occurrence_starts_at)
);

-- ============================================================================
--  RLS — content tables, enabled AND forced.
--
--  Visibility only. WHO may write to a calendar is decided in the application
--  against calendar_members, the same division Space uses: RLS answers "does
--  this row exist for me", the app answers "may I change it".
--
--  Note the nullif(...,'') on app.user_id — the interceptor sends an unset
--  user as an EMPTY STRING, and a bare ::uuid cast on that throws and takes
--  the request with it.
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['calendars','events'] LOOP
        EXECUTE format('ALTER TABLE calendar.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE calendar.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON calendar.%I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON calendar.%I '
            'USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END LOOP;

    -- The child tables carry no tenant_id; they are scoped through their
    -- parent, exactly as mail.mailbox_permissions is scoped through its
    -- mailbox. One fewer column to keep in step, and no way for a child to
    -- disagree with its parent about which tenant it belongs to.
    FOREACH t IN ARRAY ARRAY['event_attendees','event_reminders','event_exceptions'] LOOP
        EXECUTE format('ALTER TABLE calendar.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE calendar.%I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON calendar.%I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON calendar.%I '
            'USING (EXISTS (SELECT 1 FROM calendar.events e '
            '                WHERE e.id = event_id '
            '                  AND e.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid))', t);
    END LOOP;

    EXECUTE 'ALTER TABLE calendar.calendar_members ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE calendar.calendar_members FORCE  ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON calendar.calendar_members';
    EXECUTE 'CREATE POLICY tenant_isolation ON calendar.calendar_members
             USING (EXISTS (SELECT 1 FROM calendar.calendars c
                             WHERE c.id = calendar_id
                               AND c.tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid))';
END $$;

GRANT USAGE ON SCHEMA calendar TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA calendar TO tatvaos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA calendar
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Everyone gets a primary calendar.
--
--  Backfilled here for anybody who has none. The API creates one wherever a
--  person is created (CalendarProvisioning, from 18 Sept 2026) — and NOT
--  before then, although an earlier version of this comment said it did.
--  Because this file re-runs on every deploy, that gap was invisible: the
--  backfill caught up each time, and production never showed a user without
--  one. Anybody created between two deploys had none until the next. This
--  block stays as the net. Idempotent: a second run inserts nothing.
-- ----------------------------------------------------------------------------
INSERT INTO calendar.calendars (tenant_id, owner_user_id, name, kind, is_primary)
SELECT u.tenant_id, u.id, 'My calendar', 'personal', true
  FROM core.users u
 WHERE u.status <> 'deleted'
   AND NOT EXISTS (
        SELECT 1 FROM calendar.calendars c
         WHERE c.owner_user_id = u.id AND c.is_primary AND c.deleted_at IS NULL);

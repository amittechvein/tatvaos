-- ============================================================================
--  TatvaOS Connect — sharing a recording with someone who was not in the room.
--
--  Reviewed by Core as a draft on 26 August 2026 and landed on 8 September
--  with all four open questions answered. Their answers are recorded beside
--  the code they decided, not in a thread nobody will find again.
--
--  Written against Core's authorisation ruling. Every rule below is his; the
--  shapes are mine.
--
--  POSITION ON THIS DATE, checked rather than assumed. This file creates
--  connect.recording_shares, recording_share_grants, recording_access_log,
--  connect.tenant_settings and four functions; nothing that sorts before it
--  mentions any of them. It depends on connect.recordings (20260818-a),
--  connect.recording_allowed (20260819-d) and core.tenants — all long
--  earlier. 20260908-domains-reserve-bounce.sql shares this date and has no
--  relationship to it in either direction, so the letter here is arbitrary
--  rather than load-bearing, which is worth saying so the next reader does
--  not go looking for the constraint that put it there.
-- ============================================================================
--
--  ─────────────────────────────────────────────────────────────────────────
--  CORRECTION, AND SOMETHING WORSE THAN THE THING I WAS WORRIED ABOUT.
--
--  An earlier version of this header said "infra/scripts/verify-migrations.sh
--  replays the folder from empty and is green on 54 files."
--
--  THAT SCRIPT DID NOT EXIST. I had been asserting it for days and nobody,
--  including me, had run it. The claim went out in the first draft of this
--  proposal. I am leaving the correction here rather than deleting the
--  sentence, because the reason the bug below survived this long is precisely
--  that everyone believed something was already watching for it.
--
--  It exists now, and the first thing it did was fail:
--
--      20260822-connect-captions.sql
--          ERROR: schema "connect" does not exist
--      20260822-connect-retention-default-30.sql
--          ERROR: column "connect_recording_retention_days"
--                 of relation "tenants" does not exist
--
--  Both of those are Core's files, correctly named for the August day they
--  were written, and both depend on Connect tables created by files named
--  20260901-20260910 — August work wearing SEPTEMBER dates. 20260822 sorts
--  before 20260901, so the dependants run first.
--
--  SO THIS IS NOT A FUTURE PROBLEM WITH THIS FILE. A FRESH INSTALL IS BROKEN
--  RIGHT NOW, TODAY, BEFORE THIS MIGRATION EXISTS. Production is fine and
--  cannot notice: the objects already exist there, so these same files re-run
--  clean on every deploy. What is broken is every fresh database — a rebuild,
--  A RESTORE FROM BACKUP, or a new developer's first local setup.
--
--  The README in local/postgres/init describes this exact failure happening
--  once before, with 20260816-space-public-links.sql. It happened again
--  because a filename convention is only as good as the thing enforcing it,
--  and nothing was.
--
--  ─────────────────────────────────────────────────────────────────────────
--  THE FIX, PROVEN RATHER THAN PROPOSED.
--
--  Renaming the ten 20260901-20260910 files to their true August dates makes
--  the folder replay clean. I ran it: 51 files applied into an empty database
--  and then applied a second time, both green. The exercise also turned up a
--  dependency nobody had written down anywhere —
--
--      20260901-connect.sql NEEDS THE `calendar` SCHEMA,
--      so it must sort after 20260816-calendar.sql.
--
--  which is worth knowing before choosing dates, because a true date earlier
--  than the 16th would move it the wrong side of that and fail.
--
--  Two scripts do the work:
--    infra/scripts/rename-migrations-to-true-dates.sh
--        takes each file's true date from `git log --diff-filter=A` rather
--        than from anybody's memory, adds the -a-/-b- letters the README asks
--        for when several land on one day, and refuses to reorder anything
--        silently.
--    infra/scripts/verify-migrations.sh
--        replays the folder into a throwaway database, twice, and says
--        whether a fresh install works.
--
--  ─────────────────────────────────────────────────────────────────────────
--  WHERE THAT ENDED UP, AND WHAT THIS FILE IS NAMED.
--
--  All of the above is settled. The ten files were renamed to their true
--  August dates; four more that had drifted the other way (three Connect,
--  one Mail, all dated September for August work) went in Core's PR #64 on
--  8 September, with the letter rule fixed — letters now continue from the
--  highest already on a date instead of restarting, which was a real bug in
--  my rename script and would have put two files on 20260823-a-.
--
--  The folder replays clean from empty, twice, and there is now a Migrations
--  CI check that fails a pull request whose file sorts before what it needs.
--  The rename script also refuses to run without --i-checked-the-order,
--  because "true date" and "correct order" disagree more often than anyone
--  expects: 20260827-a-mail-app-passwords and its unique-index file were the
--  second such pair inside three weeks.
--
--  This file carries 8 September because that is the day it landed, and it
--  needs no letter for ordering — see the note at the top.
--  ─────────────────────────────────────────────────────────────────────────
--
--  THE FOUR LEVELS, IN THE ORDER THEY GIVE AWAY MORE.
--
--    'organisation'  anyone signed in to the recording's own organisation.
--    'named'         a listed TatvaOS account, in any organisation. Cross
--                    tenant is deliberately allowed; a non-TatvaOS email
--                    address is not, in v1.
--    'password'      anyone holding the link AND the password.
--    'public'        anyone holding the link. Off for the whole organisation
--                    unless an administrator turns it on, and off by default.
--
--  THE BASELINE NEVER MOVES. Participants and the host can already read a
--  recording, they can read it whether or not a share row exists, and no
--  share row can take that away. That answer stays in exactly one place —
--  SeenMeetingAsync in ConnectRecordingEndpoints — and nothing here repeats
--  it. A share row only ever ADDS a reader.
--
--  EXPIRY IS MANDATORY on the two link-bearing levels, defaults to 7 days,
--  and cannot outlive the recording: a link that survives the file it points
--  at is a promise the storage sweep will break. The ceiling is enforced by a
--  trigger rather than a CHECK because it reads another row.
--
--  DELIVERY DOES NOT CHANGE. ConnectDownloadTicket still signs a five-minute
--  ticket and the file route still re-decides authorisation per request. The
--  ticket has never been the authorisation and does not become it here; it
--  gains one more question — "does a live share row cover this reader?" —
--  asked server-side, against these tables, on every request including each
--  GET of a range request.
-- ============================================================================


-- ============================================================================
--  0. The organisation switch that gates level 'public'.
-- ============================================================================
--
--  DECLARED FIRST, and only for a mechanical reason worth writing down: the
--  definer function in section 4b joins this table, and a LANGUAGE sql body
--  is parsed and its references resolved at CREATE time. A table declared in
--  section 6, where this belongs by subject, would make section 4b fail on a
--  fresh install and pass on a re-run — the worst possible shape of bug. The
--  discussion of what this switch MEANS is still in section 6.
--
--  CORE'S ANSWER (8 September) to the question that stopped this file: it is
--  not a shared table at all. Amit's ruling named Space's public-links kill
--  switch as the shape, and that switch is not on core.tenants — it is
--  space.tenant_settings.allow_public_links, a table Space owns. So Connect's
--  switch is Connect's to write, here, with no Core patch and nobody's
--  permission needed. I had been blocked for two weeks on a column that was
--  never going to exist.
--
--  Default FALSE, per the ruling. Space defaults its equivalent to true;
--  that half is deliberately not copied. A missing row reads as off, so there
--  is no backfill and an organisation that has never been asked has not
--  accidentally agreed.
--
--  The three Connect flags already on core.tenants — allow_connect_recording,
--  connect_email_minutes, connect_recording_retention_days — stay where they
--  are. Moving them is a live-table migration with application code reading
--  them, and is not this file's business. New module switches go here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connect.tenant_settings (
    tenant_id  uuid PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
    allow_public_recording_links boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE connect.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.tenant_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON connect.tenant_settings;
CREATE POLICY tenant_isolation ON connect.tenant_settings
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON connect.tenant_settings TO tatvaos_app;

COMMENT ON TABLE connect.tenant_settings IS
    'Per-organisation Connect settings that Connect owns. Today: whether a '
    'recording may be shared by a public link. A missing row means every '
    'setting is at its default, which for a switch that exposes recordings '
    'means off.';

COMMENT ON COLUMN connect.tenant_settings.allow_public_recording_links IS
    'Amit''s ruling, 26 August: level 4 (anyone with the link) is off unless '
    'an organisation turns it on. Read at share time by the endpoint and '
    'AGAIN at read time inside connect.resolve_share_token — switching it off '
    'must kill links that already exist, not merely stop new ones.';


-- ============================================================================
--  1. The share itself. One row per grant, per recording.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connect.recording_shares (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    recording_id        uuid NOT NULL
                          REFERENCES connect.recordings(id) ON DELETE CASCADE,

    -- Denormalised from the recording on purpose. The download route already
    -- holds the meeting id from its own path, so carrying it here lets the
    -- authorisation query refuse a recording id belonging to a DIFFERENT
    -- meeting without a join, in the same query that reads the share. The
    -- drift risk is nil: a recording never changes meetings.
    meeting_id          uuid NOT NULL,

    level               text NOT NULL,

    -- The link secret, for the two levels that have a link. Same shape as
    -- connect.meetings.code — 22 chars of base64url over 16 CSPRNG bytes —
    -- and stored in plaintext for the same reason: it is a capability the
    -- creator re-reads and re-sends, and on its own it mints nothing. It is
    -- NOT the authorisation; it names a share row, which is then read.
    token               text,

    -- Argon2id via the platform's IPasswordHasher, exactly like
    -- connect.meetings.password_hash. Never the password.
    password_hash       text,

    -- NOT NULL for 'password' and 'public'; optional above them. Ceiling
    -- enforced by the trigger below, not here.
    expires_at          timestamptz,

    created_by_user_id  uuid NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- Revoking sets a time; it never deletes the row. "Who could see this,
    -- and when did that stop" is a question somebody will ask after an
    -- incident, and a deleted row cannot answer it.
    revoked_at          timestamptz,

    CONSTRAINT recording_shares_level_check
        CHECK (level IN ('organisation','named','password','public')),

    -- A link exists for exactly the levels that have one.
    CONSTRAINT recording_shares_token_check
        CHECK ((level IN ('password','public')) = (token IS NOT NULL)),

    -- A password exists for exactly the level named after it.
    CONSTRAINT recording_shares_password_check
        CHECK ((level = 'password') = (password_hash IS NOT NULL)),

    -- Expiry is mandatory wherever a link exists.
    CONSTRAINT recording_shares_expiry_check
        CHECK (level NOT IN ('password','public') OR expires_at IS NOT NULL)
);

-- One live share per level per recording. A second 'public' row on the same
-- recording is not a feature, it is two links with different expiries and one
-- of them forgotten. Revoked rows are excluded so a recording can be shared
-- again after a link is pulled.
CREATE UNIQUE INDEX IF NOT EXISTS recording_shares_live_level_idx
    ON connect.recording_shares (recording_id, level)
    WHERE revoked_at IS NULL;

-- The lookup the download route does on every request: token -> share.
CREATE UNIQUE INDEX IF NOT EXISTS recording_shares_token_idx
    ON connect.recording_shares (token)
    WHERE token IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS recording_shares_recording_idx
    ON connect.recording_shares (recording_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE connect.recording_shares IS
    'Who may read a recording BEYOND the people who were in the room. Never '
    'narrows the baseline (participants + host), only widens it. See the '
    'header of 20260826-connect-recording-shares.sql.';


-- ============================================================================
--  2. The named people, for level 'named'.
-- ============================================================================
--
--  CROSS-TENANT IS THE WHOLE POINT AND THE WHOLE PROBLEM.
--
--  Core allowed named grants to reach accounts in other organisations. That
--  breaks the assumption every other query in this module rests on: the row
--  lives in the recording's tenant, and the reader is in their own. An
--  RLS-scoped query run as the reader can never see the row that permits
--  them.
--
--  So the grant is read by ONE security-definer function (section 4), which
--  reads past RLS deliberately, answers a single yes/no, and returns no data.
--  That is the same shape as connect.recording_allowed(), which already
--  exists for the same class of question. Putting it anywhere else — or
--  loosening the RLS policy to permit it — would spread a tenant-crossing
--  read across the module, and it would be found later by somebody who did
--  not know it was one.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connect.recording_share_grants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The RECORDING's tenant, so this row is owned where the recording is.
    tenant_id           uuid NOT NULL,

    share_id            uuid NOT NULL
                          REFERENCES connect.recording_shares(id) ON DELETE CASCADE,

    -- The reader. May belong to another organisation; subject_tenant_id is
    -- stored so a revoke-everything-for-that-org sweep is one statement.
    subject_user_id     uuid NOT NULL,
    subject_tenant_id   uuid NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS recording_share_grants_live_idx
    ON connect.recording_share_grants (share_id, subject_user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS recording_share_grants_subject_idx
    ON connect.recording_share_grants (subject_user_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE connect.recording_share_grants IS
    'Named readers of one share. subject_tenant_id may differ from tenant_id '
    '— cross-organisation grants are permitted, and are the reason section 4 '
    'exists.';


-- ============================================================================
--  3. Every access beyond a participant writes a row.
-- ============================================================================
--
--  CORE'S ANSWER (8 September): this table, Connect-local, as drafted — and
--  he corrected the premise on the way past, which is worth keeping.
--
--  I had assumed core.audit_logs could not hold a link-holder because it
--  wants an actor who is a user. It can: actor_user_id is already nullable.
--  The real obstacles are different and larger. tenant_id is NOT NULL, and
--  AuditWriter takes BOTH tenant and actor from the ambient TenantContext,
--  which an anonymous link read simply does not have — so making it fit means
--  a second entry point on a file every module writes through, to serve one
--  caller. And the audit log is an administrative record: append-only, kept
--  for ever, one row per first-GET on a popular link would turn it into a hit
--  counter.
--
--  So the two tables answer two different questions, deliberately:
--    • THIS table answers "how widely was this recording opened, and from how
--      many places" — high volume, Connect's own, prunable.
--    • core.audit_logs answers "who decided it could be" — the three acts
--      that have a real, named actor: a share created, a share revoked, and
--      the organisation switch flipped. Those are written through AuditWriter
--      with productCode "connect", from the endpoints, not from here.
--
--  A customer asking "who exposed this recording" is answered by the audit
--  log. A customer asking "how far did it get" is answered here. Neither
--  question drowns the other.
--
--  Written on ACCESS, not on grant. Grants also get an ordinary AuditWriter
--  row — those have a real user behind them and belong in the platform log.
-- ============================================================================

CREATE TABLE IF NOT EXISTS connect.recording_access_log (
    id                  bigserial PRIMARY KEY,
    tenant_id           uuid NOT NULL,
    recording_id        uuid NOT NULL,
    share_id            uuid REFERENCES connect.recording_shares(id) ON DELETE SET NULL,

    -- Which of the four let them in. Never null: a row here means a share
    -- authorised the read, because baseline participants are not logged.
    level               text NOT NULL,

    -- The reader when there is one. NULL for a link holder, which is the
    -- entire reason this table exists rather than an audit row.
    subject_user_id     uuid,
    subject_tenant_id   uuid,

    -- Truncated to a /24 (v4) or /48 (v6) before it is written. Enough to say
    -- "this link was opened from twelve different places"; not a location.
    --
    -- CORE'S ANSWER (8 September): the house rule is about the TYPE, not the
    -- precision. text, never inet — Npgsql maps a C# string to text and
    -- PostgreSQL has no implicit text -> inet cast, so an inet column makes
    -- every write fail at runtime rather than at build. core.audit_logs.
    -- actor_ip is text for exactly this reason and carries the same comment.
    --
    -- On precision there is no rule to inherit and the difference is the
    -- point: audit stores a full address because an administrative action
    -- already has a named actor beside it. A public link has no actor at all,
    -- so the address is the only identifying thing in the row and /24 and /48
    -- stay. The name stays address_prefix too — it says on its face that this
    -- is not a full address, which actor_ip would not.
    address_prefix      text,

    -- First GET of a range request only. A two-hour video is dozens of GETs
    -- with one ticket, and one row per GET turns this table into a log of
    -- seeking behaviour, which is not what it is for.
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT recording_access_log_level_check
        CHECK (level IN ('organisation','named','password','public'))
);

CREATE INDEX IF NOT EXISTS recording_access_log_recording_idx
    ON connect.recording_access_log (recording_id, created_at DESC);

COMMENT ON TABLE connect.recording_access_log IS
    'One row per read of a recording by somebody who was NOT in the room. '
    'Participants and hosts are not logged here — they are the baseline. See '
    'section 3 of 20260826-connect-recording-shares.sql.';


-- ============================================================================
--  4. The one function that may cross a tenant boundary.
-- ============================================================================
--
--  Answers exactly one question and returns exactly one boolean. Takes the
--  reader's user id, so it cannot be used to enumerate anything, and returns
--  nothing about the share that let them in.
--
--  It does NOT answer the baseline question. A participant is authorised
--  before this is called, by SeenMeetingAsync, and that stays the only place
--  the baseline lives.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
--  REVISED 26 August, after writing the code that calls it. An earlier draft
--  of this file returned BOOLEAN. That was not enough: every access beyond a
--  participant has to write an audit row naming WHICH share let them in, and
--  a bare yes cannot say. The obvious repair — ask a second query for the
--  share id — does not work, because that query would be RLS-scoped and a
--  cross-organisation grant is exactly the row it cannot see.
--
--  So it returns the share's id, or NULL. Same single tenant-crossing read,
--  one more fact, and the audit requirement becomes possible rather than
--  approximate. If two shares would both let somebody in, the NARROWER one is
--  reported: a person who is named should be logged as named, not as a member
--  of the organisation, because the narrower grant is the one somebody chose
--  deliberately.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS connect.share_allows_user(uuid, uuid, uuid);

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
    SELECT s.id
      FROM connect.recording_shares s
     WHERE s.recording_id = p_recording_id
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND (
             -- Same organisation as the recording.
             (s.level = 'organisation' AND s.tenant_id = p_user_tenant)
             -- Or named, in any organisation.
          OR (s.level = 'named' AND EXISTS (
                SELECT 1 FROM connect.recording_share_grants g
                 WHERE g.share_id = s.id
                   AND g.subject_user_id = p_user_id
                   AND g.revoked_at IS NULL))
           )
     -- Narrower first: 'named' beats 'organisation'.
     ORDER BY CASE s.level WHEN 'named' THEN 0 ELSE 1 END
     LIMIT 1;
$$;

COMMENT ON FUNCTION connect.share_for_user(uuid, uuid, uuid) IS
    'WHICH live share lets this signed-in user read this recording, or NULL. '
    'Reads past RLS deliberately and in one place, because named grants may '
    'cross organisations. Never answers the baseline question — that is '
    'SeenMeetingAsync. Returns the narrowest matching share so the audit row '
    'records the grant somebody actually chose.';


-- ============================================================================
--  4b. Resolving a share LINK, for somebody with no session at all.
-- ============================================================================
--
--  Levels 'password' and 'public' are reached by holding a URL. The holder is
--  anonymous: no session, no tenant, nothing for RLS to scope by. So this is
--  a definer function too — and it has a precedent to copy rather than a
--  decision to make, because connect.resolve_meeting_code() already does
--  exactly this job for a guest arriving at a meeting link.
--
--  Shaped like that one on purpose, including what it does NOT return: no
--  token, no password hash, and no file name. It answers "this link names
--  that recording, at this level, and here is whether a password is needed" —
--  and every one of those is re-checked by the caller before a byte is read.
--
--  A revoked or expired link returns NOTHING, rather than a row with a flag.
--  A caller that forgets to check a flag is a caller that leaks; a caller
--  that forgets to check for no rows gets a null reference on its next line.
-- ============================================================================

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
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       -- THE SWITCH, ENFORCED AT READ TIME. Core's instruction, and it goes
       -- HERE rather than in the download route on purpose: the anonymous
       -- path never touches these tables under RLS, it arrives through this
       -- definer function and nothing else, so this is the one place that
       -- cannot be bypassed by a caller that forgets.
       --
       -- EXISTS, not a join to a boolean: an organisation with no settings
       -- row has never turned this on, and must read as off rather than as
       -- NULL. Flipped off, live 'public' rows stay in place and simply stop
       -- authorising; flipped back on they resume, and the gap is visible in
       -- recording_access_log. No sweep, and nothing to undo.
       --
       -- Levels 'organisation', 'named' and 'password' are untouched by the
       -- switch. It gates the level where the link alone is the whole of the
       -- authorisation.
       AND (s.level <> 'public'
            OR EXISTS (SELECT 1
                         FROM connect.tenant_settings ts
                        WHERE ts.tenant_id = s.tenant_id
                          AND ts.allow_public_recording_links))
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION connect.resolve_share_token(text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
--  4c. Writing the access row, for a reader RLS cannot see.
--
--  Found while wiring section 6 rather than designed alongside it, and it
--  would have failed in production on the first public link: an anonymous
--  link holder has no app.tenant_id, so an ordinary INSERT into
--  recording_access_log is refused by the very policy that protects it. The
--  table is FORCE ROW LEVEL SECURITY like every other, and correctly so.
--
--  So the insert goes through a definer function, for the same reason the
--  read does. The tenant is not taken from the caller — it is taken from the
--  share row, which is the only trustworthy source when there is no session.
--  A caller cannot log against an organisation it does not hold a share for,
--  because it does not supply the tenant at all.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION connect.log_recording_access(
    p_share_id          uuid,
    p_subject_user_id   uuid,
    p_subject_tenant_id uuid,
    p_address_prefix    text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = connect, pg_catalog
AS $$
    INSERT INTO connect.recording_access_log
        (tenant_id, recording_id, share_id, level,
         subject_user_id, subject_tenant_id, address_prefix)
    SELECT s.tenant_id, s.recording_id, s.id, s.level,
           p_subject_user_id, p_subject_tenant_id, p_address_prefix
      FROM connect.recording_shares s
     WHERE s.id = p_share_id;
$$;

REVOKE ALL ON FUNCTION connect.log_recording_access(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.log_recording_access(uuid, uuid, uuid, text) TO tatvaos_app;

COMMENT ON FUNCTION connect.log_recording_access(uuid, uuid, uuid, text) IS
    'Record one read of a recording by somebody who was not in the room. '
    'Definer because the reader may be anonymous and have no tenant for RLS '
    'to scope by. Tenant, recording and level all come from the share row, '
    'never from the caller — a caller supplies only who it was, if anyone, '
    'and the truncated address.';

COMMENT ON FUNCTION connect.resolve_share_token(text) IS
    'Turn a share link into the recording it names, for a holder with no '
    'session. Same shape and same reasoning as resolve_meeting_code. Returns '
    'no row for a revoked or expired link rather than a row with a flag.';


-- ============================================================================
--  5. Expiry may not outlive the recording.
-- ============================================================================
--
--  A CHECK cannot do this: the ceiling is on another row, and it moves when
--  the host puts a retention hold on the recording. A trigger can, and it
--  runs on the write rather than on the read, so a link is never issued that
--  the sweep will silently break.
--
--  The ceiling is the recording's own end of life: its keep_until_at when the
--  host has set a hold, otherwise the organisation's retention window from
--  the day it was made.
--
--  CORE'S ANSWER (8 September): core.tenants.connect_recording_retention_days
--  — integer NOT NULL, CHECK (… IN (7, 30, 90, 180, 365)), declared in
--  20260819-d-connect-retention.sql, default 30 for new organisations since
--  22 August. The invented connect.retention_days() is gone.
--
--  A helper rather than an inline SELECT, on his instruction, and shaped to
--  match its sibling exactly: connect.recording_allowed(uuid) is SECURITY
--  DEFINER with SET search_path = core, pg_temp, so this one is too and sits
--  beside it. Two functions that answer "what has this organisation decided
--  about recordings" should not be reachable by two different mechanisms.
-- ============================================================================

CREATE OR REPLACE FUNCTION connect.recording_retention_days(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT t.connect_recording_retention_days
      FROM core.tenants t
     WHERE t.id = p_tenant_id;
$$;

COMMENT ON FUNCTION connect.recording_retention_days(uuid) IS
    'How many days this organisation keeps a Connect recording. Reads '
    'core.tenants past RLS, the same way and for the same reason as '
    'connect.recording_allowed(uuid) — a definer function so that a caller '
    'scoped to one tenant can still ask about the recording it is holding.';

-- ============================================================================

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

    -- A hold beats the window. With no hold, the recording dies at its own
    -- age plus the organisation's retention — the same arithmetic the sweep
    -- in ConnectNotesWorker uses, so a link cannot be issued that outlives
    -- the file it points at.
    SELECT COALESCE(r.keep_until_at,
                    r.created_at
                      + make_interval(days => connect.recording_retention_days(r.tenant_id)))
      INTO v_ceiling
      FROM connect.recordings r
     WHERE r.id = NEW.recording_id;

    IF v_ceiling IS NOT NULL AND NEW.expires_at > v_ceiling THEN
        -- Clamped, not refused. The person sharing asked for "30 days" from a
        -- short list; telling them the recording only has 11 left is the UI's
        -- job, and failing their click is not an improvement on doing what
        -- they can actually have.
        NEW.expires_at := v_ceiling;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recording_shares_cap_expiry ON connect.recording_shares;
CREATE TRIGGER recording_shares_cap_expiry
    BEFORE INSERT OR UPDATE OF expires_at, recording_id
    ON connect.recording_shares
    FOR EACH ROW EXECUTE FUNCTION connect.recording_shares_cap_expiry();


-- ============================================================================
--  6. The organisation switch — what it means, and where it is enforced.
-- ============================================================================
--
--  The table itself is in section 0, declared early for the mechanical
--  reason recorded there. This is the part that matters to a reader.
--
--  TWO ENFORCEMENT POINTS, and they are not equivalent.
--
--    • SHARE TIME, in the endpoint. Creating a 'public' share against an
--      organisation with the switch off is refused with a sentence a person
--      can act on. This is courtesy, not security: it stops somebody
--      generating a link that would never have worked.
--
--    • READ TIME, inside connect.resolve_share_token (section 4b). This is
--      the security. An administrator who turns the switch off has to kill
--      the links that already exist, not merely stop new ones being made —
--      otherwise the switch means "no NEW exposure", which is not what
--      anybody reading the label would believe.
--
--  It lives inside the definer function rather than in the download route
--  because the anonymous path never touches these tables under RLS: it
--  arrives through that function and nothing else. A condition in the route
--  is a condition the next route can forget. A condition in the function is
--  one every caller inherits.
--
--  Turning it off does not delete anything. Live 'public' rows stay, stop
--  authorising, and start authorising again if the switch returns — and the
--  gap between is visible in recording_access_log, which is the record an
--  administrator will want when they ask what the switch actually did.


-- ============================================================================
--  RLS
-- ============================================================================
--
--  Written here rather than deferred to Core's RLS file. The draft said I
--  would not be the first Connect module to keep its own policies; Core then
--  wrote the policy for connect.tenant_settings inline in the SQL he sent
--  back, which settles the convention in the other direction. A module's own
--  tables carry their own policies.
--
--  All four are FORCE ROW LEVEL SECURITY. FORCE matters here specifically:
--  without it the table owner bypasses the policy, and the owner is the role
--  the migrations run as.
--
--  THE ASYMMETRY THAT MATTERS. recording_share_grants is scoped by tenant_id
--  — the RECORDING's organisation — and deliberately NOT by subject_tenant_id.
--  A named reader in another organisation can read the recording; they must
--  not be able to list who else it was shared with. That is a leak in the
--  opposite direction to the one this file exists to prevent, and it is
--  prevented by what the policy omits rather than by anything it says. Said
--  out loud because the omission is invisible.
--
--  Cross-organisation reads are not an exception to any of this. They happen
--  in the definer functions in section 4, which is the whole reason those
--  functions exist and the reason there are exactly four of them.
-- ============================================================================

ALTER TABLE connect.recording_shares       ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.recording_shares       FORCE  ROW LEVEL SECURITY;
ALTER TABLE connect.recording_share_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.recording_share_grants FORCE  ROW LEVEL SECURITY;
ALTER TABLE connect.recording_access_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect.recording_access_log   FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON connect.recording_shares;
CREATE POLICY tenant_isolation ON connect.recording_shares
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON connect.recording_share_grants;
CREATE POLICY tenant_isolation ON connect.recording_share_grants
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON connect.recording_access_log;
CREATE POLICY tenant_isolation ON connect.recording_access_log
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON connect.recording_shares       TO tatvaos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connect.recording_share_grants TO tatvaos_app;
GRANT SELECT, INSERT                 ON connect.recording_access_log   TO tatvaos_app;
GRANT USAGE, SELECT ON SEQUENCE connect.recording_access_log_id_seq    TO tatvaos_app;


DO $$
BEGIN
    RAISE NOTICE 'connect recording sharing:';
    RAISE NOTICE '    tenant_settings          — allow_public_recording_links, default OFF';
    RAISE NOTICE '    recording_shares         — one row per grant, four levels';
    RAISE NOTICE '    recording_share_grants   — named readers, cross-tenant allowed';
    RAISE NOTICE '    recording_access_log     — one row per read beyond the room';
    RAISE NOTICE '    share_for_user()         — the only tenant-crossing read for a session';
    RAISE NOTICE '    resolve_share_token()    — link holders; enforces the org switch';
    RAISE NOTICE '    log_recording_access()   — writes the row a reader with no tenant cannot';
    RAISE NOTICE '    recording_retention_days() — the ceiling a share may not outlive';
    RAISE NOTICE '    RLS on all four; level 4 stays off until an org turns it on';
END $$;

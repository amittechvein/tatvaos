-- ============================================================================
--  TatvaOS Connect — recording, transcripts and automatic meeting notes.
-- ============================================================================
--
--  20260817-connect.sql said "Media lives in LiveKit; NOTHING about media
--  lives here." That is still true. A recording is not media to this schema:
--  it is a FILE THE ORGANISATION NOW OWNS AND IS PAYING FOR, and a transcript
--  is a document about a meeting. Those are exactly the questions the media
--  server cannot answer, which is why they belong here and the bytes do not.
--
--  ─────────────────────────────────────────────────────────────────────────
--  FIVE DECISIONS, MADE HERE BECAUSE THEY ARE EXPENSIVE TO CHANGE LATER.
--
--  1. RECORDINGS CHARGE THE ORGANISATION, NOT THE PERSON WHO PRESSED RECORD.
--     Brief §5. A meeting belongs to the organisation, so its recording draws
--     on core.storage_pools through core.storage_allocations with
--     product_code = 'connect' — the same route Space's ORGANISATIONAL files
--     take. Deliberately NOT added to core.user_storage_usage: charging the
--     host would move a colleague's remaining space when somebody else
--     records, and would orphan a term's worth of lessons the day a teacher
--     leaves. The reconcile function below DERIVES the figure rather than
--     incrementing a counter, for the reason written out in 17-storage-usage:
--     a derivation cannot drift.
--
--  2. THE FILE PATH IS A KEY, NOT A LOCATION.
--     One flat directory, one opaque file name per recording, no user-supplied
--     component anywhere in it. A path assembled from a meeting title is a
--     path traversal waiting to be written, and a nested layout would need the
--     API to create directories in a volume another container owns. Flat also
--     makes the one-time ownership step (see the compose file) sufficient
--     FOREVER, rather than correct only for directories that already exist.
--
--  3. A TRANSCRIPT CARRIES meeting_id AS WELL AS recording_id.
--     Strictly redundant — the recording knows its meeting. It is here so the
--     RLS policy is byte-identical to the other three child tables: scope
--     through connect.meetings on meeting_id. A two-hop EXISTS would be a
--     second way of expressing tenancy in this schema, and the day the two
--     disagree is the day a transcript leaks. One shape, four tables.
--
--  4. NOTES ARE ONE ROW PER MEETING, REPLACED IN PLACE.
--     Regenerating notes must not leave two answers to "what happened in this
--     meeting" with no rule about which is shown. A UNIQUE constraint on
--     meeting_id makes that structurally impossible instead of a convention.
--
--  5. HOW THE NOTES WERE PRODUCED IS STORED WITH THEM.
--     notes.kind is 'digest' (assembled on this box from the transcript, no
--     model involved) or 'model' (a language model wrote them). The UI says
--     which. A summary that might have been written by a model and might have
--     been assembled by a regex, with no way to tell, is worse than either.
--
--  ─────────────────────────────────────────────────────────────────────────
--  Idempotent and additive, like every migration here: it runs on EVERY
--  deploy, and deploy.sh applies it BEFORE app containers are recreated.
--  Nothing below drops or rewrites anything 20260817-connect.sql created.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Whether an organisation may record at all.
--
--  Core's table, one column, following core.tenants.allow_connect_guests
--  exactly — including that turning it OFF stops recordings that have not
--  started yet, rather than only new meetings. Flagged to Core in the
--  accompanying patch.
--
--  DEFAULT FALSE, and that is the opposite of allow_connect_guests on purpose.
--  Guest join is what a meeting link is FOR, so it defaults on. Recording a
--  room full of people is a decision an organisation should make once,
--  knowingly, having thought about consent and about the storage it will
--  spend — not something that appears because they deployed on a Tuesday.
-- ----------------------------------------------------------------------------
ALTER TABLE core.tenants
    ADD COLUMN IF NOT EXISTS allow_connect_recording boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.tenants.allow_connect_recording IS
    'Whether hosts in this organisation may record meetings. OFF refuses new '
    'recordings on EXISTING meetings too. Default false: recording is a '
    'decision, not a default.';

-- ----------------------------------------------------------------------------
--  Recordings.
--
--  One row per egress. The row is written when LiveKit ACCEPTS the request and
--  hands back an egress id — never before. A row with no egress id would be a
--  recording nothing can stop, and "stop" is the control that matters most in
--  a feature that is quietly capturing people.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.recordings (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id        uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    -- LiveKit's identifier for this egress. The handle for StopEgress, and the
    -- join key for every webhook that follows. Unique so a replayed
    -- egress_started cannot create a second row for one recording.
    egress_id         text NOT NULL,

    -- 'audio' is the default everywhere in the API and in the UI.
    --
    -- Not a shortcut — a measured choice. LiveKit's own admission controller
    -- prices a room-composite video egress at 4 CPU and an audio-only one at
    -- 1 (egress/pkg/config/service.go), because audio-only with no layout and
    -- no custom template takes the SDK path and never launches Chrome
    -- (ShouldUseSDKSource, egress/pkg/config/pipeline.go). On one box also
    -- carrying the SFU, that is the difference between recording a meeting
    -- and disrupting it. Video is offered and is honest about the cost.
    mode              text NOT NULL DEFAULT 'audio'
                      CHECK (mode IN ('audio','video')),

    --  'starting'   accepted by LiveKit, no egress_started webhook yet
    --  'recording'  live
    --  'processing' egress ended, file not yet finalised on disk
    --  'ready'      the file exists and its size is known
    --  'failed'     LiveKit reported an error; `error` says what
    --  'aborted'    stopped before anything was written
    --  'deleted'    the bytes are gone, the row stays so the log is honest
    status            text NOT NULL DEFAULT 'starting'
                      CHECK (status IN ('starting','recording','processing',
                                        'ready','failed','aborted','deleted')),

    -- The file NAME inside the recordings volume — decision 2. Never a
    -- directory, never anything a person typed. The API refuses to serve a
    -- value containing '/' even though nothing can write one.
    file_name         text,
    content_type      text,
    size_bytes        bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    duration_ms       bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),

    started_at        timestamptz,
    ended_at          timestamptz,

    -- Who pressed record. Kept even after they leave the organisation, which
    -- is why it is ON DELETE SET NULL rather than CASCADE: deleting a person
    -- must not delete the evidence that a meeting was recorded.
    requested_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL,

    -- Whether this recording should be transcribed once it is ready. Set at
    -- request time so a host can record without generating notes.
    transcribe        boolean NOT NULL DEFAULT true,

    error             text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- A ready recording must have a file. Anything else is a row that makes
    -- the UI offer a download that 404s.
    CONSTRAINT recordings_ready_has_file CHECK (
        status <> 'ready' OR file_name IS NOT NULL),

    -- Decision 2, enforced rather than trusted.
    CONSTRAINT recordings_file_name_is_flat CHECK (
        file_name IS NULL OR (file_name !~ '/' AND file_name <> '.' AND file_name <> '..'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_recordings_egress
    ON connect.recordings (egress_id);
CREATE INDEX IF NOT EXISTS ix_recordings_meeting
    ON connect.recordings (meeting_id, created_at DESC);
-- The worker's queue: ready, wanted, and not yet transcribed. Partial, so it
-- stays small no matter how many recordings accumulate.
CREATE INDEX IF NOT EXISTS ix_recordings_pending_transcription
    ON connect.recordings (created_at)
    WHERE status = 'ready' AND transcribe;

-- ----------------------------------------------------------------------------
--  Transcripts.
--
--  segments is the timeline: [{ "start": 12.4, "end": 15.9, "text": "...",
--  "speaker": null }]. The speaker key is present and null from day one — see
--  the follow-up note at the foot of this file. Adding it later would be a
--  migration; reserving it costs nothing.
--
--  `text` is the whole transcript as one string, stored alongside the segments
--  rather than derived on read, because that is what the notes step and the
--  search box both actually want and re-joining segments on every read is
--  work repeated for no benefit.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.transcripts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id  uuid NOT NULL REFERENCES connect.recordings(id) ON DELETE CASCADE,
    -- Decision 3. Redundant on purpose.
    meeting_id    uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    --  'queued'      waiting for the worker
    --  'running'     being transcribed
    --  'ready'       text is present
    --  'failed'      it was attempted and did not work; `error` says why
    --  'unavailable' no transcription service is configured. NOT a failure —
    --                the distinction matters, because "we tried and it broke"
    --                and "nobody switched this on" need different answers and
    --                a single 'failed' would send you looking for a bug.
    status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','ready','failed','unavailable')),

    provider      text,
    model         text,
    language      text,

    text          text,
    segments      jsonb NOT NULL DEFAULT '[]'::jsonb,

    duration_ms   bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
    attempts      integer NOT NULL DEFAULT 0,
    error         text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One transcript per recording. A second attempt updates the row it already
-- has; it does not add a competing answer.
CREATE UNIQUE INDEX IF NOT EXISTS ux_transcripts_recording
    ON connect.transcripts (recording_id);
CREATE INDEX IF NOT EXISTS ix_transcripts_meeting
    ON connect.transcripts (meeting_id, created_at DESC);

-- ----------------------------------------------------------------------------
--  Meeting notes — decisions 4 and 5.
--
--  The lists are jsonb arrays of plain strings rather than child tables. They
--  are written once by a machine, read as a block, and never queried
--  individually; three more tables and three more RLS policies would buy
--  nothing and would be three more places for tenancy to go wrong.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connect.meeting_notes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id    uuid NOT NULL REFERENCES connect.meetings(id) ON DELETE CASCADE,

    status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','ready','failed')),

    -- Decision 5. 'digest' was assembled from the transcript on this server
    -- with no model involved; 'model' was written by a language model. The
    -- screen says which, in those words.
    kind          text NOT NULL DEFAULT 'digest'
                  CHECK (kind IN ('digest','model')),

    provider      text,
    model         text,

    summary       text,
    key_points    jsonb NOT NULL DEFAULT '[]'::jsonb,
    decisions     jsonb NOT NULL DEFAULT '[]'::jsonb,
    action_items  jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{ "name": "...", "seconds": 412, "turns": 37 }] — who actually spoke,
    -- and for how long. Computed from the transcript timeline, so it is true
    -- even when no model is configured.
    speakers      jsonb NOT NULL DEFAULT '[]'::jsonb,

    error         text,
    generated_at  timestamptz,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Decision 4: one set of notes per meeting, replaced in place.
CREATE UNIQUE INDEX IF NOT EXISTS ux_meeting_notes_meeting
    ON connect.meeting_notes (meeting_id);

-- ----------------------------------------------------------------------------
--  connect.meeting_events.kind has a CHECK, and egress events are not in it.
--
--  Without this the FIRST egress webhook would fail its check constraint. That
--  would no longer be silent — the handler logs an error and answers 500 since
--  the tenancy fix — but it would mean every recording stayed 'starting'
--  forever while LiveKit retried a request that could never succeed.
--
--  Widened rather than dropped: the constraint is what stops a typo in the
--  webhook handler writing an event kind nothing will ever read.
--
--  'egress_updated' is included because LiveKit sends it on every state
--  change, and an event we deliberately ignore still has to be storable —
--  otherwise "ignore it" means "return 500 and be retried forever".
-- ----------------------------------------------------------------------------
--  The constraint is DISCOVERED rather than named. PostgreSQL generated the
--  name from the column, so it is almost certainly meeting_events_kind_check —
--  but a DROP CONSTRAINT IF EXISTS against a guessed name that is wrong
--  succeeds silently and leaves the old constraint in place, which is the
--  worst of both: no error here, and a 500 on the first recording.
DO $$
DECLARE c text;
BEGIN
    FOR c IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE ns.nspname = 'connect'
           AND rel.relname = 'meeting_events'
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) LIKE '%room_started%'
    LOOP
        EXECUTE format('ALTER TABLE connect.meeting_events DROP CONSTRAINT %I', c);
    END LOOP;

    ALTER TABLE connect.meeting_events ADD CONSTRAINT meeting_events_kind_check
        CHECK (kind IN (
            'room_started','room_finished',
            'participant_joined','participant_left',
            'recording_started','recording_finished',
            'egress_started','egress_updated','egress_ended'));
EXCEPTION WHEN duplicate_object THEN
    -- Already widened by an earlier run of this migration.
    NULL;
END $$;

-- ============================================================================
--  RLS — enabled AND forced, exactly as 20260817-connect.sql does it.
--
--  All three tables are children scoped through connect.meetings on
--  meeting_id, which is why connect.transcripts carries one (decision 3). The
--  loop below is a copy of that migration's on purpose: same array, same
--  format string, same nullif(...,'') guard. A second, cleverer expression of
--  the same rule is how two tables end up disagreeing about tenancy.
-- ============================================================================
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['recordings','transcripts','meeting_notes'] LOOP
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

-- The schema-level grant in 20260817 used GRANT ... ON ALL TABLES, which
-- applies only to tables that existed when it ran. ALTER DEFAULT PRIVILEGES
-- covers tables created by the SAME role afterwards — true here, but stated
-- explicitly rather than relied upon, because a grant that is merely probable
-- presents as "the API cannot see its own new tables" after a deploy.
GRANT SELECT, INSERT, UPDATE, DELETE
    ON connect.recordings, connect.transcripts, connect.meeting_notes
    TO tatvaos_app;

-- ============================================================================
--  THE WORKER'S TWO CROSS-TENANT READS.
--
--  The notes worker is a background service with no request, no user and no
--  JWT, so app.tenant_id is unset and forced RLS returns nothing — the same
--  wall the LiveKit webhook hit, and the same answer: a SECURITY DEFINER
--  function with a pinned search_path that returns IDS ONLY.
--
--  Neither of these returns a byte of content. The worker takes the ids, sets
--  the tenant context for that meeting, and does all its real reading and
--  writing through ordinary RLS-checked queries. So a bug in the worker is
--  contained by the same policy as everything else; only the "which tenant
--  should I be" question is answered outside it.
-- ============================================================================

--  EVERY ONE OF THEM RETURNS A SINGLE COLUMN OF IDS, AND THAT IS DELIBERATE.
--
--  A three-column set would be one round trip instead of two, and it would
--  make the worker depend on EF materialising an unmapped multi-column type.
--  This codebase has no precedent for that — every raw query in it is
--  Database.SqlQuery<Guid>, a scalar, the shape webhook_meeting_tenant already
--  established. A worker that runs once a minute does not need the round trip
--  back, and it does need to be built out of a pattern that is already known
--  to work against the real Npgsql provider rather than one that looks right.

-- ----------------------------------------------------------------------------
--  What needs transcribing. Ready, wanted, and either never attempted or
--  attempted and left queued.
--
--  LIMIT is the caller's, but a hard cap of 50 is applied here so a stuck
--  queue cannot make one tick of the worker try to hold every recording on
--  the platform in memory.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.pending_transcription(p_limit integer DEFAULT 10)
RETURNS TABLE (recording_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    SELECT r.id
      FROM connect.recordings r
      LEFT JOIN connect.transcripts t ON t.recording_id = r.id
     WHERE r.status = 'ready'
       AND r.transcribe
       AND (t.id IS NULL OR (t.status = 'queued' AND t.attempts < 3))
     ORDER BY r.created_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.pending_transcription(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.pending_transcription(integer) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  What needs notes: a meeting with a ready transcript whose notes are
--  missing or still queued.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.pending_notes(p_limit integer DEFAULT 10)
RETURNS TABLE (meeting_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    SELECT DISTINCT t.meeting_id
      FROM connect.transcripts t
      LEFT JOIN connect.meeting_notes n ON n.meeting_id = t.meeting_id
     WHERE t.status = 'ready'
       AND (n.id IS NULL OR n.status = 'queued')
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.pending_notes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.pending_notes(integer) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Recordings the media server never finished telling us about.
--
--  LiveKit's webhook is the normal path and a webhook can be lost — that is
--  not hypothetical in this module, whose event log sat empty for a day. Any
--  recording left mid-flight past the cutoff is asked about directly through
--  ListEgress, so a missed callback costs a delay rather than a recording that
--  never appears.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.stuck_recordings(
    p_before timestamptz, p_limit integer DEFAULT 5)
RETURNS TABLE (recording_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    SELECT r.id
      FROM connect.recordings r
     WHERE r.status IN ('starting','recording','processing')
       AND r.updated_at < p_before
     ORDER BY r.updated_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 50);
$$;

REVOKE ALL ON FUNCTION connect.stuck_recordings(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.stuck_recordings(timestamptz, integer) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Which organisation a recording belongs to. One column, keyed by primary
--  key, the narrowest possible read — exactly connect.webhook_meeting_tenant,
--  one join further along.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.recording_tenant(p_recording uuid)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    SELECT m.tenant_id
      FROM connect.recordings r
      JOIN connect.meetings m ON m.id = r.meeting_id
     WHERE r.id = p_recording;
$$;

REVOKE ALL ON FUNCTION connect.recording_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.recording_tenant(uuid) TO tatvaos_app;

-- ============================================================================
--  STORAGE — decision 1.
--
--  Derived, never incremented, for the three reasons written out in
--  17-storage-usage.sql: it crosses tenants, it crosses lanes, and it is
--  self-correcting. A crash between deleting a file and decrementing a counter
--  loses a delta forever and nothing ever notices; a derivation recomputes
--  from the truth every time.
--
--  'deleted' recordings are excluded because their bytes are genuinely gone.
--  That is the OPPOSITE of Space's rule, where trashed files still count —
--  and deliberately so: Space trashes for 30 days and the bytes are still on
--  the disk, whereas deleting a recording here unlinks the file in the same
--  transaction. Charging for a file that no longer exists would be the
--  "delete everything and you are still full" complaint with no explanation.
--
--  This writes core.storage_allocations, which is Core's table. That is the
--  documented contract of the column — "Maintained incrementally by each
--  product", one row per (tenant, product_code) — and 'connect' is already in
--  core.products (28-product-catalogue.sql). It is flagged to Core in the
--  accompanying patch all the same.
-- ============================================================================
CREATE OR REPLACE FUNCTION connect.reconcile_recording_storage(p_tenant uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
DECLARE
    v_rows integer;
BEGIN
    WITH usage AS (
        SELECT m.tenant_id, COALESCE(SUM(r.size_bytes), 0)::bigint AS used
          FROM connect.recordings r
          JOIN connect.meetings m ON m.id = r.meeting_id
         WHERE r.status <> 'deleted'
           AND (p_tenant IS NULL OR m.tenant_id = p_tenant)
         GROUP BY m.tenant_id
    )
    INSERT INTO core.storage_allocations (tenant_id, product_code, used_bytes, updated_at)
    SELECT u.tenant_id, 'connect', u.used, now()
      FROM usage u
    ON CONFLICT (tenant_id, product_code) DO UPDATE
        SET used_bytes = EXCLUDED.used_bytes,
            updated_at = now()
      -- Skip the write when the number has not moved, so an idle platform does
      -- not rewrite every row on every pass.
      WHERE core.storage_allocations.used_bytes IS DISTINCT FROM EXCLUDED.used_bytes;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- A tenant whose recordings have all been deleted produces no row above
    -- and would keep its last non-zero figure forever, reading as permanently
    -- full. Same repair as core.reconcile_storage_usage does for mail.
    UPDATE core.storage_allocations a
       SET used_bytes = 0, updated_at = now()
     WHERE a.product_code = 'connect'
       AND (p_tenant IS NULL OR a.tenant_id = p_tenant)
       AND a.used_bytes <> 0
       AND NOT EXISTS (
            SELECT 1
              FROM connect.recordings r
              JOIN connect.meetings m ON m.id = r.meeting_id
             WHERE m.tenant_id = a.tenant_id
               AND r.status <> 'deleted');

    RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION connect.reconcile_recording_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.reconcile_recording_storage(uuid) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  How much room the organisation has left, ACROSS EVERY PRODUCT.
--
--  Checked before a recording is allowed to start. Not "how much has Connect
--  used" — the pool is shared, so a recording that fits Connect's own figure
--  can still be the thing that fills the disk, and on this box a full disk
--  stops Mail as well. One filesystem, one gate.
--
--  RETURNS -1 FOR "NO POOL CONFIGURED", WHICH THE CALLER READS AS UNLIMITED.
--  That is not a decision taken here: it is what every other product on this
--  platform already does with an unset pool, and inventing a different answer
--  in Connect would mean two rules for the same question. Changing it belongs
--  in Core, once, for everybody.
--
--  A separate scalar function rather than arithmetic in the API, because the
--  API cannot read core.storage_pools at all — it is another lane's table and
--  the app role has no business selecting from it directly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.storage_headroom(p_tenant uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, core, pg_temp
AS $$
    SELECT CASE
        WHEN COALESCE((SELECT p.total_bytes FROM core.storage_pools p
                        WHERE p.tenant_id = p_tenant), 0) = 0
        THEN -1::bigint
        ELSE GREATEST(
            (SELECT p.total_bytes FROM core.storage_pools p WHERE p.tenant_id = p_tenant)
            - COALESCE((SELECT SUM(a.used_bytes) FROM core.storage_allocations a
                         WHERE a.tenant_id = p_tenant), 0),
            0)::bigint
    END;
$$;

REVOKE ALL ON FUNCTION connect.storage_headroom(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.storage_headroom(uuid) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  What Connect itself is using, for the screen that shows it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.recording_bytes(p_tenant uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = connect, pg_temp
AS $$
    SELECT COALESCE(SUM(r.size_bytes), 0)::bigint
      FROM connect.recordings r
      JOIN connect.meetings m ON m.id = r.meeting_id
     WHERE m.tenant_id = p_tenant
       AND r.status <> 'deleted';
$$;

REVOKE ALL ON FUNCTION connect.recording_bytes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.recording_bytes(uuid) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  May this organisation record at all? One column, read through a definer
--  function so Connect never selects from core.tenants directly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION connect.recording_allowed(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
    SELECT COALESCE((SELECT t.allow_connect_recording FROM core.tenants t
                      WHERE t.id = p_tenant), false);
$$;

REVOKE ALL ON FUNCTION connect.recording_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connect.recording_allowed(uuid) TO tatvaos_app;

-- ============================================================================
--  Backfill and report.
-- ============================================================================
DO $$
DECLARE
    v_rows integer;
BEGIN
    SELECT connect.reconcile_recording_storage() INTO v_rows;
    RAISE NOTICE '';
    RAISE NOTICE '  Connect recording schema ready.';
    RAISE NOTICE '    recordings / transcripts / meeting_notes — RLS enabled AND forced';
    RAISE NOTICE '    storage charged to the ORG pool as product_code ''connect'' (% row(s) reconciled)', v_rows;
    RAISE NOTICE '    core.tenants.allow_connect_recording defaults FALSE — switch it on per organisation';
    RAISE NOTICE '';
END $$;

-- ============================================================================
--  KNOWN GAPS, WRITTEN DOWN RATHER THAN DISCOVERED LATER.
--
--  SPEAKER ATTRIBUTION. transcripts.segments reserves a "speaker" key and it
--  is null today. A room-composite recording is one mixed audio stream, so
--  there is nothing in it to attribute. The right fix is NOT diarisation — it
--  is LiveKit's per-track egress, one file per participant, where attribution
--  is exact and free because LiveKit already knows whose track it is. That
--  costs 0.5 CPU per participant against 1 for the whole room, so it is a
--  real trade and a separate decision. The column shape does not change
--  either way.
--
--  RETENTION. Nothing here expires a recording. An organisation that records
--  every lesson will fill its pool, and the only remedy today is a person
--  deleting recordings by hand. A retention policy needs a per-tenant setting
--  and a purge worker, and it needs someone to decide the default — which is
--  a product decision about a customer's data, not one to slip into a
--  migration.
-- ============================================================================

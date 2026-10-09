-- ============================================================================
--  migration.jobs / migration.items - the Google Workspace migration's job
--  runner (docs/GOOGLE_MIGRATION_DESIGN.md, sections 3.2 and 4, phase 0)
-- ============================================================================
--
--  WHY A TABLE. Every worker in apps/api/Workers is a periodic sweeper over a
--  domain table; none of them gives a durable unit of work that survives a
--  restart and resumes where it stopped. "Migrate this person's mail, 40,000
--  messages, resume from 12,350" needs somewhere to live. Mr. Singh, 8 Oct
--  2026: "one table, one worker, this purpose" - this is NOT a general queue.
--
--  migration.jobs   one row per person per data type. Its state, its counts,
--                   the source's own resume token (cursor) and the last error.
--  migration.items  one row per source item handled: the ledger that means a
--                   re-run never fetches the same item twice and never skips
--                   one. Unique on (job_id, source_id).
--
--  RESUMING. A runner CLAIMS a job by writing a lease (lease_owner,
--  lease_expires_at) and renews it after every batch. A batch's items and the
--  job's new cursor and counts are written in ONE transaction, so a process
--  killed mid-batch leaves the job exactly as it was after the previous batch;
--  when its lease runs out another runner (or the same one, restarted) claims
--  it and carries on from that cursor. tests/migration/test-job-runner.sh
--  kills the API with SIGKILL mid-run and asserts the job completes with every
--  item exactly once.
--
--  ISOLATION. Both tables are tenant-owned, with FORCED row-level security and
--  an EF query filter (tests/tenant-filters). items -> jobs is a composite FK
--  on (tenant_id, job_id), so an item can never hang off another
--  organisation's job: FK checks do not go through RLS. The target person is
--  pinned the same way, against core.users (tenant_id, id).
--
--  The ONE cross-organisation question - which organisations have a job ready
--  to run - is migration.job_tenants(), a SECURITY DEFINER function returning
--  organisation ids and nothing else (the calendar.reminder_tenants pattern,
--  decision 0007). The worker then enters each organisation and reads its
--  jobs under RLS.
--
--  NO CREDENTIALS HERE, deliberately. The Google service-account key is
--  section 9 of the design and goes to Mr. Singh before any code stores one.
--  last_error is written by the runner from exception TYPE and message only,
--  truncated, and must never carry a token or key (the runner's comment says
--  how it ensures that).
--
--  source 'synthetic' is a fake Google that produces numbered items. It exists
--  so the runner's resume and dedupe can be proven with nothing outside the
--  machine; the API refuses to run it outside Development.
--
--  Additive and re-runnable.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS migration;
GRANT USAGE ON SCHEMA migration TO tatvaos_app;

-- Target for the composite foreign key below. Already created by
-- 20260924-b-hire-job-openings.sql; repeated so this file does not depend on
-- a Hire file staying where it is.
CREATE UNIQUE INDEX IF NOT EXISTS ux_core_users_tenant_id ON core.users (tenant_id, id);

-- ---- migration.jobs --------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration.jobs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,

    source           text NOT NULL DEFAULT 'google_workspace'
                     CHECK (source IN ('google_workspace', 'synthetic')),
    data_type        text NOT NULL
                     CHECK (data_type IN ('mail', 'contacts', 'calendar', 'drive')),
    -- The person in the SOURCE system, e.g. their Google primary address.
    source_user      text NOT NULL CHECK (length(btrim(source_user)) BETWEEN 1 AND 320),
    -- Who it lands with here. NULL until someone has matched the Google
    -- person to a TatvaOS person; a job with no target is never claimed.
    target_user_id   uuid,

    -- 'planned': enrolled, not yet started. The runner never claims it; an
    -- administrator starting the migration moves it to 'pending'. Enrolling a
    -- whole organisation from Google's directory must not, by itself, start
    -- reading everybody's mail.
    state            text NOT NULL DEFAULT 'planned'
                     CHECK (state IN ('planned', 'pending', 'running', 'completed', 'failed', 'cancelled')),

    -- The source's own resume token (Gmail page token, Drive change token,
    -- or for 'synthetic' the last item number). Opaque to everything but the
    -- step that wrote it. NULL = start from the beginning.
    cursor           text CHECK (cursor IS NULL OR length(cursor) <= 4096),

    -- Counts. items_total is the source's own estimate and may be NULL or
    -- wrong; the done/skipped/failed counts are what was actually written.
    items_total      bigint CHECK (items_total IS NULL OR items_total >= 0),
    items_done       bigint NOT NULL DEFAULT 0 CHECK (items_done    >= 0),
    items_skipped    bigint NOT NULL DEFAULT 0 CHECK (items_skipped >= 0),
    items_failed     bigint NOT NULL DEFAULT 0 CHECK (items_failed  >= 0),
    bytes_done       bigint NOT NULL DEFAULT 0 CHECK (bytes_done    >= 0),

    -- Retries. A failed batch puts the job back to 'pending' with
    -- next_attempt_at in the future, until attempts runs out; then 'failed'.
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_error       text CHECK (last_error IS NULL OR length(last_error) <= 2000),

    -- The lease. Set when a runner claims the job, renewed after each batch,
    -- cleared when the job leaves 'running'. A 'running' job whose lease has
    -- expired belongs to a runner that died, and may be claimed again.
    lease_owner      text CHECK (lease_owner IS NULL OR length(lease_owner) <= 200),
    lease_expires_at timestamptz,

    created_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    finished_at      timestamptz,

    -- One row per person per data type: a re-run reuses the row (and its
    -- items ledger, which is what makes it idempotent), it does not add one.
    CONSTRAINT ux_migration_jobs_person UNIQUE (tenant_id, source, data_type, source_user),
    -- Target for migration.items' composite FK.
    CONSTRAINT ux_migration_jobs_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT fk_migration_job_target FOREIGN KEY (tenant_id, target_user_id)
        REFERENCES core.users (tenant_id, id) ON DELETE SET NULL (target_user_id),
    -- 'running' <=> leased. A running job nobody holds, or a lease on a job
    -- that is not running, is a runner bug, refused here rather than found.
    CONSTRAINT ck_migration_job_lease CHECK (
        (state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CONSTRAINT ck_migration_job_finished CHECK (
        (state IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

-- The claim query: ready jobs in one organisation, oldest due first.
CREATE INDEX IF NOT EXISTS ix_migration_jobs_ready
    ON migration.jobs (tenant_id, next_attempt_at)
    WHERE state IN ('pending', 'running');

COMMENT ON TABLE migration.jobs IS
    'Google Workspace migration: one job per person per data type, resumable '
    '(cursor + lease). 9 Oct 2026, design doc section 3.2. Holds no credentials.';

GRANT SELECT, INSERT, UPDATE, DELETE ON migration.jobs TO tatvaos_app;

ALTER TABLE migration.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.jobs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.jobs;
CREATE POLICY tenant_isolation ON migration.jobs
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- migration.items -------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration.items (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        uuid NOT NULL,
    job_id           uuid NOT NULL,

    -- The source's id for the item (Gmail message id, Drive file id ...).
    source_id        text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 1024),
    -- What makes two DIFFERENT source items the same thing here. For mail,
    -- the Message-ID header (design section 5: a message must not arrive
    -- twice). NULL where the type has no such notion.
    dedupe_key       text CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 1024),

    -- done      written here
    -- skipped   not written, on purpose (a duplicate by dedupe_key, a
    --           synthetic Gmail folder ...); reason says why
    -- failed    could not be written; reason says why, and the job goes on
    outcome          text NOT NULL CHECK (outcome IN ('done', 'skipped', 'failed')),
    reason           text CHECK (reason IS NULL OR length(reason) <= 500),
    bytes            bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_migration_item_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES migration.jobs (tenant_id, id) ON DELETE CASCADE,
    -- Never fetch the same item twice: the runner inserts with ON CONFLICT DO
    -- NOTHING on this, and a re-run of a batch is therefore harmless.
    CONSTRAINT ux_migration_items_source UNIQUE (job_id, source_id)
);

-- Dedupe lookups: has anything in this job already been written under this key?
CREATE INDEX IF NOT EXISTS ix_migration_items_dedupe
    ON migration.items (job_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

COMMENT ON TABLE migration.items IS
    'Google Workspace migration: the ledger of source items handled per job. '
    'Unique (job_id, source_id) is what makes a resumed or re-run job idempotent.';

GRANT SELECT, INSERT, UPDATE, DELETE ON migration.items TO tatvaos_app;

ALTER TABLE migration.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.items;
CREATE POLICY tenant_isolation ON migration.items
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- migration.job_tenants() ----------------------------------------------
--
--  SUPERSEDED on every deploy by 20261009-z-migration-grants.sql, which
--  re-creates it requiring an active Google grant (decision 0019 §1). Kept
--  here so this file builds on its own; change the later one.
--
--  Which organisations have a job the runner could claim now: pending and due,
--  or running with a lease that has expired (its runner died). Live
--  organisations only - a suspended organisation's migration waits.
--
--  Returns ids and nothing else: no people, no addresses, no counts. It runs
--  as its owner, so RLS does not apply inside it; its body is the only guard.
--  search_path pinned with pg_temp last, as every definer here.
CREATE OR REPLACE FUNCTION migration.job_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, migration, core, pg_temp
AS $$
    SELECT DISTINCT j.tenant_id
      FROM migration.jobs j
      JOIN core.tenants t ON t.id = j.tenant_id
     WHERE t.status IN ('active', 'trial')
       AND j.target_user_id IS NOT NULL
       AND (   (j.state = 'pending' AND j.next_attempt_at <= now())
            OR (j.state = 'running' AND j.lease_expires_at <  now()))
$$;

REVOKE ALL ON FUNCTION migration.job_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION migration.job_tenants() TO tatvaos_app;

-- ---- Say what was built ----------------------------------------------------
DO $$
DECLARE
    pol int;
    forced int;
    pinned int;
    definer int;
BEGIN
    SELECT count(*) INTO pol FROM pg_policies
     WHERE schemaname = 'migration' AND tablename IN ('jobs', 'items') AND policyname = 'tenant_isolation';
    SELECT count(*) INTO forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'migration' AND c.relname IN ('jobs', 'items')
       AND c.relrowsecurity AND c.relforcerowsecurity;
    SELECT count(*) INTO pinned FROM pg_constraint
     WHERE conrelid IN ('migration.jobs'::regclass, 'migration.items'::regclass)
       AND contype = 'f' AND array_length(conkey, 1) = 2;
    SELECT count(*) INTO definer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'migration' AND p.proname = 'job_tenants' AND p.prosecdef;
    IF pol <> 2 OR forced <> 2 OR pinned <> 2 OR definer <> 1 THEN
        RAISE WARNING 'migration.jobs/items are not fenced as intended (policies %, forced %, tenant-pinned FKs %, definer %; want 2, 2, 2, 1)',
            pol, forced, pinned, definer;
    END IF;
END $$;

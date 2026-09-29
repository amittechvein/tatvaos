-- ============================================================================
--  The two tables with NO isolation layer at all (decision 0007)
-- ============================================================================
--
--  Mr. Singh, 24 and 27 Sept 2026: core.departments "carries no row-level
--  security at all - worse than Connect's one layer - and 0007 absorbs it";
--  calendar.reminder_sends is "the same shape ... no isolation at any layer and
--  nothing explaining why. Put the two in one PR: the zero-layer tables get a
--  policy each." Found by tests/tenant-filters (PR 288) and the 0007 sweep.
--
--  core.departments
--    Had an EF query filter only. Measured 24 Sept: tatvaos_app with Techvein's
--    tenant could SELECT and UPDATE ABC School's departments. Every reader was
--    checked before this (the list is in the PR): signup and operator
--    organisation-creation enter the new tenant and sync BEFORE inserting
--    departments; the Postfix policy service enters the mailbox's tenant before
--    resolving an inherited quota; core.user_storage is a definer function.
--    The 0009-departments.sql grant to tatvaos_mailedge is NOT used by any
--    Postfix or Dovecot configuration in this repository; left in place here
--    (removing it is a separate, non-additive change) - with RLS forced it
--    reads nothing anyway.
--
--  calendar.reminder_sends
--    Had nothing: no tenant_id, no filter, no RLS. It gets tenant_id (filled
--    from each reminder's event, then required), a plain tenant policy, and an
--    EF filter - both layers, the simple way, rather than a policy that joins
--    through the event for every row. The only writer, CalendarReminderWorker,
--    runs inside one organisation at a time since the reminder fix (PR 329),
--    and sets tenant_id on every row it writes.
--
--  Additive; re-runs harmlessly.
-- ============================================================================

-- ---- core.departments -------------------------------------------------------
ALTER TABLE core.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.departments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON core.departments;
CREATE POLICY tenant_isolation ON core.departments
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ---- calendar.reminder_sends ------------------------------------------------
--
--  THE BACKFILL MUST NOT BE ABLE TO FAIL A DEPLOY (Mr. Singh, 30 Sept 2026).
--  This file runs on every deploy. If one row is left NULL, SET NOT NULL
--  fails, and so does every deploy after it: decision 0001's lesson, a
--  migration that works on an empty database and fails on real rows.
--  tests/isolation/test-zero-layer-backfill.sh builds that row and applies
--  this file twice; it was red on the version without the two guards below.
--
--  Guard 1, ORPHANS. A send whose event is gone has no organisation to be
--  filled from, and nothing left to protect, so it is deleted and counted.
--  events -> event_reminders -> reminder_sends is ON DELETE CASCADE at both
--  steps, so an orphan can only exist if the foreign-key triggers were
--  bypassed; this is belt and braces. The count is a WARNING: psql shows it
--  when the file is applied by hand, in CI and in the test. deploy.sh prints
--  a migration's output only when it FAILS, so on production it is not seen;
--  the post-deploy check (no NULL tenant_id) is what production shows.
--
--  Guard 2, THE LIVE API. The running API (PR 329) records sends every minute
--  WITHOUT a tenant_id while this runs. A row written after the fill would be
--  a NULL that fails SET NOT NULL; one written before the orphan delete must
--  not be taken for an orphan. So: one transaction, with new rows held off
--  until it commits (SHARE ROW EXCLUSIVE blocks inserts, not reads), and the
--  delete takes only rows whose event really is gone. The API's insert waits
--  milliseconds; after NOT NULL and row security it is refused until the new
--  API replaces it, and the worker retries on its next tick, inside its
--  15-minute grace.
BEGIN;
LOCK TABLE calendar.reminder_sends IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE calendar.reminder_sends
    ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES core.tenants(id) ON DELETE CASCADE;

UPDATE calendar.reminder_sends s
   SET tenant_id = e.tenant_id
  FROM calendar.event_reminders r
  JOIN calendar.events e ON e.id = r.event_id
 WHERE r.id = s.reminder_id
   AND s.tenant_id IS NULL;

DO $$
DECLARE n bigint;
BEGIN
    DELETE FROM calendar.reminder_sends s
     WHERE s.tenant_id IS NULL
       AND NOT EXISTS (SELECT 1
                         FROM calendar.event_reminders r
                         JOIN calendar.events e ON e.id = r.event_id
                        WHERE r.id = s.reminder_id);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
        RAISE WARNING 'zero-layer: removed % reminder_sends row(s) whose event is gone (nothing left to protect)', n;
    END IF;
END $$;

ALTER TABLE calendar.reminder_sends ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reminder_sends_tenant ON calendar.reminder_sends (tenant_id);

ALTER TABLE calendar.reminder_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar.reminder_sends FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON calendar.reminder_sends;
CREATE POLICY tenant_isolation ON calendar.reminder_sends
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
COMMIT;

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
ALTER TABLE calendar.reminder_sends
    ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES core.tenants(id) ON DELETE CASCADE;

UPDATE calendar.reminder_sends s
   SET tenant_id = e.tenant_id
  FROM calendar.event_reminders r
  JOIN calendar.events e ON e.id = r.event_id
 WHERE r.id = s.reminder_id
   AND s.tenant_id IS NULL;

ALTER TABLE calendar.reminder_sends ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reminder_sends_tenant ON calendar.reminder_sends (tenant_id);

ALTER TABLE calendar.reminder_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar.reminder_sends FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON calendar.reminder_sends;
CREATE POLICY tenant_isolation ON calendar.reminder_sends
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

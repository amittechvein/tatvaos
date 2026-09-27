-- ============================================================================
--  calendar.reminder_tenants() - which organisations have reminders to send
-- ============================================================================
--
--  THE INCIDENT. CalendarReminderWorker shipped with the calendar on 16 Aug
--  2026 (acab405). It ran with no user and no tenant and read
--  calendar.event_reminders / calendar.events with IgnoreQueryFilters(). Those
--  tables have FORCED row-level security keyed on app.tenant_id, and the API's
--  role (tatvaos_app) cannot bypass it. With no tenant set every policy reads
--  NULL, so the worker saw no reminders, sent nothing, and logged nothing:
--  "nothing due" is not an error. Found by the 0007 isolation audit on
--  27 Sept 2026; confirmed on production the same day: 7 reminders set, 1 due
--  in the past week, calendar.reminder_sends empty - not one reminder had ever
--  been sent.
--
--  THE FIX, the pattern Connect's workers already use (Mr. Singh, 27 Sept): a
--  SECURITY DEFINER function answers the one cross-organisation question - who
--  has reminders at all - and the worker then enters each organisation
--  (EnterAnonymousScope + SyncTenantAsync) and reads its reminders under RLS,
--  exactly as a signed-in person would. The function returns organisation ids
--  and nothing else: no titles, no people, no times.
--
--  It runs as its owner, so RLS does not apply inside it; its body is the only
--  guard. search_path is pinned with pg_temp LAST (Mr. Singh, 24 Sept, the
--  definer audit), and only tatvaos_app may call it.
-- ============================================================================

CREATE OR REPLACE FUNCTION calendar.reminder_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, calendar, pg_temp
AS $$
    SELECT DISTINCT e.tenant_id
      FROM calendar.event_reminders r
      JOIN calendar.events e ON e.id = r.event_id
     WHERE e.deleted_at IS NULL
       AND e.status <> 'cancelled'
$$;

REVOKE ALL ON FUNCTION calendar.reminder_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar.reminder_tenants() TO tatvaos_app;

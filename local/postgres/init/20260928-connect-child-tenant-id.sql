-- ============================================================================
--  Decision 0007, step two: Connect's child tables carry their own tenant_id
-- ============================================================================
--
--  Mr. Singh's ruling, 24 Sept 2026: "in step two, the child tables get a
--  tenant_id column rather than a join through the meeting; chat and caption
--  lines are high-volume, and a parent join per row is a performance trap."
--
--  Until now each of these ten tables was isolated by a policy that joined to
--  connect.meetings for EVERY row read - and had no EF query filter at all.
--  This file gives each a tenant_id, fills it, requires it, and replaces the
--  per-row join with the plain tenant policy every other table uses. The EF
--  filters are in AppDbContext (the same change), which makes the application
--  the second layer on all fifteen Connect child entities.
--
--  WHO WRITES tenant_id. A BEFORE INSERT/UPDATE trigger sets it from the row's
--  meeting, IGNORING whatever the writer supplied - so it can never disagree
--  with the meeting, and none of the dozen EF and SQL writers had to change.
--  The trigger is SECURITY INVOKER on purpose: a writer who cannot see the
--  meeting under RLS gets NULL, the NOT NULL constraint refuses the row, and
--  nobody can learn another organisation's meeting through it.
--
--  Sizes on production, 28 Sept (read-only): the largest of the ten,
--  meeting_events, has 3,463 rows; the backfill is one statement each.
--
--  Re-runnable: the backfill touches only NULLs, the policies are dropped and
--  re-created by name (after the older files re-create theirs on each deploy,
--  so this file's version is the one that stands). meeting_chat's old policy
--  had its own name (meeting_chat_tenant, 20260819-a) and is dropped here.
-- ============================================================================

CREATE OR REPLACE FUNCTION connect.child_tenant_from_meeting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, connect, pg_temp
AS $$
BEGIN
    NEW.tenant_id := (SELECT m.tenant_id FROM connect.meetings m WHERE m.id = NEW.meeting_id);
    RETURN NEW;
END
$$;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'participants', 'lobby_requests', 'meeting_events', 'meeting_chat', 'caption_lines',
        'meeting_blocks', 'meeting_notes', 'recordings', 'transcripts'
    ] LOOP
        EXECUTE format('ALTER TABLE connect.%I ADD COLUMN IF NOT EXISTS tenant_id uuid '
                       'REFERENCES core.tenants(id) ON DELETE CASCADE', t);
        EXECUTE format('UPDATE connect.%I c SET tenant_id = m.tenant_id FROM connect.meetings m '
                       'WHERE m.id = c.meeting_id AND c.tenant_id IS NULL', t);
        EXECUTE format('ALTER TABLE connect.%I ALTER COLUMN tenant_id SET NOT NULL', t);
        EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%s_tenant ON connect.%I (tenant_id)', t, t);

        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_tenant ON connect.%I', t, t);
        EXECUTE format('CREATE TRIGGER trg_%s_tenant BEFORE INSERT OR UPDATE OF meeting_id ON connect.%I '
                       'FOR EACH ROW EXECUTE FUNCTION connect.child_tenant_from_meeting()', t, t);

        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON connect.%I', t);
        EXECUTE format('CREATE POLICY tenant_isolation ON connect.%I '
                       'USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
                       'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END LOOP;
END $$;

-- meeting_chat's older policy had its own name; without this it would stand
-- beside the new one (permissive policies are OR'd) and keep the per-row join.
DROP POLICY IF EXISTS meeting_chat_tenant ON connect.meeting_chat;

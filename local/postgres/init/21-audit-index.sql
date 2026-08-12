-- ============================================================================
--  Audit trail — an index for reading it
-- ============================================================================
--
--  The trail has been written since the beginning and read by nothing, so the
--  only index it carries is (tenant_id, occurred_at DESC) — the shape you
--  reach for when you assume a console will page by time.
--
--  The viewer pages by ID instead, and the reason matters: the trail grows
--  WHILE it is being read. Paging by timestamp with OFFSET shows the same row
--  twice or skips one entirely as later pages shift beneath the reader, and an
--  audit log that silently omits a row is worse than one nobody can read —
--  it is one you cannot trust. Keyset paging on a monotonic id has no such
--  window: "everything before id N" means the same thing whatever arrives next.
--
--  So the query is ORDER BY id DESC with id < $cursor, per tenant, and it wants
--  an index in exactly that shape. Without it, Postgres either scans the whole
--  tenant partition of the largest table in the schema, or walks the
--  occurred_at index and sorts — both fine on a new tenant and neither fine on
--  one with a year of history.
--
--  The occurred_at index stays. It still serves the date-range filter and any
--  future time-bucketed reporting.

CREATE INDEX IF NOT EXISTS idx_core_audit_tenant_id_desc
    ON core.audit_logs(tenant_id, id DESC);

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Audit read index ready — keyset paging by id, per tenant.';
    RAISE NOTICE '';
END $$;

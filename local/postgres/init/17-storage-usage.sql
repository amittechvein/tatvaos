-- ============================================================================
--  Storage usage roll-up
-- ============================================================================
--
--  FIXING A LIVE BUG. core.storage_allocations.used_bytes is read in four
--  places — the capacity check, the add-user gate, the pooled quota check and
--  the admin console — and was written by NOTHING. Every organisation
--  therefore reported using zero bytes no matter how full its mailboxes were,
--  and the pooled-storage quota check compared "0 + message size" against the
--  allocation, so it could never refuse anything.
--
--  Per-mailbox usage was always correct: mail.mailboxes.used_bytes is
--  maintained at ingest, at send and on delete. What was missing was the
--  tenant-level ROLL-UP of those numbers. So this reconciles the roll-up FROM
--  the mailbox figures, which are the source of truth.
--
--  WHY A DATABASE FUNCTION RATHER THAN C#.
--
--  Three reasons, in order of importance:
--
--   1. It crosses tenants. A reconcile pass over every organisation from the
--      application would have to loop, setting app.tenant_id per tenant and
--      issuing a query each time — hundreds of round trips to compute a single
--      GROUP BY. As SECURITY DEFINER this is one statement.
--
--   2. It crosses lanes. Maintaining the roll-up incrementally would mean
--      editing the Mail lane's ingest worker and send path from Core. Deriving
--      it here keeps the fix entirely inside Core and leaves Mail untouched.
--
--   3. It is self-correcting. An incremental counter drifts — a crash between
--      writing the message and bumping the counter loses a delta forever, and
--      nothing ever notices. A derivation cannot drift, because it recomputes
--      from the truth every time.
--
--  This does NOT contradict the "never SUM() on read" note in 00-core-schema:
--  that warning is about the DELIVERY PATH, which checks a quota on every
--  inbound message and must stay O(1). Nothing here runs per message. The
--  delivery path keeps reading the stored used_bytes column; this is what
--  keeps that column honest.

-- ----------------------------------------------------------------------------
--  Reconcile one tenant, or every tenant when p_tenant IS NULL.
--  Returns the number of allocation rows written.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.reconcile_storage_usage(p_tenant uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
-- SECURITY DEFINER so the roll-up can read every tenant's mailboxes in one
-- pass. It is safe because the function takes no user input beyond a tenant id
-- and returns only a row count — there is no path here that leaks one tenant's
-- data to another.
SECURITY DEFINER
-- Pinned so a caller cannot shadow these schemas with their own tables and
-- have this function write somewhere unintended. Mandatory on SECURITY DEFINER.
SET search_path = core, mail, pg_temp
AS $$
DECLARE
    v_rows integer;
BEGIN
    WITH usage AS (
        SELECT m.tenant_id, COALESCE(SUM(m.used_bytes), 0)::bigint AS used
          FROM mail.mailboxes m
         WHERE p_tenant IS NULL OR m.tenant_id = p_tenant
         GROUP BY m.tenant_id
    )
    INSERT INTO core.storage_allocations (tenant_id, product_code, used_bytes, updated_at)
    SELECT u.tenant_id, 'mail', u.used, now()
      FROM usage u
    -- The allocation row may not exist yet: a tenant that has never had its
    -- split edited has mailboxes and no allocation. Creating it here with a
    -- NULL allocated_bytes means "draw from whatever is left in the pool",
    -- which is the correct default and what the capacity code already expects.
    ON CONFLICT (tenant_id, product_code) DO UPDATE
        SET used_bytes = EXCLUDED.used_bytes,
            updated_at = now()
      -- Skip the write when the number has not moved, so an idle platform does
      -- not rewrite every row on every pass and churn the table for nothing.
      WHERE core.storage_allocations.used_bytes IS DISTINCT FROM EXCLUDED.used_bytes;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- A tenant whose mailboxes have all been deleted produces no row above and
    -- would keep its last non-zero figure forever, reading as permanently full.
    UPDATE core.storage_allocations a
       SET used_bytes = 0, updated_at = now()
     WHERE a.product_code = 'mail'
       AND (p_tenant IS NULL OR a.tenant_id = p_tenant)
       AND a.used_bytes <> 0
       AND NOT EXISTS (SELECT 1 FROM mail.mailboxes m WHERE m.tenant_id = a.tenant_id);

    RETURN v_rows;
END;
$$;

-- The API role calls this on demand (opening the storage page repairs that
-- tenant's figure) and on a timer via StorageReconcileWorker.
GRANT EXECUTE ON FUNCTION core.reconcile_storage_usage(uuid) TO tatvaos_app;

-- Backfill immediately, so the numbers are right the moment this deploys
-- rather than at the first worker tick.
DO $$
DECLARE
    v_rows integer;
BEGIN
    SELECT core.reconcile_storage_usage() INTO v_rows;
    RAISE NOTICE '';
    RAISE NOTICE '  Storage usage roll-up ready — % tenant allocation(s) reconciled.', v_rows;
    RAISE NOTICE '  used_bytes is now derived from mail.mailboxes, not an';
    RAISE NOTICE '  incremental counter, so it cannot drift.';
    RAISE NOTICE '';
END $$;

-- ============================================================================
--  Storage warnings — tell the admin BEFORE the pool fills
-- ============================================================================
--
--  StorageAllocator has had thresholds at 80% and 95% since it was written,
--  and until now nothing acted on them. The console showed a colour; no one
--  was told. So the first thing a customer learned about their storage was
--  that mail had stopped.
--
--  That matters most under POOLED storage, where the failure is not gradual:
--  one number crosses a line and EVERY mailbox in the organisation stops
--  accepting mail at the same moment. An alert that arrives after that is a
--  post-mortem, not a warning.
--
--  This column is what stops the warning becoming noise. Without it the
--  reconcile worker would email every fifteen minutes for as long as the pool
--  stayed above 80% — which is precisely how people build a filter for your
--  alerts and then miss the one that mattered.
--
--  Values: NULL (nothing sent), 'warn' (80% notice sent), 'critical' (95%).
--  Mail goes out only on a move UP to a level not yet sent. Dropping back
--  below a threshold clears it, so an organisation that frees space and fills
--  up again is warned again — the second warning is as real as the first.

ALTER TABLE core.storage_pools ADD COLUMN IF NOT EXISTS warned_level text;

ALTER TABLE core.storage_pools DROP CONSTRAINT IF EXISTS storage_pools_warned_level_check;
ALTER TABLE core.storage_pools ADD CONSTRAINT storage_pools_warned_level_check
    CHECK (warned_level IS NULL OR warned_level IN ('warn', 'critical'));

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Storage warning state ready — one email per threshold crossed,';
    RAISE NOTICE '  not one per reconcile pass.';
    RAISE NOTICE '';
END $$;

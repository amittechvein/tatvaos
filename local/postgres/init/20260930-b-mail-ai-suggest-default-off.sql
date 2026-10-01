-- ============================================================================
-- Suggested replies start OFF (Mr. Singh, 30 Sept 2026).
--
-- Help me write sends a person's own draft, when they ask. Suggested replies
-- send someone ELSE's email the moment it is opened, with nobody asking, so
-- an administrator turns them on deliberately, like Summarise and sorting.
--
-- The column default only: catalogue-only, no row is read or written. Rows
-- that already exist are NOT changed here - an organisation that has Mail AI
-- on keeps what its administrator chose. The OFF -> ON switch in
-- OrgAiEndpoints resets the features to the defaults (AiProductSwitch), so an
-- organisation turning Mail AI on for the first time gets suggestions off
-- whatever its stored value says. Re-runs harmlessly.
-- ============================================================================

ALTER TABLE core.tenants ALTER COLUMN mail_ai_suggest SET DEFAULT false;

-- ============================================================================
-- Every AI feature has an organisation list (AiGate, 30 Sept 2026).
--
-- From this release the gateway refuses an AI request unless the
-- organisation is on that feature's list, and an EMPTY or MISSING list means
-- nobody (PR 360). Connect's minutes had no list before; without a row here
-- the deploy would switch meeting minutes off for every organisation.
--
-- Mr. Singh, 30 Sept 2026:
--   ai.connect.organisations = all    minutes' disclosure is live; each
--                                     organisation's allow_ai stays the consent
--   ai.docs.organisations    = empty  Docs is off for everyone (no row = none)
--
-- Written ONCE, only if absent: the operator may change it on the Settings
-- page, and this file re-runs on every deploy, so it must never put a value
-- back. ai.mail.organisations is not touched (set by hand on 25 Sept).
-- ============================================================================

INSERT INTO core.platform_settings (key, value, is_secret, updated_at)
VALUES ('ai.connect.organisations', 'all', false, now())
ON CONFLICT (key) DO NOTHING;

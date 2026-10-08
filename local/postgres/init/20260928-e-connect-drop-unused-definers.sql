-- ============================================================================
--  Decision 0007: drop the four Connect definer functions nothing calls
-- ============================================================================
--
--  Found by the definer review of 28 Sept 2026 (PR 333; the verdicts are in
--  docs/decisions/0007-tenantless-paths.md section 3). A SECURITY DEFINER
--  function runs past row-level security and every EF filter; one that
--  nothing calls protects nothing and is only a way around both for anyone
--  who can run SQL as the application. None has a caller in the API, in SQL,
--  in the tests or in infra:
--
--    meeting_chat_lines(uuid)          ANY meeting's chat, by meeting id - the
--                                      widest of the thirty
--    meetings_with_captions(integer)   meeting ids with captions, all orgs
--    recording_bytes(uuid)             a byte count for any org
--    share_for_user(uuid, uuid, uuid)  superseded by share_access_for_user;
--                                      ignored its third argument
--
--  Their CREATE statements are removed from the files that made them, so a
--  deploy (which re-runs every file) does not bring them back; this file drops
--  them from databases that already have them. Re-runnable.
--
--  Mr. Singh's ruling is required before this merges: dropping is not additive.
-- ============================================================================

DROP FUNCTION IF EXISTS connect.meeting_chat_lines(uuid);
DROP FUNCTION IF EXISTS connect.meetings_with_captions(integer);
DROP FUNCTION IF EXISTS connect.recording_bytes(uuid);
DROP FUNCTION IF EXISTS connect.share_for_user(uuid, uuid, uuid);

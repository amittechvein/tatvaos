-- Correct the empty-sender-address CHECK on mail.api_keys.
--
-- 20260903-mail-api-keys.sql creates the table with
--   CHECK (revoked_at IS NOT NULL OR array_length(allowed_sender_addresses, 1) > 0)
-- but array_length() returns NULL for an empty array, and a CHECK treats a
-- NULL result as passing -- so an active key with an empty list slips through,
-- which is the exact hole the constraint was meant to stop. cardinality()
-- returns 0 for an empty array, so cardinality(...) > 0 is a real refusal.
--
-- Why keep a constraint the send endpoint already enforces (Connect): one
-- writer today already refuses an empty list; this constraint exists for the
-- second writer, which nobody has written yet and nobody will remember this
-- rule when they do. A constraint that only restates application behaviour is
-- deleted as redundant; one that names what it guards survives.
--
-- Idempotent: DROP ... IF EXISTS covers both "absent" and "present but wrong".

ALTER TABLE mail.api_keys DROP CONSTRAINT IF EXISTS check_active_keys_have_addresses;

ALTER TABLE mail.api_keys ADD CONSTRAINT check_active_keys_have_addresses
  CHECK (revoked_at IS NOT NULL OR cardinality(allowed_sender_addresses) > 0);

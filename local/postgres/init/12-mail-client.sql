-- ============================================================================
--  12 — Mail client columns
-- ============================================================================
--
--  The webmail reads mail.messages directly, so the table needs what a client
--  renders without opening the full MIME: a plain-text snippet for the list
--  row, the cc line, and whether a paperclip icon is honest.
--
--  raw_body / headers / search_vector already exist on a FRESH database
--  (01-mail-schema.sql creates them), but production's table may predate
--  them — CREATE TABLE IF NOT EXISTS skips silently, which is exactly how a
--  column goes missing on the one database that matters. Every ADD COLUMN
--  here is IF NOT EXISTS so this file is safe to run on both, every deploy.
-- ============================================================================

ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS raw_body      text;
ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS headers       jsonb;
ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Plain text, computed once at ingest. Rendering a list of 100 rows must not
-- parse 100 MIME messages.
ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS snippet   text;
ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS cc_addrs  text[];
ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS has_attachments boolean NOT NULL DEFAULT false;

-- Display names as they appeared on the wire. from_addr/to_addrs hold bare
-- addresses for routing and search; these hold "Priya Nair" so the client
-- shows a person, not an address.
ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS from_name text;

-- The ingest worker dedupes against this: a maildir file is indexed once,
-- keyed by its stable base name. Partial index — sent mail composed in the
-- webmail has no maildir file and no key.
CREATE INDEX IF NOT EXISTS idx_mail_messages_blob_key
    ON mail.messages(blob_key) WHERE blob_key IS NOT NULL;

-- Locates an attachment inside its message's MIME tree. Set at ingest, used
-- by the download endpoint; blob_key stays reserved for object storage later.
ALTER TABLE mail.attachments ADD COLUMN IF NOT EXISTS part_index int;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Mail client columns ready — messages carry their own preview';
    RAISE NOTICE '';
END $$;

-- ============================================================================
--  15 — Real search
-- ============================================================================
--
--  mail.messages has carried a search_vector column and a GIN index over it
--  since the first schema, and NOTHING HAS EVER WRITTEN TO IT. Meanwhile the
--  client's search box filtered the fifty rows already on screen, in one
--  folder, in the browser — so searching for a message from last month
--  returned nothing, with no way to tell that from "no such message".
--
--  This file makes the column real:
--    * body_text  — the plain-text body, extracted once at ingest. The full
--                   MIME lives in raw_body, but indexing THAT would index
--                   base64 attachment blobs: a huge index full of matches no
--                   person is looking for.
--    * a trigger  — maintains search_vector on insert and on any edit to a
--                   field it covers, so the index cannot drift from the row.
--
--  WHY THE 'simple' CONFIGURATION, NOT 'english':
--  This carries mail for Indian organisations — Hindi, Marathi, Tamil and
--  English in the same mailbox, often in the same message. English stemming
--  would mangle non-English words and discard English stopwords that are
--  ordinary words elsewhere. 'simple' lowercases and splits on punctuation,
--  which is the behaviour that is correct in every language here rather than
--  excellent in one and wrong in the rest.
--
--  Idempotent — it re-runs on each deploy.
-- ============================================================================

ALTER TABLE mail.messages ADD COLUMN IF NOT EXISTS body_text text;

-- ----------------------------------------------------------------------------
--  The trigger that maintains search_vector.
--
--  THIS RUNS ON THE MAIL DELIVERY PATH, so it is written to be incapable of
--  refusing a row:
--
--   * left(..., 100000) — a tsvector has a hard 1MB limit. A long newsletter
--     would otherwise raise "string is too long for tsvector" and fail the
--     INSERT, which means the ingest worker could not deliver that message at
--     all. 100k characters is far more than anyone searches within.
--
--   * EXCEPTION WHEN others — if anything else in here ever throws, the row
--     is stored with a NULL vector and simply is not searchable. Unsearchable
--     mail is a degraded feature; undeliverable mail is a broken product.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mail.messages_search_vector()
RETURNS trigger AS $$
BEGIN
    BEGIN
        NEW.search_vector :=
            setweight(to_tsvector('simple', left(coalesce(NEW.subject, ''), 100000)), 'A') ||
            setweight(to_tsvector('simple',
                left(coalesce(NEW.from_name, '') || ' ' || coalesce(NEW.from_addr, ''), 100000)), 'B') ||
            setweight(to_tsvector('simple',
                left(coalesce(array_to_string(NEW.to_addrs, ' '), ''), 100000)), 'B') ||
            setweight(to_tsvector('simple',
                left(coalesce(NEW.body_text, NEW.snippet, ''), 100000)), 'C');
    EXCEPTION WHEN others THEN
        NEW.search_vector := NULL;
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mail_messages_search_vector ON mail.messages;
CREATE TRIGGER trg_mail_messages_search_vector
    BEFORE INSERT OR UPDATE OF subject, from_name, from_addr, to_addrs, body_text, snippet
    ON mail.messages
    FOR EACH ROW EXECUTE FUNCTION mail.messages_search_vector();

-- ----------------------------------------------------------------------------
--  Backfill for mail that arrived before the trigger existed.
--
--  `SET snippet = snippet` is a no-op to the data, but snippet is one of the
--  columns the trigger watches — so this makes every old row recompute its own
--  vector through the same function, rather than duplicating that expression
--  here where the two could drift apart.
--
--  Guarded on search_vector IS NULL so a deploy does not rewrite the whole
--  table every time this file runs.
--
--  Old messages have no body_text (their bodies were never extracted), so they
--  fall back to snippet and are searchable by subject, sender and preview.
--  Mail arriving from now on is searchable by its full body.
-- ----------------------------------------------------------------------------
UPDATE mail.messages SET snippet = snippet WHERE search_vector IS NULL;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Search is live — subject, sender, recipients and body, across every folder';
    RAISE NOTICE '';
END $$;

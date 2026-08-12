-- ============================================================================
--  16 — Conversations
-- ============================================================================
--
--  mail.messages has had a thread_id column since the first schema and nothing
--  ever wrote to it, so every message was its own conversation: a reply and the
--  message it answered had no relationship the client could see.
--
--  The API now sets thread_id at ingest and on send, from In-Reply-To and
--  References. This file only adds the index that makes reading a conversation
--  cheap — the column already exists.
--
--  Partial index: mail that predates threading has thread_id NULL, and there is
--  no point indexing rows that are each their own thread.
--
--  NOT BACKFILLED, deliberately. Reconstructing threads for existing mail means
--  re-parsing every stored MIME body to recover its In-Reply-To header, which is
--  a long table rewrite for mail people have already read. New conversations
--  thread from now on, and an old ancestor gets stitched in the moment someone
--  replies to it (see MailThreads.ResolveAsync).
--
--  Idempotent — it re-runs on each deploy.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_mail_messages_thread
    ON mail.messages(mailbox_id, thread_id)
    WHERE thread_id IS NOT NULL;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Conversations ready — replies thread by In-Reply-To, never by subject';
    RAISE NOTICE '';
END $$;

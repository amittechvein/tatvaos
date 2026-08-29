-- ============================================================================
--  TatvaOS Connect — who may send chat messages.
--  Asked for by Amit, 22 August 2026, after a twenty-two person demo.
-- ============================================================================
--
--  Three values, the same shape as share_policy so there is one idea to learn
--  rather than two:
--
--    'everyone'  anybody in the meeting may type. Today's behaviour, and the
--                default, so every existing meeting is unchanged.
--    'cohost'    only the host and co-hosts may type. EVERYONE still READS —
--                this is about who talks in the sidebar during a briefing,
--                not about hiding anything.
--    'off'       nobody types. The panel still opens and the history is still
--                there, because a meeting where chat was closed halfway
--                through should not lose what was said before it.
--
--  ─────────────────────────────────────────────────────────────────────────
--  HOW FAR THIS IS ENFORCED, STATED PLAINLY.
--
--  Screen sharing is enforced in the LiveKit token: canPublishSources is
--  minted from the caller's role and a client cannot argue with it. Chat is
--  NOT, and cannot be by the same mechanism — chat, raised hands, reactions
--  and file transfers all ride the one data channel, and the only token grant
--  available is canPublishData, which is all four or none. Turning it off to
--  silence chat would also stop somebody raising their hand to ask why.
--
--  So this is enforced in the client: the composer is closed and says why.
--  A modified client could still publish, exactly as a modified client could
--  already claim its own raised hand. The setting exists to stop a room of
--  twenty from talking over a presenter, and for that it is sufficient.
--
--  If we ever want it to be a control rather than a courtesy, the way in is
--  participant metadata on the token — every client would then know every
--  sender's role and could DROP a message it was not entitled to send. That
--  is a change to the file that mints tokens, so it is Core's call, not one
--  to make in a UI change. Noted here so the next person does not have to
--  work out why it was not done.
--  ─────────────────────────────────────────────────────────────────────────
--
--  Additive and idempotent, like every migration in this directory: the
--  deploy script replays the whole folder on every deploy, and the schema is
--  applied BEFORE the new containers start, so old code seeing a new column
--  is the only overlap and it ignores it.
-- ============================================================================

ALTER TABLE connect.meetings
    ADD COLUMN IF NOT EXISTS chat_policy text NOT NULL DEFAULT 'everyone';

-- Named constraint added defensively: ADD COLUMN IF NOT EXISTS skips the
-- whole clause when the column already exists, so an inline CHECK would be
-- silently absent on every database that already ran this once.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'meetings_chat_policy_check'
           AND conrelid = 'connect.meetings'::regclass) THEN
        ALTER TABLE connect.meetings ADD CONSTRAINT meetings_chat_policy_check
            CHECK (chat_policy IN ('everyone','cohost','off'));
    END IF;
END $$;

COMMENT ON COLUMN connect.meetings.chat_policy IS
    'Who may SEND chat: everyone | cohost (host + cohosts) | off. Everyone '
    'always reads. Enforced in the client, not in the token — chat shares the '
    'data channel with hands, reactions and files, and canPublishData cannot '
    'separate them. See the header of 20260909-connect-chat-policy.sql.';

DO $$
BEGIN
    RAISE NOTICE 'connect chat policy:';
    RAISE NOTICE '    meetings.chat_policy — everyone | cohost | off, default everyone';
END $$;

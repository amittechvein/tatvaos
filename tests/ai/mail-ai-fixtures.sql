-- LOCAL TEST ONLY. Fixtures for the suggested-replies half of
-- tests/ai/mail-ai.test.mjs, in the mailbox of the user whose phone is :phone.
-- Fresh ids every run (so the API's in-memory suggestion cache can never make
-- a second run look like the first); old fixtures removed by subject prefix.
-- Prints key|id lines for the test to read. Run as a superuser: mail.* has
-- FORCE ROW LEVEL SECURITY, and the app role would insert nothing, silently.
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned
\set QUIET 1
CREATE TEMP TABLE fx AS
SELECT mb.id AS mailbox_id, mb.tenant_id, mb.address,
       (SELECT id FROM mail.folders f WHERE f.mailbox_id = mb.id AND f.special_use = '\Inbox') AS inbox,
       (SELECT id FROM mail.folders f WHERE f.mailbox_id = mb.id AND f.special_use = '\Sent')  AS sent
FROM mail.mailboxes mb JOIN core.users u ON u.id = mb.user_id
WHERE u.phone = :'phone' AND mb.is_active
LIMIT 1;

DELETE FROM mail.messages WHERE mailbox_id = (SELECT mailbox_id FROM fx) AND subject LIKE '[mail-ai-test]%';

CREATE TEMP TABLE made (key text, id uuid DEFAULT gen_random_uuid());
INSERT INTO made (key) VALUES ('normal'), ('noreply'), ('sent'), ('lines'), ('markup'), ('long'), ('empty'), ('own'), ('th1'), ('th2');
-- th1 and th2 are one conversation (Summarise, 26 Sept 2026).
CREATE TEMP TABLE conv AS SELECT gen_random_uuid() AS thread_id;

INSERT INTO mail.messages (id, tenant_id, mailbox_id, folder_id, imap_uid, from_addr, from_name, to_addrs, subject, body_text, snippet, thread_id, received_at)
SELECT m.id, fx.tenant_id, fx.mailbox_id,
       CASE WHEN m.key = 'sent' THEN fx.sent ELSE fx.inbox END,
       (extract(epoch FROM clock_timestamp())::bigint % 1000000) * 10 + row_number() OVER (),
       CASE m.key WHEN 'noreply' THEN 'no-reply@bank.example' WHEN 'own' THEN fx.address ELSE 'priya@example.com' END,
       CASE m.key WHEN 'noreply' THEN 'Bank alerts' ELSE 'Priya Shah' END,
       ARRAY[fx.address],
       '[mail-ai-test] ' || m.key,
       CASE m.key
         WHEN 'normal' THEN E'Hi Asha,\n\nCan we move the admissions review to Friday 3 Oct at 4pm?\n\nThanks\nPriya\n\nOn Mon, 22 Sep 2026 at 10:00, Asha Rao wrote:\n> OLD-QUOTED-HISTORY please ignore'
         WHEN 'lines'  THEN 'Are you free this week? FAKE:LINES'
         WHEN 'markup' THEN 'Quick question. FAKE:MARKUP'
         WHEN 'long'   THEN 'START ' || repeat('lorem ipsum ', 500) || ' END-MARKER'
         WHEN 'empty'  THEN ''
         WHEN 'th1'    THEN E'Can we move the review to Friday 3 Oct at 4pm?\n\nOn Mon, Asha wrote:\n> SUMMARY-OLD-QUOTE'
         WHEN 'th2'    THEN 'Friday works for the team. Please confirm the room.'
         ELSE 'Please confirm the fee receipt for September.'
       END,
       NULL,
       CASE WHEN m.key IN ('th1', 'th2') THEN (SELECT thread_id FROM conv) END,
       CASE m.key WHEN 'th1' THEN now() - interval '2 hours' WHEN 'th2' THEN now() - interval '1 hour' ELSE now() END
FROM made m CROSS JOIN fx;

SELECT key || '|' || id FROM made;

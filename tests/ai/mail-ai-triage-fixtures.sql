-- LOCAL TEST ONLY. Fixtures for the sorting half of tests/ai/mail-ai.test.mjs
-- (Mail AI step 3), in the mailbox of the user whose phone is :phone. Run AFTER
-- the test has switched sorting on: every message here "arrives" now, except
-- 'old', which arrived an hour ago — before the switch — and must be left
-- alone. Prints key|id. Superuser only: mail.* is FORCE ROW LEVEL SECURITY.
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

DELETE FROM mail.messages WHERE mailbox_id = (SELECT mailbox_id FROM fx) AND subject LIKE '[mail-ai-triage]%';

CREATE TEMP TABLE made (key text, id uuid DEFAULT gen_random_uuid());
INSERT INTO made (key) VALUES ('person'), ('promo'), ('fyi'), ('nolabel'), ('robot'), ('own'), ('old'), ('sent');

INSERT INTO mail.messages (id, tenant_id, mailbox_id, folder_id, imap_uid, from_addr, from_name, to_addrs, subject, body_text, received_at)
SELECT m.id, fx.tenant_id, fx.mailbox_id,
       CASE WHEN m.key = 'sent' THEN fx.sent ELSE fx.inbox END,
       (extract(epoch FROM clock_timestamp())::bigint % 1000000) * 10 + row_number() OVER (),
       CASE m.key WHEN 'robot' THEN 'notifications@shop.example' WHEN 'own' THEN fx.address ELSE 'ravi@example.com' END,
       CASE m.key WHEN 'robot' THEN 'Shop' ELSE 'Ravi Kumar' END,
       ARRAY[fx.address],
       '[mail-ai-triage] ' || m.key,
       CASE m.key
         WHEN 'person'  THEN 'Could you send the signed form by Monday? ' || repeat('details ', 200) || E' TRIAGE-END-MARKER\n\nOn Tue, 23 Sep 2026, Asha wrote:\n> TRIAGE-OLD-QUOTE'
         WHEN 'promo'   THEN 'Big sale this week FAKE:PROMO'
         WHEN 'fyi'     THEN 'Just so you know, the meeting moved FAKE:FYI'
         WHEN 'nolabel' THEN 'Hmm FAKE:NOLABEL'
         ELSE 'Your order has shipped.'
       END,
       CASE WHEN m.key = 'old' THEN now() - interval '1 hour' ELSE clock_timestamp() END
FROM made m CROSS JOIN fx;

SELECT key || '|' || id FROM made;

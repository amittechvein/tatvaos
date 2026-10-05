-- LOCAL ONLY: a copy shaped like production BEFORE the Mail AI deploy, at
-- production's measured size (mail.messages 708 MB, ~630 MB of it bodies).
\set ON_ERROR_STOP 1
\timing on
-- Undo this branch's migrations in the COPY, so the timed run is a first run.
ALTER TABLE mail.messages DROP COLUMN IF EXISTS ai_label;
ALTER TABLE mail.messages DROP COLUMN IF EXISTS ai_labelled_at;
ALTER TABLE core.tenants DROP COLUMN IF EXISTS mail_ai_triage_since;

-- Spread over every inbox the local data has, two years of received dates,
-- bodies of ~2 KB of ordinary words.
INSERT INTO mail.messages (tenant_id, mailbox_id, folder_id, imap_uid, from_addr, from_name, to_addrs, subject, body_text, snippet, received_at)
SELECT f.tenant_id, f.mailbox_id, f.id,
       10000000 + g,
       'sender' || (g % 5000) || '@example.com', 'Sender ' || (g % 5000), ARRAY['someone@example.com'],
       'Perf message ' || g,
       -- Ordinary words from a small vocabulary, like real mail: a search
       -- index over unique md5 tokens is 4x the size real mail produces.
       (SELECT string_agg((ARRAY['the','meeting','school','fees','receipt','please','confirm','tomorrow','parents','class',
                                 'report','doctor','appointment','invoice','payment','thank','you','regards','dear','sir',
                                 'madam','schedule','review','attached','document','admission','student','teacher','exam','result',
                                 'hospital','patient','clinic','order','delivery','account','update','notice','holiday','office',
                                 'team','project','deadline','friday','monday','call','kindly','request','approval','budget',
                                 'transport','bus','uniform','library','sports','function','annual','day','week','month'])
                          [1 + ((g * 31 + i * 7 + (g % 13) * i) % 60)], ' ')
        FROM generate_series(1, 330) i),
       'snippet ' || g,
       now() - (g % 730) * interval '1 day' - (g % 86400) * interval '1 second'
FROM generate_series(1, :rows) g
CROSS JOIN LATERAL (
    SELECT id, tenant_id, mailbox_id FROM mail.folders WHERE special_use = '\Inbox'
    ORDER BY id OFFSET (g % 3) LIMIT 1
) f;
ANALYZE mail.messages;
SELECT count(*) AS rows, pg_size_pretty(pg_total_relation_size('mail.messages')) AS total_size FROM mail.messages;

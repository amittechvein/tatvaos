EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT m.id, m.from_addr, m.from_name, m.subject, m.body_text, m.snippet, m.sent_by_user_id, b.address
FROM mail.messages m
JOIN mail.folders f ON m.folder_id = f.id
JOIN mail.mailboxes b ON m.mailbox_id = b.id
WHERE m.tenant_id = '11111111-1111-1111-1111-111111111111'
  AND f.tenant_id = '11111111-1111-1111-1111-111111111111'
  AND b.tenant_id = '11111111-1111-1111-1111-111111111111'
  AND f.special_use = '\Inbox' AND m.ai_labelled_at IS NULL
  AND m.received_at >= now() - interval '7 days'
ORDER BY m.received_at DESC
LIMIT 20;

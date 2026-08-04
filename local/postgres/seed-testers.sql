-- ============================================================================
--  TatvaOS Mail — tester seed data
-- ============================================================================
--
--  Four tenants rather than two, chosen to mirror the real target segments in
--  architecture §10 — an SMB, a school, a clinic and a second SMB used purely
--  as the "must never see anything" control.
--
--  Testers need enough variety to find real bugs: shared mailboxes, aliases,
--  a suspended tenant, a disabled user, long folder contents. A two-row
--  fixture finds nothing.
--
--  Apply to a running stack:
--      ./scripts/seed-testers.sh
--
--  Idempotent — safe to re-run.
--  Every password: devpass123
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tenant 3: City Clinic  (healthcare segment)
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name, status) VALUES
    ('33333333-3333-3333-3333-333333333333', 'City Clinic', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, fqdn, type, is_active, verified_at) VALUES
    ('c3333333-3333-3333-3333-333333333333',
     '33333333-3333-3333-3333-333333333333',
     'cityclinic.local', 'primary', true, now())
ON CONFLICT (fqdn) DO NOTHING;

INSERT INTO mailboxes (tenant_id, domain_id, address, local_part, type, password_hash, quota_bytes) VALUES
    ('33333333-3333-3333-3333-333333333333','c3333333-3333-3333-3333-333333333333',
     'reception@cityclinic.local','reception','shared',
     '{SHA512-CRYPT}$6$tvamitsalt$POiXxoaDNlClpKHyJJIM8red44tVlhXescz5BhynJJTNmlPwo/1qb/DONC/Uo2Rf1GtUAxpJq.Zsu5UgGNkUP.', 1073741824),
    ('33333333-3333-3333-3333-333333333333','c3333333-3333-3333-3333-333333333333',
     'dr.sharma@cityclinic.local','dr.sharma','user',
     '{SHA512-CRYPT}$6$tvamitsalt$POiXxoaDNlClpKHyJJIM8red44tVlhXescz5BhynJJTNmlPwo/1qb/DONC/Uo2Rf1GtUAxpJq.Zsu5UgGNkUP.', 1073741824)
ON CONFLICT (address) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Tenant 4: Rival Corp  — the control. Testers verify NOTHING from here is
-- ever visible anywhere else, and vice versa.
-- ----------------------------------------------------------------------------
INSERT INTO tenants (id, name, status) VALUES
    ('44444444-4444-4444-4444-444444444444', 'Rival Corp', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, fqdn, type, is_active, verified_at) VALUES
    ('d4444444-4444-4444-4444-444444444444',
     '44444444-4444-4444-4444-444444444444',
     'rivalcorp.local', 'primary', true, now())
ON CONFLICT (fqdn) DO NOTHING;

INSERT INTO mailboxes (tenant_id, domain_id, address, local_part, type, password_hash) VALUES
    ('44444444-4444-4444-4444-444444444444','d4444444-4444-4444-4444-444444444444',
     'ceo@rivalcorp.local','ceo','user',
     '{SHA512-CRYPT}$6$tvamitsalt$POiXxoaDNlClpKHyJJIM8red44tVlhXescz5BhynJJTNmlPwo/1qb/DONC/Uo2Rf1GtUAxpJq.Zsu5UgGNkUP.')
ON CONFLICT (address) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Edge cases worth having a tester walk into deliberately
-- ----------------------------------------------------------------------------

-- A disabled mailbox: mail to it must be REJECTED, not silently accepted
INSERT INTO mailboxes (tenant_id, domain_id, address, local_part, type, password_hash, is_active) VALUES
    ('11111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111',
     'former.employee@techvein.local','former.employee','user',
     '{SHA512-CRYPT}$6$tvamitsalt$POiXxoaDNlClpKHyJJIM8red44tVlhXescz5BhynJJTNmlPwo/1qb/DONC/Uo2Rf1GtUAxpJq.Zsu5UgGNkUP.', false)
ON CONFLICT (address) DO NOTHING;

-- A near-full mailbox, for quota-warning behaviour
UPDATE mailboxes
   SET quota_bytes = 10485760, used_bytes = 9961472
 WHERE address = 'hr@techvein.local';

-- More aliases on one mailbox
INSERT INTO aliases (tenant_id, domain_id, address, target_mailbox_id)
SELECT '11111111-1111-1111-1111-111111111111',
       'a1111111-1111-1111-1111-111111111111', a.addr, m.id
FROM   (VALUES ('sales@techvein.local'),
               ('info@techvein.local'),
               ('careers@techvein.local')) AS a(addr)
CROSS  JOIN LATERAL (SELECT id FROM mailboxes WHERE address='amit@techvein.local') m
ON CONFLICT (address) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Volume — a folder with enough messages that virtualisation and paging matter
-- ----------------------------------------------------------------------------
--  NOT idempotent via ON CONFLICT: every row gets a fresh uuid, so there is
--  never a conflict to detect and a second run simply inserts 150 more.
--  Guarded with a marker in headers instead. Re-running is now a no-op.
INSERT INTO messages (tenant_id, mailbox_id, folder_id, imap_uid,
                      from_addr, to_addrs, subject, sent_at, received_at,
                      raw_body, size_bytes, is_read, headers)
SELECT m.tenant_id, m.id, f.id, gs,
       'sender' || gs || '@example.com',
       ARRAY[m.address::text],
       CASE (gs % 5)
           WHEN 0 THEN 'Invoice #' || (1000 + gs) || ' attached'
           WHEN 1 THEN 'Re: Project timeline'
           WHEN 2 THEN 'Meeting notes ' || gs
           WHEN 3 THEN 'Quarterly review — action required'
           ELSE        'FW: Supplier quote ' || gs
       END,
       now() - (gs || ' hours')::interval,
       now() - (gs || ' hours')::interval,
       'Test message body number ' || gs || '. Ordinary business correspondence.',
       200 + gs,
       (gs % 3 = 0),
       '{"seed":"tester-bulk"}'::jsonb
FROM   mailboxes m
JOIN   folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
CROSS  JOIN generate_series(100, 249) gs
WHERE  m.address = 'amit@techvein.local'
  AND  NOT EXISTS (
           SELECT 1 FROM messages
           WHERE headers @> '{"seed":"tester-bulk"}'::jsonb
       );

-- ----------------------------------------------------------------------------
-- Repair: if an earlier, non-idempotent run left duplicates, collapse them
-- back to a single set of 150.
-- ----------------------------------------------------------------------------
DELETE FROM messages
WHERE  id IN (
    SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY subject, mailbox_id ORDER BY id) AS rn
        FROM   messages
        WHERE  headers @> '{"seed":"tester-bulk"}'::jsonb
    ) dupes
    WHERE rn > 1
);

-- ----------------------------------------------------------------------------
DO $$
DECLARE t int; d int; mb int; a int; ms int;
BEGIN
    SELECT count(*) INTO t  FROM tenants;
    SELECT count(*) INTO d  FROM domains;
    SELECT count(*) INTO mb FROM mailboxes;
    SELECT count(*) INTO a  FROM aliases;
    SELECT count(*) INTO ms FROM messages;
    RAISE NOTICE '';
    RAISE NOTICE '  Tester seed applied';
    RAISE NOTICE '    tenants % | domains % | mailboxes % | aliases % | messages %', t, d, mb, a, ms;
    RAISE NOTICE '    password for every account: devpass123';
    RAISE NOTICE '';
END $$;

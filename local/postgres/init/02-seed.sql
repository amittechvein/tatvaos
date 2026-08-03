-- ============================================================================
--  TatvaOS Mail - local seed data
-- ============================================================================
--
--  Two tenants, deliberately. One tenant proves nothing about isolation;
--  two lets you demonstrate that tenant A cannot see tenant B's mail, which
--  is the property the whole architecture exists to provide.
--
--  Domains use .local so they can never resolve publicly and no test message
--  can escape to the real internet.
--
--  Every mailbox password is:  devpass123
--  Hashes are SHA512-CRYPT - universally supported by Dovecot.
--  PRODUCTION USES ARGON2ID. This scheme is for local convenience only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tenant 1: Techvein
-- ----------------------------------------------------------------------------

INSERT INTO tenants (id, name, status) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Techvein', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, fqdn, type, is_active, verified_at) VALUES
    ('a1111111-1111-1111-1111-111111111111',
     '11111111-1111-1111-1111-111111111111',
     'techvein.local', 'primary', true, now())
ON CONFLICT (fqdn) DO NOTHING;

INSERT INTO mailboxes (tenant_id, domain_id, address, local_part, type, password_hash) VALUES
    ('11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'amit@techvein.local', 'amit', 'user',
     '{SHA512-CRYPT}$6$tvamitsalt$POiXxoaDNlClpKHyJJIM8red44tVlhXescz5BhynJJTNmlPwo/1qb/DONC/Uo2Rf1GtUAxpJq.Zsu5UgGNkUP.'),

    ('11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'hr@techvein.local', 'hr', 'user',
     '{SHA512-CRYPT}$6$tvhrsalt$2fl1MqBy7SQ.4LfQsMoog60tsctOwons2hXrWZtoe2NlKVb3Jc1X1ZjhuJQZ/WUutqXqo95/PQMvORfmVjEuW1'),

    ('11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'support@techvein.local', 'support', 'shared',
     '{SHA512-CRYPT}$6$tvsupportsalt$1WVTmD4rH17BCFCD4g4/L7y80hoMRiENUDN0YhAG0iG2ROcZDpFFWqCZtGRa9slO3rps8IuT2IeEz468esddO/')
ON CONFLICT (address) DO NOTHING;

-- Aliases pointing at amit@ - proves one mailbox receives for several addresses
INSERT INTO aliases (tenant_id, domain_id, address, target_mailbox_id)
SELECT '11111111-1111-1111-1111-111111111111',
       'a1111111-1111-1111-1111-111111111111',
       a.addr,
       m.id
FROM   (VALUES ('ceo@techvein.local'), ('director@techvein.local')) AS a(addr)
CROSS  JOIN LATERAL (
    SELECT id FROM mailboxes WHERE address = 'amit@techvein.local'
) m
ON CONFLICT (address) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Tenant 2: ABC School  -  exists so isolation can be demonstrated
-- ----------------------------------------------------------------------------

INSERT INTO tenants (id, name, status) VALUES
    ('22222222-2222-2222-2222-222222222222', 'ABC School', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, fqdn, type, is_active, verified_at) VALUES
    ('b2222222-2222-2222-2222-222222222222',
     '22222222-2222-2222-2222-222222222222',
     'abcschool.local', 'primary', true, now())
ON CONFLICT (fqdn) DO NOTHING;

INSERT INTO mailboxes (tenant_id, domain_id, address, local_part, type, password_hash) VALUES
    ('22222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     'principal@abcschool.local', 'principal', 'user',
     '{SHA512-CRYPT}$6$tvprincipalsalt$FaR0AEBMr6g9EmJrZ6mQ9bAKomxJW.nMHSslTvFervrNZOzc52ZINy3KhOgI0QNUYYauCIW5vhvUW6NwPPobq1')
ON CONFLICT (address) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Sample messages, one per tenant, so the isolation test has something to find
-- ----------------------------------------------------------------------------

INSERT INTO messages (tenant_id, mailbox_id, folder_id, imap_uid,
                      from_addr, to_addrs, subject, sent_at, raw_body, size_bytes)
SELECT m.tenant_id, m.id, f.id, 1,
       'someone@example.com',
       ARRAY['amit@techvein.local'],
       'TECHVEIN CONFIDENTIAL - quarterly numbers',
       now(),
       'This message belongs to Techvein and ABC School must never see it.',
       64
FROM   mailboxes m
JOIN   folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
WHERE  m.address = 'amit@techvein.local'
ON CONFLICT DO NOTHING;

INSERT INTO messages (tenant_id, mailbox_id, folder_id, imap_uid,
                      from_addr, to_addrs, subject, sent_at, raw_body, size_bytes)
SELECT m.tenant_id, m.id, f.id, 1,
       'parent@example.com',
       ARRAY['principal@abcschool.local'],
       'ABC SCHOOL CONFIDENTIAL - admissions list',
       now(),
       'This message belongs to ABC School and Techvein must never see it.',
       62
FROM   mailboxes m
JOIN   folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
WHERE  m.address = 'principal@abcschool.local'
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Summary
-- ----------------------------------------------------------------------------

DO $$
DECLARE
    n_tenants   int;
    n_domains   int;
    n_mailboxes int;
    n_aliases   int;
BEGIN
    SELECT count(*) INTO n_tenants   FROM tenants;
    SELECT count(*) INTO n_domains   FROM domains;
    SELECT count(*) INTO n_mailboxes FROM mailboxes;
    SELECT count(*) INTO n_aliases   FROM aliases;

    RAISE NOTICE '';
    RAISE NOTICE '  TatvaOS Mail seed complete';
    RAISE NOTICE '    tenants   : %', n_tenants;
    RAISE NOTICE '    domains   : %', n_domains;
    RAISE NOTICE '    mailboxes : %', n_mailboxes;
    RAISE NOTICE '    aliases   : %', n_aliases;
    RAISE NOTICE '';
    RAISE NOTICE '  All mailbox passwords: devpass123';
    RAISE NOTICE '';
END
$$;

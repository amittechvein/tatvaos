-- ============================================================================
--  TatvaOS - local seed data
-- ============================================================================
--
--  Seeds Core first, then Mail on top of it - the same order the real product
--  works in. A tenant exists, people exist in core.users, and only then does
--  Mail grant some of those people a mailbox.
--
--  Two tenants, deliberately. One tenant proves nothing about isolation; two
--  lets you demonstrate that tenant A cannot see tenant B's mail, which is the
--  property the whole architecture exists to provide.
--
--  Domains use .local so they can never resolve publicly and no test message
--  can escape to the real internet.
--
--  Both storage models are represented on purpose: Techvein per_user, ABC
--  School pooled. The commercial decision between them is still open, and a
--  seed that only exercises one of them lets the other quietly rot.
--
--  IMAP passwords are all:  devpass123
--  Hashes are SHA512-CRYPT - universally supported by Dovecot.
--  PRODUCTION USES ARGON2ID. This scheme is for local convenience only.
-- ============================================================================

-- ============================================================================
--  TENANT 1 - Techvein  (per-user storage)
-- ============================================================================

INSERT INTO core.tenants (id, name, type, status, admin_name, admin_email, country) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Techvein', 'business', 'active',
     'Amit Dadhich', 'amit@techvein.local', 'India')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.domains (id, tenant_id, fqdn, type, is_active,
                          ownership_verified_at, mx_verified_at, dkim_selector) VALUES
    ('a1111111-1111-1111-1111-111111111111',
     '11111111-1111-1111-1111-111111111111',
     'techvein.local', 'primary', true, now(), now(), 'tv2026a')
ON CONFLICT (fqdn) DO NOTHING;

-- NOT ON CONFLICT DO NOTHING. subscriptions has no unique constraint on
-- tenant_id, so a fresh uuid never conflicts and apply-schema.sh would add a
-- second subscription on every run. Same trap as the tester bulk seed.
INSERT INTO core.subscriptions (tenant_id, plan_id, status, seats)
SELECT '11111111-1111-1111-1111-111111111111',
       'a0000000-0000-0000-0000-000000000002',   -- Business
       'active', 10
WHERE NOT EXISTS (
    SELECT 1 FROM core.subscriptions
    WHERE tenant_id = '11111111-1111-1111-1111-111111111111');

INSERT INTO core.storage_pools (tenant_id, storage_model, total_bytes, per_user_quota_bytes) VALUES
    ('11111111-1111-1111-1111-111111111111', 'per_user', 0, 32212254720)  -- 30 GB each
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO core.user_categories (id, tenant_id, name, description,
                                  default_role, default_quota_bytes,
                                  default_products, can_send_external, colour) VALUES
    ('c1111111-1111-1111-1111-111111111111',
     '11111111-1111-1111-1111-111111111111',
     'Staff', 'Full-time employees',
     'employee', 32212254720, ARRAY['mail'], true, '#3563f0')
ON CONFLICT (tenant_id, name) DO NOTHING;

-- ----------------------------------------------------------------------------
--  People. THIS is what Core owns - a person exists here once, and every
--  product keys off the id. password_hash is deliberately NULL: the Core
--  sign-in endpoint does not exist yet, and a hash nothing can verify is
--  worse than an honest null. The IMAP password lives on the mailbox.
-- ----------------------------------------------------------------------------

INSERT INTO core.users (id, tenant_id, domain_id, email, display_name,
                        category_id, role, status) VALUES
    ('d1111111-1111-1111-1111-111111111111',
     '11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'amit@techvein.local', 'Amit Dadhich',
     'c1111111-1111-1111-1111-111111111111', 'owner', 'active'),

    ('d1111111-1111-1111-1111-111111111112',
     '11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'hr@techvein.local', 'HR Department',
     'c1111111-1111-1111-1111-111111111111', 'employee', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.product_access (tenant_id, user_id, product_code)
SELECT u.tenant_id, u.id, 'mail'
FROM   core.users u
WHERE  u.tenant_id = '11111111-1111-1111-1111-111111111111'
ON CONFLICT (user_id, product_code) DO NOTHING;

-- ----------------------------------------------------------------------------
--  Mailboxes. Two belong to people; support@ belongs to nobody.
--
--  support@ is the case that justifies keeping users and mailboxes apart:
--  it receives mail, it has no password of its own, and no person signs in
--  as it. Delegated access goes through mail.mailbox_permissions.
-- ----------------------------------------------------------------------------

INSERT INTO mail.mailboxes (tenant_id, domain_id, user_id, address, local_part,
                            type, imap_password_hash, quota_bytes) VALUES
    ('11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'd1111111-1111-1111-1111-111111111111',
     'amit@techvein.local', 'amit', 'user',
     '{SHA512-CRYPT}$6$tvamitsalt$POiXxoaDNlClpKHyJJIM8red44tVlhXescz5BhynJJTNmlPwo/1qb/DONC/Uo2Rf1GtUAxpJq.Zsu5UgGNkUP.',
     32212254720),

    ('11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'd1111111-1111-1111-1111-111111111112',
     'hr@techvein.local', 'hr', 'user',
     '{SHA512-CRYPT}$6$tvhrsalt$2fl1MqBy7SQ.4LfQsMoog60tsctOwons2hXrWZtoe2NlKVb3Jc1X1ZjhuJQZ/WUutqXqo95/PQMvORfmVjEuW1',
     32212254720),

    ('11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     NULL,
     'support@techvein.local', 'support', 'shared',
     '{SHA512-CRYPT}$6$tvsupportsalt$1WVTmD4rH17BCFCD4g4/L7y80hoMRiENUDN0YhAG0iG2ROcZDpFFWqCZtGRa9slO3rps8IuT2IeEz468esddO/',
     32212254720)
ON CONFLICT (address) DO NOTHING;

-- Amit can read and send as support@. Attribution stays with the human.
INSERT INTO mail.mailbox_permissions (mailbox_id, user_id, permission)
SELECT m.id, 'd1111111-1111-1111-1111-111111111111', 'full'
FROM   mail.mailboxes m
WHERE  m.address = 'support@techvein.local'
ON CONFLICT DO NOTHING;

-- Aliases pointing at amit@ - proves one mailbox receives for several addresses
INSERT INTO mail.aliases (tenant_id, domain_id, address, target_mailbox_id)
SELECT '11111111-1111-1111-1111-111111111111',
       'a1111111-1111-1111-1111-111111111111',
       a.addr,
       m.id
FROM   (VALUES ('ceo@techvein.local'), ('director@techvein.local')) AS a(addr)
CROSS  JOIN LATERAL (
    SELECT id FROM mail.mailboxes WHERE address = 'amit@techvein.local'
) m
ON CONFLICT (address) DO NOTHING;

-- ============================================================================
--  TENANT 2 - ABC School  (pooled storage)
-- ============================================================================
--
--  Exists so isolation can be demonstrated, and so the pooled storage model
--  has a live example. A school buys one number and splits it themselves.
-- ============================================================================

INSERT INTO core.tenants (id, name, type, status, admin_name, admin_email, country) VALUES
    ('22222222-2222-2222-2222-222222222222', 'ABC School', 'school', 'active',
     'Principal', 'principal@abcschool.local', 'India')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.domains (id, tenant_id, fqdn, type, is_active,
                          ownership_verified_at, mx_verified_at, dkim_selector) VALUES
    ('b2222222-2222-2222-2222-222222222222',
     '22222222-2222-2222-2222-222222222222',
     'abcschool.local', 'primary', true, now(), now(), 'tv2026a')
ON CONFLICT (fqdn) DO NOTHING;

INSERT INTO core.subscriptions (tenant_id, plan_id, status, seats)
SELECT '22222222-2222-2222-2222-222222222222',
       'a0000000-0000-0000-0000-000000000003',   -- Institution
       'active', 500
WHERE NOT EXISTS (
    SELECT 1 FROM core.subscriptions
    WHERE tenant_id = '22222222-2222-2222-2222-222222222222');

-- 2 TB bought, split across products by the school's own admin.
INSERT INTO core.storage_pools (tenant_id, storage_model, total_bytes) VALUES
    ('22222222-2222-2222-2222-222222222222', 'pooled', 2199023255552)
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO core.storage_allocations (tenant_id, product_code, allocated_bytes) VALUES
    ('22222222-2222-2222-2222-222222222222', 'mail',  1649267441664),  -- 1.5 TB
    ('22222222-2222-2222-2222-222222222222', 'drive',  549755813888)   -- 0.5 TB
ON CONFLICT (tenant_id, product_code) DO NOTHING;

-- Two categories, because this is the case that sells the product: a school
-- creates 400 students with identical settings in one action.
INSERT INTO core.user_categories (id, tenant_id, name, description,
                                  default_role, default_quota_bytes,
                                  default_products, can_send_external, colour) VALUES
    ('c2222222-2222-2222-2222-222222222221',
     '22222222-2222-2222-2222-222222222222',
     'Teachers', 'Teaching staff',
     'employee', 10737418240, ARRAY['mail'], true, '#0f9d58'),

    ('c2222222-2222-2222-2222-222222222222',
     '22222222-2222-2222-2222-222222222222',
     'Students', 'Enrolled students',
     'student', 2147483648, ARRAY['mail'], false, '#f4b400')
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO core.users (id, tenant_id, domain_id, email, display_name,
                        category_id, role, status) VALUES
    ('d2222222-2222-2222-2222-222222222222',
     '22222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     'principal@abcschool.local', 'Principal',
     'c2222222-2222-2222-2222-222222222221', 'admin', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.product_access (tenant_id, user_id, product_code)
SELECT u.tenant_id, u.id, 'mail'
FROM   core.users u
WHERE  u.tenant_id = '22222222-2222-2222-2222-222222222222'
ON CONFLICT (user_id, product_code) DO NOTHING;

INSERT INTO mail.mailboxes (tenant_id, domain_id, user_id, address, local_part,
                            type, imap_password_hash, quota_bytes) VALUES
    ('22222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     'd2222222-2222-2222-2222-222222222222',
     'principal@abcschool.local', 'principal', 'user',
     '{SHA512-CRYPT}$6$tvprincipalsalt$FaR0AEBMr6g9EmJrZ6mQ9bAKomxJW.nMHSslTvFervrNZOzc52ZINy3KhOgI0QNUYYauCIW5vhvUW6NwPPobq1',
     10737418240)
ON CONFLICT (address) DO NOTHING;

-- ============================================================================
--  Sample messages - one per tenant, so the isolation test has something to
--  find. The subjects are deliberately loud: if one ever appears in the other
--  tenant's result set, it is unmistakable.
-- ============================================================================

INSERT INTO mail.messages (tenant_id, mailbox_id, folder_id, imap_uid,
                           from_addr, to_addrs, subject, sent_at, raw_body, size_bytes)
SELECT m.tenant_id, m.id, f.id, 1,
       'someone@example.com',
       ARRAY['amit@techvein.local'],
       'TECHVEIN CONFIDENTIAL - quarterly numbers',
       now(),
       'This message belongs to Techvein and ABC School must never see it.',
       64
FROM   mail.mailboxes m
JOIN   mail.folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
WHERE  m.address = 'amit@techvein.local'
  -- Guarded by subject, not ON CONFLICT: messages have no unique key, so a
  -- fresh uuid never conflicts and apply-schema.sh would add a copy per run.
  AND  NOT EXISTS (SELECT 1 FROM mail.messages
                   WHERE subject = 'TECHVEIN CONFIDENTIAL - quarterly numbers');

INSERT INTO mail.messages (tenant_id, mailbox_id, folder_id, imap_uid,
                           from_addr, to_addrs, subject, sent_at, raw_body, size_bytes)
SELECT m.tenant_id, m.id, f.id, 1,
       'parent@example.com',
       ARRAY['principal@abcschool.local'],
       'ABC SCHOOL CONFIDENTIAL - admissions list',
       now(),
       'This message belongs to ABC School and Techvein must never see it.',
       62
FROM   mail.mailboxes m
JOIN   mail.folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
WHERE  m.address = 'principal@abcschool.local'
  AND  NOT EXISTS (SELECT 1 FROM mail.messages
                   WHERE subject = 'ABC SCHOOL CONFIDENTIAL - admissions list');

-- ============================================================================
--  Summary
-- ============================================================================

DO $$
DECLARE
    n_tenants   int; n_domains   int; n_users     int;
    n_mailboxes int; n_aliases   int; n_messages  int;
BEGIN
    SELECT count(*) INTO n_tenants   FROM core.tenants;
    SELECT count(*) INTO n_domains   FROM core.domains;
    SELECT count(*) INTO n_users     FROM core.users;
    SELECT count(*) INTO n_mailboxes FROM mail.mailboxes;
    SELECT count(*) INTO n_aliases   FROM mail.aliases;
    SELECT count(*) INTO n_messages  FROM mail.messages;

    RAISE NOTICE '';
    RAISE NOTICE '  TatvaOS seed complete';
    RAISE NOTICE '    core.tenants   : %', n_tenants;
    RAISE NOTICE '    core.domains   : %', n_domains;
    RAISE NOTICE '    core.users     : %   <- identity lives here', n_users;
    RAISE NOTICE '    mail.mailboxes : %   (one shared, no user behind it)', n_mailboxes;
    RAISE NOTICE '    mail.aliases   : %', n_aliases;
    RAISE NOTICE '    mail.messages  : %', n_messages;
    RAISE NOTICE '';
    RAISE NOTICE '  All IMAP passwords: devpass123';
    RAISE NOTICE '';
END
$$;

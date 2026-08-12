-- ============================================================================
--  Family tenant + ownership isolation
-- ============================================================================
--
--  Run against a database that has had local/postgres/init applied:
--
--    docker compose cp ../tests/isolation/family/family-rls.sql \
--        postgres:/tmp/family-rls.sql
--    docker compose exec postgres psql -U postgres -d tatvaos_mail \
--        -v ON_ERROR_STOP=1 -f /tmp/family-rls.sql
--
--  Every check RAISEs on failure, so a non-zero exit means isolation broke.
--
--  ── TWO RULES THIS FILE FOLLOWS, BOTH LEARNED THE HARD WAY ────────────────
--
--  1. THE WHOLE TEST IS ONE TRANSACTION THAT ALWAYS ROLLS BACK.
--     Nothing it writes ever commits, so it leaves no fixtures behind, can be
--     run twice in a row, and — the part that matters — has no cleanup step
--     that could delete a row it did not create. An earlier version ended with
--     a DELETE against core.tenants scoped by the fixture ids. Those ids
--     turned out to be the SEEDED tenants (11111111… is Techvein), so the
--     cleanup would have cascaded through real users, mailboxes and messages.
--
--  2. FIXTURE IDS ARE NAMESPACED f0f0…, NOT 1111….
--     Tidy, memorable ids are exactly the ones a seed file already used.
--
--  What is NOT tested here, deliberately: whether app.tenant_id matches the
--  signed-in person. RLS trusts that value; TenantMiddleware is what makes it
--  trustworthy, and that belongs in an API-level test.
-- ============================================================================

BEGIN;

INSERT INTO core.tenants (id, name) VALUES
  ('f0f0f0f0-0000-4000-8000-00000000000a','ISOLATION PROBE A'),
  ('f0f0f0f0-0000-4000-8000-00000000000b','ISOLATION PROBE B');

INSERT INTO core.users (id, tenant_id, email, display_name) VALUES
  ('f0f0f0f0-1111-4000-8000-000000000001','f0f0f0f0-0000-4000-8000-00000000000a','alice@probe.invalid','Probe Alice'),
  ('f0f0f0f0-1111-4000-8000-000000000002','f0f0f0f0-0000-4000-8000-00000000000a','bob@probe.invalid','Probe Bob'),
  ('f0f0f0f0-1111-4000-8000-000000000003','f0f0f0f0-0000-4000-8000-00000000000b','carol@probe.invalid','Probe Carol');

INSERT INTO family.contacts (id, tenant_id, created_by_user_id, ownership_type, owner_user_id, display_name) VALUES
  ('f0f0f0f0-2222-4000-8000-00000000000a','f0f0f0f0-0000-4000-8000-00000000000a','f0f0f0f0-1111-4000-8000-000000000001','personal','f0f0f0f0-1111-4000-8000-000000000001','Alice Personal'),
  ('f0f0f0f0-2222-4000-8000-00000000000b','f0f0f0f0-0000-4000-8000-00000000000a','f0f0f0f0-1111-4000-8000-000000000001','organisational',NULL,'Shared Supplier'),
  ('f0f0f0f0-2222-4000-8000-00000000000c','f0f0f0f0-0000-4000-8000-00000000000b','f0f0f0f0-1111-4000-8000-000000000003','personal','f0f0f0f0-1111-4000-8000-000000000003','Carol Personal');

INSERT INTO family.contact_emails (tenant_id, contact_id, email, email_normalised) VALUES
  ('f0f0f0f0-0000-4000-8000-00000000000a','f0f0f0f0-2222-4000-8000-00000000000a','Priv.Ate@gmail.com','private@gmail.com');

INSERT INTO family.contact_audit_logs (tenant_id, contact_id, actor_user_id, operation) VALUES
  ('f0f0f0f0-0000-4000-8000-00000000000a','f0f0f0f0-2222-4000-8000-00000000000a','f0f0f0f0-1111-4000-8000-000000000001','create');

SET LOCAL ROLE tatvaos_app;

DO $$
DECLARE
    n int;
    t_a  constant text := 'f0f0f0f0-0000-4000-8000-00000000000a';
    t_b  constant text := 'f0f0f0f0-0000-4000-8000-00000000000b';
    alice constant text := 'f0f0f0f0-1111-4000-8000-000000000001';
    bob   constant text := 'f0f0f0f0-1111-4000-8000-000000000002';
    carol constant text := 'f0f0f0f0-1111-4000-8000-000000000003';
BEGIN
    -- 1. The owner sees her personal contact and the shared one.
    PERFORM set_config('app.tenant_id', t_a,   true);
    PERFORM set_config('app.user_id',   alice, true);
    SELECT count(*) INTO n FROM family.contacts;
    IF n <> 2 THEN RAISE EXCEPTION 'owner should see 2 contacts, saw %', n; END IF;

    -- 2. THE ONE THAT MATTERS. A colleague in the SAME tenant sees the shared
    --    contact and NOT the personal one. Tenant isolation alone would leak
    --    it; this is why the policy reads app.user_id.
    PERFORM set_config('app.user_id', bob, true);
    SELECT count(*) INTO n FROM family.contacts;
    IF n <> 1 THEN RAISE EXCEPTION 'colleague should see 1 contact, saw %', n; END IF;
    SELECT count(*) INTO n FROM family.contacts WHERE display_name = 'Alice Personal';
    IF n <> 0 THEN RAISE EXCEPTION 'colleague can read a personal contact'; END IF;

    -- 3. Child rows follow the parent. Reading the address directly must fail
    --    the same way reading the contact does.
    SELECT count(*) INTO n FROM family.contact_emails;
    IF n <> 0 THEN RAISE EXCEPTION 'colleague can read a personal contact''s address'; END IF;
    SELECT count(*) INTO n FROM family.contact_audit_logs;
    IF n <> 0 THEN RAISE EXCEPTION 'colleague can read a personal contact''s audit trail'; END IF;

    -- 4. Another tenant sees only its own.
    PERFORM set_config('app.tenant_id', t_b,   true);
    PERFORM set_config('app.user_id',   carol, true);
    SELECT count(*) INTO n FROM family.contacts;
    IF n <> 1 THEN RAISE EXCEPTION 'other tenant should see 1 contact, saw %', n; END IF;

    -- 5. An EMPTY context reads nothing. The interceptor writes '' for a
    --    request with no person behind it, and '' must behave as "no access",
    --    not raise on the ::uuid cast.
    PERFORM set_config('app.tenant_id', '', true);
    PERFORM set_config('app.user_id',   '', true);
    SELECT count(*) INTO n FROM family.contacts;
    IF n <> 0 THEN RAISE EXCEPTION 'empty context returned % rows', n; END IF;

    -- 6. Writes are checked too: nobody may file a contact under another
    --    person's name.
    PERFORM set_config('app.tenant_id', t_a, true);
    PERFORM set_config('app.user_id',   bob, true);
    BEGIN
        INSERT INTO family.contacts (tenant_id, ownership_type, owner_user_id, display_name)
        VALUES (t_a::uuid, 'personal', alice::uuid, 'Smuggled');
        RAISE EXCEPTION 'a contact was written under another user''s ownership';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 7. The audit log is append only. A bug in the API must not be able to
    --    rewrite the record of what it did.
    PERFORM set_config('app.user_id', alice, true);
    BEGIN
        UPDATE family.contact_audit_logs SET reason = 'tampered';
        RAISE EXCEPTION 'audit log accepted an UPDATE';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM family.contact_audit_logs;
        RAISE EXCEPTION 'audit log accepted a DELETE';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    RAISE NOTICE 'family isolation: 8/8 passed';
END $$;

-- Never COMMIT. See rule 1 at the top of this file.
ROLLBACK;

-- ============================================================================
--  People — Aadhaar, PAN and bank details (decision 0015, Phase 5)
-- ============================================================================
--
--  Depends on 20261009-people-employees.sql (sorts before this: 20261009 <
--  20261010). HELD FOR MR. SINGH: built on Amit's instruction (10 Oct 2026)
--  before 0015 is ruled; no real identifier goes into production until he has
--  ruled and the lawyer has answered UIDAI's data-vault question (0015 §10.6),
--  which Amit's decision to store full Aadhaar numbers made live.
--
--  WHAT THE DATABASE HOLDS - and what it can never show:
--    people.identifier_keys      one data key per organisation (and version),
--                                stored WRAPPED by the master key, which is
--                                People:IdentifierKey in the server's
--                                environment - not in the database, not in
--                                its backups. A dump of this table is useless
--                                without the server's key file.
--    people.employee_identifiers ciphertext only: AES-256-GCM, a random nonce
--                                per value, the associated data
--                                tenant|employee|kind - a value copied onto
--                                another person, kind or organisation fails to
--                                decrypt. Encrypted IN THE API, before Entity
--                                Framework sees it, so no log, no parameter
--                                trace and no SQL here ever holds a number.
--                                last4 for the masked view; lookup_hash
--                                (HMAC, a second key) for PAN and bank account
--                                only - "already on another employee" without
--                                decrypting anything. Never for Aadhaar.
--    people.identifier_readers   who the organisation names to reveal full
--                                values (Amit, 10 Oct: named people only; an
--                                owner only after naming themselves; the
--                                employee always for their own).
--    people.identifier_reads     ONE ROW PER VALUE REVEALED: who, whose, which
--                                kind, why, when, shown or failed. Append-only
--                                for the app. Never the value, never the last
--                                four. The employee can read their own.
--
--  No card images, ever (Amit, 10 Oct). Additive and re-runnable.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS people.identifier_keys (
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    version      smallint NOT NULL CHECK (version >= 1),
    -- nonce(12) | tag(16) | ciphertext(32): the data key, sealed by the
    -- master key with tenant_id|version as associated data.
    wrapped_key  bytea NOT NULL CHECK (octet_length(wrapped_key) = 60),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, version)
);
COMMENT ON TABLE people.identifier_keys IS
    'Per-organisation data keys, wrapped by People:IdentifierKey (not stored here). Useless without the server key (0015 §4).';

CREATE TABLE IF NOT EXISTS people.employee_identifiers (
    tenant_id     uuid NOT NULL,
    employee_id   uuid NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('aadhaar', 'pan', 'bank_account')),
    -- nonce(12) | tag(16) | ciphertext. Never the value.
    ciphertext    bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 29 AND 200),
    key_version   smallint NOT NULL,
    last4         text NOT NULL CHECK (last4 ~ '^[0-9A-Z]{4}$'),
    -- HMAC-SHA256 of the normalised value; PAN and bank account only.
    lookup_hash   bytea CHECK (lookup_hash IS NULL OR octet_length(lookup_hash) = 32),
    -- IFSC for a bank account: identifies a branch, not a person. Plain.
    ifsc          text CHECK (ifsc IS NULL OR ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
    verified_at   timestamptz,
    verified_by   uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid,
    PRIMARY KEY (tenant_id, employee_id, kind),
    CONSTRAINT fk_identifier_employee FOREIGN KEY (tenant_id, employee_id)
        REFERENCES people.employees (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_identifier_key FOREIGN KEY (tenant_id, key_version)
        REFERENCES people.identifier_keys (tenant_id, version),
    CONSTRAINT ck_identifier_no_aadhaar_lookup CHECK (kind <> 'aadhaar' OR lookup_hash IS NULL),
    CONSTRAINT ck_identifier_ifsc_bank_only CHECK (ifsc IS NULL OR kind = 'bank_account'),
    CONSTRAINT ck_identifier_verified CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);
-- The same PAN or account on two employees of one organisation is refused.
CREATE UNIQUE INDEX IF NOT EXISTS ux_people_identifiers_lookup
    ON people.employee_identifiers (tenant_id, kind, lookup_hash) WHERE lookup_hash IS NOT NULL;
COMMENT ON TABLE people.employee_identifiers IS
    'Aadhaar/PAN/bank: ciphertext bound to tenant|employee|kind, last four for the mask. Never the value (0015).';

CREATE TABLE IF NOT EXISTS people.identifier_readers (
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    added_by    uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    CONSTRAINT fk_identifier_reader_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES core.users (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE people.identifier_readers IS
    'Who may reveal full identifiers (Amit, 10 Oct: named people only). Not People HR automatically, never a manager.';

CREATE TABLE IF NOT EXISTS people.identifier_reads (
    id           bigserial PRIMARY KEY,
    tenant_id    uuid NOT NULL,
    employee_id  uuid NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('aadhaar', 'pan', 'bank_account')),
    reader_id    uuid NOT NULL,
    reason       text NOT NULL CHECK (reason IN ('payroll_setup', 'statutory_filing', 'correction', 'employee_request', 'own_record')),
    note         text CHECK (note IS NULL OR length(note) <= 300),
    outcome      text NOT NULL CHECK (outcome IN ('shown', 'failed')),
    read_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_identifier_read_employee FOREIGN KEY (tenant_id, employee_id)
        REFERENCES people.employees (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_people_identifier_reads_employee
    ON people.identifier_reads (tenant_id, employee_id, read_at);
COMMENT ON TABLE people.identifier_reads IS
    'One row per identifier value revealed (0015 §6). Append-only. Never the value or its last four.';

-- ---- grants: the least each table needs -------------------------------------
GRANT SELECT, INSERT ON people.identifier_keys TO tatvaos_app;               -- keys are never rewritten
GRANT SELECT, INSERT, UPDATE ON people.employee_identifiers TO tatvaos_app;  -- replaced, never deleted by the app
GRANT SELECT, INSERT, DELETE ON people.identifier_readers TO tatvaos_app;
GRANT SELECT, INSERT ON people.identifier_reads TO tatvaos_app;              -- append-only
GRANT USAGE ON SEQUENCE people.identifier_reads_id_seq TO tatvaos_app;

DO $$
DECLARE
    tbl text;
    n   int;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['identifier_keys', 'employee_identifiers', 'identifier_readers', 'identifier_reads'] LOOP
        EXECUTE format('ALTER TABLE people.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE people.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON people.%I', tbl);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON people.%I
            USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    END LOOP;
    SELECT count(*) INTO n FROM pg_policies
     WHERE schemaname = 'people'
       AND tablename IN ('identifier_keys', 'employee_identifiers', 'identifier_readers', 'identifier_reads')
       AND policyname = 'tenant_isolation';
    IF n < 4 THEN
        RAISE WARNING '  people: expected 4 tenant_isolation policies on the identifier tables, found %', n;
    END IF;
END $$;

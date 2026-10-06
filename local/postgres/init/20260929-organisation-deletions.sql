-- ============================================================================
--  Deleting an organisation (Amit, 29 Sept 2026: three organisations made for
--  testing had to go, "and inside created mails", and nothing could do it).
--
--  Until now an organisation could be suspended and never removed. The note
--  in SuspendAsync says removal is "a separate, deliberate action"; this is
--  that action. It is PERMANENT: every row the organisation owns goes in one
--  transaction, and nothing here can bring it back.
--
--  WHAT THIS FILE ADDS — three functions, one table, one trigger. Nothing
--  existing is altered; re-runs on every deploy.
--
--    core.organisation_deletions        what was removed, by whom, when.
--                                       Numbers and names of things, never
--                                       a person's address or a message.
--    core.organisation_row_counts(id)   how many rows name this organisation,
--                                       table by table. The preview AND the
--                                       check afterwards are this one function.
--    core.organisation_delete_blockers  why it may not be deleted, if so.
--    core.delete_organisation(...)      the removal itself.
--    trg_domains_leftover_mail          a domain whose mail files are still on
--                                       disk cannot be registered again.
--
--  WHY A FUNCTION AND NOT A DELETE FROM THE API. Measured on 29 Sept:
--
--    * 83 foreign keys to core.tenants cascade. Two do not: core.invoices and
--      core.invoice_lines are RESTRICT, on purpose — an issued invoice is a
--      tax record. An organisation that was ever invoiced is REFUSED here,
--      and the foreign key refuses it again if this function is ever wrong.
--    * hire.job_openings is RESTRICT against locations and designations,
--      which themselves cascade from the tenant. If the cascade reaches a
--      location before the opening that points at it, the delete fails.
--      MEASURED: with the explicit delete taken out, the test still passed
--      on 29 Sept — the order happened to be kind. The order is the order
--      the constraints were created in, which nothing promises, so the
--      openings are removed first anyway. It costs nothing.
--    * EIGHT columns hold an organisation's id with NO foreign key, so a
--      cascade never reaches them. (The first draft of this header said
--      seven; the measurement said eight.) Seven are deleted by name:
--        connect.meeting_invitations.tenant_id
--        connect.recording_shares.tenant_id
--        connect.recording_share_grants.tenant_id and .subject_tenant_id
--        connect.recording_share_password_failures.tenant_id
--        connect.recording_access_log.tenant_id
--        core.razorpay_events.tenant_id
--      ONE is kept: connect.recording_access_log.subject_tenant_id, a line in
--      ANOTHER organisation's log saying one of these people opened that
--      organisation's recording. It is that organisation's record.
--    * core.signup_drafts is SET NULL, and the sales queue lists every draft
--      that is not completed — the deleted organisation's sign-up would have
--      stayed there with the person's name, email and phone on it.
--    * The app's role cannot delete from the append-only logs (it holds
--      INSERT and SELECT on connect.recording_access_log, by design).
--
--  AND ROW SECURITY. Most of these tables FORCE row-level security on
--  app.tenant_id. A count or a delete made by a role that cannot see through
--  it finds nothing and reports success — the silent failure this repository
--  has met before (the reminder worker, 27 Sept). Every function here checks
--  that its owner CAN see through row security and refuses to run otherwise.
--
--  THE CHECK AFTERWARDS. After the delete, organisation_row_counts is run
--  again inside the same transaction. If any row anywhere still names the
--  organisation — a table added next month by another lane, with no foreign
--  key — the function raises and the whole deletion rolls back. A new table
--  cannot be silently left behind; it stops the button until it is handled.
--
--  FILES ARE NOT IN THE DATABASE. Space's files, Connect's recordings and the
--  DKIM keys are removed by the API after this commits (it is their one
--  writer or their one deleter). MAIL FILES CANNOT BE: the API mounts the
--  maildir read-only. The domains whose mail folders exist on disk are written
--  to mail_dirs_pending, and until a person has removed those folders the
--  trigger below refuses to register the domain again — because a new mailbox
--  at the same address would open onto the old organisation's mail.
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.organisation_deletions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- No foreign key: the organisation is gone. That is the point of the row.
    tenant_id           uuid        NOT NULL,
    name                text        NOT NULL,
    type                text,
    origin              text,
    organisation_created_at timestamptz,
    suspended_at        timestamptz,
    domains             text[]      NOT NULL DEFAULT '{}',
    -- {"core.users.tenant_id": 4, ...} — numbers only.
    counts              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    reason              text,
    deleted_by          uuid        NOT NULL,
    deleted_by_email    text        NOT NULL,
    deleted_at          timestamptz NOT NULL DEFAULT now(),
    -- Files, which the database cannot remove.
    recording_files     text[]      NOT NULL DEFAULT '{}',
    files_removed       jsonb,
    files_removed_at    timestamptz,
    mail_dirs_pending   text[]      NOT NULL DEFAULT '{}',
    mail_dirs_purged_at timestamptz,
    mail_dirs_purged_by text
);

-- Domains whose folder the mail server has removed, one at a time
-- (infra/scripts/maildir-removals.sh --domain, Mr. Singh 29 Sept: each run on
-- Amit's go). A domain is held while it is pending and not in this list;
-- mail_dirs_purged_at is set when every pending domain is in it.
ALTER TABLE core.organisation_deletions
    ADD COLUMN IF NOT EXISTS mail_dirs_removed text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS ix_organisation_deletions_when
    ON core.organisation_deletions (deleted_at DESC);
CREATE INDEX IF NOT EXISTS ix_organisation_deletions_mail_pending
    ON core.organisation_deletions USING gin (mail_dirs_pending)
    WHERE mail_dirs_purged_at IS NULL;

-- The app reads the record and writes what it removed from disk. It cannot
-- add a record (only delete_organisation can), cannot remove one, and cannot
-- mark mail folders as purged: that is set by whoever removed them, from the
-- server, as the database owner.
REVOKE ALL ON core.organisation_deletions FROM tatvaos_app;
GRANT SELECT ON core.organisation_deletions TO tatvaos_app;
GRANT UPDATE (files_removed, files_removed_at) ON core.organisation_deletions TO tatvaos_app;

COMMENT ON TABLE core.organisation_deletions IS
    'One row per organisation permanently deleted: what went, who pressed it, '
    'when, and which files are still on disk. Written only by '
    'core.delete_organisation. Never holds a person''s address or a message.';

-- ---- Can this role see through row security? ------------------------------
CREATE OR REPLACE FUNCTION core.organisation_delete_sees_all()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), false);
$$;
REVOKE ALL ON FUNCTION core.organisation_delete_sees_all() FROM PUBLIC;

-- ---- How many rows name this organisation, table by table ------------------
--
--  Every uuid column whose name contains "tenant", in every schema, found
--  from the catalogue at the moment of the call — so a table added later is
--  counted without anyone remembering to add it here. Partitions are counted
--  through their parent. Zero counts are left out.
CREATE OR REPLACE FUNCTION core.organisation_row_counts(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    r   record;
    n   bigint;
    res jsonb := '{}'::jsonb;
BEGIN
    IF NOT core.organisation_delete_sees_all() THEN
        RAISE EXCEPTION 'organisation_row_counts is owned by %, which cannot see through row security: every count would be 0 and look like an answer', current_user
            USING ERRCODE = 'TVD00';
    END IF;

    FOR r IN
        SELECT ns.nspname AS s, c.relname AS t, a.attname AS col
          FROM pg_attribute a
          JOIN pg_class c      ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE a.attnum > 0 AND NOT a.attisdropped
           AND a.atttypid = 'uuid'::regtype
           AND a.attname ~ 'tenant'
           AND ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'
           AND NOT c.relispartition
           AND NOT (ns.nspname = 'core' AND c.relname IN ('tenants', 'organisation_deletions'))
         ORDER BY 1, 2, 3
    LOOP
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I = $1', r.s, r.t, r.col)
           INTO n USING p_tenant;
        IF n > 0 THEN
            res := res || jsonb_build_object(r.s || '.' || r.t || '.' || r.col, n);
        END IF;
    END LOOP;

    RETURN res;
END $$;
REVOKE ALL ON FUNCTION core.organisation_row_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.organisation_row_counts(uuid) TO tatvaos_app;

-- ---- Why it may not be deleted ---------------------------------------------
--
--  One row per reason; no rows = it may be deleted. The console shows these
--  before the button is offered, and delete_organisation runs the same
--  function again, so the screen and the act cannot disagree.
CREATE OR REPLACE FUNCTION core.organisation_delete_blockers(p_tenant uuid, p_actor uuid)
RETURNS TABLE (code text, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    org     core.tenants%ROWTYPE;
    n       bigint;
    v_hours int;
BEGIN
    IF NOT core.organisation_delete_sees_all() THEN
        RAISE EXCEPTION 'organisation_delete_blockers is owned by %, which cannot see through row security: it would find no invoices and no operators and allow everything', current_user
            USING ERRCODE = 'TVD00';
    END IF;

    SELECT * INTO org FROM core.tenants WHERE id = p_tenant;
    IF NOT FOUND THEN
        code := 'TVD01'; reason := 'There is no such organisation.'; RETURN NEXT; RETURN;
    END IF;

    IF org.kind <> 'organisation' THEN
        code := 'TVD02';
        reason := 'This is the organisation personal accounts live in. It cannot be deleted.';
        RETURN NEXT;
    END IF;

    IF org.status <> 'suspended' THEN
        code := 'TVD03';
        reason := 'Suspend the organisation first. Deleting is the second step, not the first.';
        RETURN NEXT;
    ELSE
        -- SUSPENDED FOR AT LEAST 24 HOURS (Mr. Singh, 29 Sept 2026): long
        -- enough to stop a press made in anger or by mistake. A platform
        -- setting so it can be RAISED; a value below 24, or one that is not a
        -- whole number, is read as 24. It cannot be lowered from the console.
        -- A suspension with no time on it (made before suspended_at was
        -- written) counts as just now.
        v_hours := 24;
        BEGIN
            SELECT GREATEST(24, value::int) INTO v_hours
              FROM core.platform_settings WHERE key = 'organisations.delete_after_suspended_hours';
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_hours := 24;
        END;
        v_hours := COALESCE(v_hours, 24);
        IF COALESCE(org.suspended_at, now()) > now() - make_interval(hours => v_hours) THEN
            code := 'TVD10';
            reason := format('Suspended %s. It can be deleted from %s (IST), %s hours after suspension.',
                CASE WHEN org.suspended_at IS NULL THEN 'at an unrecorded time, counted as now'
                     ELSE 'at ' || to_char(org.suspended_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' (IST)' END,
                to_char((COALESCE(org.suspended_at, now()) + make_interval(hours => v_hours)) AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'),
                v_hours);
            RETURN NEXT;
        END IF;
    END IF;

    SELECT count(*) INTO n FROM core.users u WHERE u.tenant_id = p_tenant AND u.role = 'super_admin';
    IF n > 0 THEN
        code := 'TVD05';
        reason := 'A platform operator belongs to this organisation. Move or remove the operator first.';
        RETURN NEXT;
    END IF;

    IF EXISTS (SELECT 1 FROM core.users u WHERE u.id = p_actor AND u.tenant_id = p_tenant) THEN
        code := 'TVD06';
        reason := 'This is your own organisation.';
        RETURN NEXT;
    END IF;

    IF to_regclass('core.invoices') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM core.invoices WHERE tenant_id = $1' INTO n USING p_tenant;
        IF n > 0 THEN
            code := 'TVD07';
            reason := format('%s invoice(s) were issued to this organisation. Invoices are tax records and are kept; the organisation stays suspended instead.', n);
            RETURN NEXT;
        END IF;
    END IF;

    RETURN;
END $$;
REVOKE ALL ON FUNCTION core.organisation_delete_blockers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.organisation_delete_blockers(uuid, uuid) TO tatvaos_app;

-- ---- The removal ------------------------------------------------------------
--
--  p_typed_name   what the operator typed into the box; must be the
--                 organisation's name exactly (surrounding spaces ignored).
--  p_actor        the operator. Must be an active super_admin — checked HERE
--                 as well as by the API's policy, so a future route that
--                 forgets the policy still cannot delete.
--  p_mail_dirs    the organisation's domains whose mail folder exists on
--                 disk, as the API saw them a moment before. Only domains the
--                 organisation actually holds are accepted.
--
--  Returns the id of the core.organisation_deletions row.
CREATE OR REPLACE FUNCTION core.delete_organisation(
    p_tenant uuid, p_typed_name text, p_actor uuid, p_reason text, p_mail_dirs text[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    org        core.tenants%ROWTYPE;
    actor      core.users%ROWTYPE;
    b          record;
    v_counts   jsonb;
    v_left     jsonb;
    v_domains  text[];
    v_files    text[] := '{}';
    v_users    uuid[];
    v_record   uuid;
    v_bad      text;
    v_col      record;
BEGIN
    IF NOT core.organisation_delete_sees_all() THEN
        RAISE EXCEPTION 'delete_organisation is owned by %, which cannot see through row security: it would delete what it can see and report the rest as gone', current_user
            USING ERRCODE = 'TVD00';
    END IF;

    -- Held until the transaction ends: nothing can activate the organisation
    -- or rename it between the checks and the delete.
    SELECT * INTO org FROM core.tenants WHERE id = p_tenant FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'There is no such organisation.' USING ERRCODE = 'TVD01';
    END IF;

    SELECT * INTO actor FROM core.users WHERE id = p_actor;
    IF NOT FOUND OR actor.role <> 'super_admin' OR actor.status <> 'active' THEN
        RAISE EXCEPTION 'Only an active platform operator may delete an organisation.' USING ERRCODE = 'TVD08';
    END IF;

    FOR b IN SELECT * FROM core.organisation_delete_blockers(p_tenant, p_actor) LOOP
        RAISE EXCEPTION '%', b.reason USING ERRCODE = b.code;
    END LOOP;

    IF p_typed_name IS NULL OR btrim(p_typed_name) <> btrim(org.name) THEN
        RAISE EXCEPTION 'The name typed does not match the organisation''s name.' USING ERRCODE = 'TVD04';
    END IF;

    SELECT COALESCE(array_agg(lower(d.fqdn::text) ORDER BY d.fqdn), '{}') INTO v_domains
      FROM core.domains d WHERE d.tenant_id = p_tenant;

    SELECT string_agg(x, ', ') INTO v_bad
      FROM unnest(COALESCE(p_mail_dirs, '{}')) AS x
     WHERE NOT (lower(x) = ANY (v_domains));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Mail folders were named for domains this organisation does not hold: %', v_bad
            USING ERRCODE = 'TVD11';
    END IF;

    SELECT COALESCE(array_agg(u.id), '{}') INTO v_users FROM core.users u WHERE u.tenant_id = p_tenant;

    -- Through the meeting, not a tenant column on the recording: that column
    -- arrives with decision 0007 and may not be here yet.
    IF to_regclass('connect.recordings') IS NOT NULL THEN
        EXECUTE $q$
            SELECT COALESCE(array_agg(r.file_name ORDER BY r.file_name), '{}')
              FROM connect.recordings r
              JOIN connect.meetings m ON m.id = r.meeting_id
             WHERE m.tenant_id = $1 AND r.file_name IS NOT NULL AND r.file_name <> ''
        $q$ INTO v_files USING p_tenant;
    END IF;

    v_counts := core.organisation_row_counts(p_tenant);

    INSERT INTO core.organisation_deletions
        (tenant_id, name, type, origin, organisation_created_at, suspended_at, domains, counts,
         reason, deleted_by, deleted_by_email, recording_files, mail_dirs_pending)
    VALUES
        (org.id, org.name, org.type, org.origin, org.created_at, org.suspended_at, v_domains, v_counts,
         NULLIF(btrim(COALESCE(p_reason, '')), ''), actor.id, actor.email::text, v_files,
         COALESCE((SELECT array_agg(lower(x)) FROM unnest(p_mail_dirs) AS x), '{}'))
    RETURNING id INTO v_record;

    -- 1. What a cascade could trip over (see the header: not needed today,
    --    by luck of ordering).
    IF to_regclass('hire.job_openings') IS NOT NULL THEN
        EXECUTE 'DELETE FROM hire.job_openings WHERE tenant_id = $1' USING p_tenant;
    END IF;

    -- 2. What a cascade never reaches (no foreign key to core.tenants).
    IF to_regclass('connect.recording_share_grants') IS NOT NULL THEN
        -- Grants this organisation made, and grants made TO it or to its
        -- people by anyone else: a grant to nobody is dead weight.
        EXECUTE 'DELETE FROM connect.recording_share_grants
                  WHERE tenant_id = $1 OR subject_tenant_id = $1 OR subject_user_id = ANY ($2)'
          USING p_tenant, v_users;
    END IF;
    IF to_regclass('connect.recording_share_password_failures') IS NOT NULL THEN
        EXECUTE 'DELETE FROM connect.recording_share_password_failures WHERE tenant_id = $1' USING p_tenant;
    END IF;
    IF to_regclass('connect.recording_access_log') IS NOT NULL THEN
        -- This organisation's own log goes with it. A line in ANOTHER
        -- organisation's log saying one of these people opened THEIR
        -- recording is that organisation's record, and stays; it holds ids
        -- that now resolve to nothing.
        EXECUTE 'DELETE FROM connect.recording_access_log WHERE tenant_id = $1' USING p_tenant;

        -- ...but with no name or email of the deleted person left in it
        -- (Mr. Singh, 30 Sept 2026: "keep the other organisation's
        -- access-log line, but blank any name or email in it"). Today the
        -- table has no such column (ids, a level, an address prefix, a
        -- time). This finds any column named like a name or an email, from
        -- the catalogue, so one added later is blanked without anyone
        -- remembering to come here. One that cannot be blanked (NOT NULL,
        -- or not text) stops the deletion instead of keeping it.
        FOR v_col IN
            SELECT a.attname, a.attnotnull, format_type(a.atttypid, a.atttypmod) AS typ
              FROM pg_attribute a
             WHERE a.attrelid = 'connect.recording_access_log'::regclass
               AND a.attnum > 0 AND NOT a.attisdropped
               AND (a.attname ~* 'email' OR a.attname ~* 'name')
        LOOP
            IF v_col.attnotnull OR v_col.typ NOT IN ('text', 'citext', 'character varying') THEN
                RAISE EXCEPTION 'connect.recording_access_log.% may hold a name or an email and cannot be blanked (% %). Nothing was deleted; core.delete_organisation must be taught how to blank it.',
                    v_col.attname, v_col.typ, CASE WHEN v_col.attnotnull THEN 'NOT NULL' ELSE '' END
                    USING ERRCODE = 'TVD12';
            END IF;
            EXECUTE format('UPDATE connect.recording_access_log SET %I = NULL WHERE subject_tenant_id = $1 OR subject_user_id = ANY ($2)',
                           v_col.attname)
              USING p_tenant, v_users;
        END LOOP;
    END IF;
    IF to_regclass('connect.recording_shares') IS NOT NULL THEN
        EXECUTE 'DELETE FROM connect.recording_shares WHERE tenant_id = $1' USING p_tenant;
    END IF;
    IF to_regclass('connect.meeting_invitations') IS NOT NULL THEN
        EXECUTE 'DELETE FROM connect.meeting_invitations WHERE tenant_id = $1' USING p_tenant;
    END IF;
    IF to_regclass('core.razorpay_events') IS NOT NULL THEN
        -- Only ever written for an invoice's payment link, and an invoiced
        -- organisation is refused above, so today this finds nothing. Deleted
        -- explicitly anyway (Mr. Singh, 29 Sept): a column with no foreign
        -- key is removed by name, not left to "cannot happen".
        EXECUTE 'DELETE FROM core.razorpay_events WHERE tenant_id = $1' USING p_tenant;
    END IF;

    -- 3. The sign-up it came from, which holds a name, an email and a phone
    --    and would otherwise reappear in the sales queue.
    DELETE FROM core.signup_drafts WHERE converted_tenant_id = p_tenant;

    -- 4. Everything else, by cascade.
    DELETE FROM core.tenants WHERE id = p_tenant;

    -- 5. Did it all go? TWO columns are left on purpose and not counted:
    --    * another organisation's access log, where a line says one of these
    --      people opened THAT organisation's recording (above);
    --    * core.retired_addresses (PR 326): when the cascade deletes the
    --      organisation's mailboxes and aliases, 326's triggers write a hold
    --      for each address, so nobody new can be handed the old owner's
    --      mail from disk. Those rows are MEANT to outlive the organisation
    --      ("no FK: the row must outlive the tenant", Mr. Singh's design);
    --      deleting them here would undo exactly what they are for. They are
    --      released by a person in the console once the mail server counts
    --      zero files (infra/scripts/maildir-removals.sh).
    --    Found 6 Oct 2026: 326 merged after this function was written, and
    --    this very check refused the deletion (TVD09) until it was named here.
    v_left := core.organisation_row_counts(p_tenant)
              - 'connect.recording_access_log.subject_tenant_id'
              - 'core.retired_addresses.tenant_id';
    IF v_left <> '{}'::jsonb THEN
        RAISE EXCEPTION 'Rows still name this organisation after the delete: %. Nothing was deleted. A table has no foreign key to core.tenants and is not handled in core.delete_organisation.', v_left
            USING ERRCODE = 'TVD09';
    END IF;

    RETURN v_record;
END $$;
REVOKE ALL ON FUNCTION core.delete_organisation(uuid, text, uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.delete_organisation(uuid, text, uuid, text, text[]) TO tatvaos_app;

-- ---- A domain with mail still on disk cannot be registered again -----------
--
--  Mail lives at vhosts/{domain}/{local part}. Register the domain again,
--  create the same address, and the new mailbox opens onto the old one's
--  mail. Until the folder has been removed and the record says so, the domain
--  is refused — for every route that adds a domain, which is why this is a
--  trigger and not a check in one endpoint. (fqdn is citext and the list is
--  text[]: without the cast there is no such operator and EVERY insert into
--  core.domains fails — the first run of tests/admin-org-delete found it.)
--  The question itself, in one place: the trigger, the API's friendly
--  refusal and the removal script all ask it the same way.
CREATE OR REPLACE FUNCTION core.domain_mail_held(p_fqdn text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM core.organisation_deletions d
                    WHERE d.mail_dirs_purged_at IS NULL
                      AND lower(p_fqdn) = ANY (d.mail_dirs_pending)
                      AND NOT (lower(p_fqdn) = ANY (d.mail_dirs_removed)));
$$;
REVOKE ALL ON FUNCTION core.domain_mail_held(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.domain_mail_held(text) TO tatvaos_app;

CREATE OR REPLACE FUNCTION core.refuse_domain_with_leftover_mail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF core.domain_mail_held(NEW.fqdn::text) THEN
        RAISE EXCEPTION 'The domain % belonged to an organisation that was deleted, and its mail is still on the server. It can be registered again once that mail has been removed.', NEW.fqdn
            USING ERRCODE = 'TVD20';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.refuse_domain_with_leftover_mail() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_domains_leftover_mail ON core.domains;
CREATE TRIGGER trg_domains_leftover_mail
    BEFORE INSERT OR UPDATE OF fqdn ON core.domains
    FOR EACH ROW EXECUTE FUNCTION core.refuse_domain_with_leftover_mail();

-- ---- The wait, as a setting ----------------------------------------------
INSERT INTO core.platform_settings (key, value, is_secret)
VALUES ('organisations.delete_after_suspended_hours', '24', false)
ON CONFLICT (key) DO NOTHING;

-- ---- Only the function deletes an organisation -------------------------------
--
--  The app's role had DELETE on core.tenants from the default privileges the
--  core schema was created with. Nothing in the API used it, and any bug that
--  reached a tenant DELETE would have removed an organisation with every one
--  of the checks above skipped. Revoked (Mr. Singh, 29 Sept 2026): the only
--  way left is core.delete_organisation, which is SECURITY DEFINER and runs
--  as its owner. A default privilege applies only when a table is created, so
--  no later file grants it back; tests/admin-org-delete checks it every run.
REVOKE DELETE ON core.tenants FROM tatvaos_app;

DO $$
DECLARE gone int; pending int;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE mail_dirs_pending <> '{}' AND mail_dirs_purged_at IS NULL)
      INTO gone, pending FROM core.organisation_deletions;
    RAISE NOTICE 'organisation-deletions: % organisation(s) deleted so far, % with mail folders still on disk', gone, pending;
    IF NOT core.organisation_delete_sees_all() THEN
        RAISE WARNING 'organisation-deletions: this file was run by %, which cannot see through row security. The delete functions will refuse to run.', current_user;
    END IF;
    IF has_table_privilege('tatvaos_app', 'core.tenants', 'DELETE') THEN
        RAISE WARNING 'organisation-deletions: tatvaos_app can still DELETE from core.tenants directly — the revoke above did not hold';
    END IF;
END $$;

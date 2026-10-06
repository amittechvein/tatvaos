-- ============================================================================
--  Personal accounts, part F: the account's life — inactive, self-deleted,
--  suspended — and what is left behind (build plan §8).
--
--  DEPENDS ON (sorts after, hence "zzzz-"): 20260926-a-personal-join.sql
--  (core.personal_accounts), and nothing else of this day's.
-- ============================================================================
--
--  1. core.personal_accounts gains the lifecycle's dates:
--       deletion_requested_at / delete_after  — self-delete (7-day grace) or
--                                              the inactive rule's end
--       inactive_warned_at / inactive_final_warned_at — the two warnings
--       suspended_at / suspended_reason / suspended_by — abuse (the person
--                                              can still sign in and download,
--                                              but not send)
--     No new users.status value: widening that CHECK is a constraint change,
--     and a suspended personal account must still be ABLE to sign in, which
--     users.status = 'suspended' forbids everywhere.
--
--  2. core.address_holds — an address a deleted personal account used, held
--     so nobody can take it and receive the previous owner's mail (§8: freed
--     after 90 days). PersonalAddress.IsTakenAsync reads it.
--
--  3. core.personal_purge_leftovers — files a purge could not delete (a
--     Space blob, a recording, a maildir). Retried by the lifecycle worker.
--     While a MAILDIR leftover exists for an address, that address's hold is
--     NOT released whatever its date says: the mail importer matches by
--     address, so a new owner would be handed the old owner's mail.
--
--  Additive; re-runs on every deploy.
-- ============================================================================

ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS deletion_requested_at   timestamptz;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS delete_after            timestamptz;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS deletion_reason         text;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS inactive_warned_at      timestamptz;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS inactive_final_warned_at timestamptz;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS suspended_at            timestamptz;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS suspended_reason        text;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS suspended_by            uuid;
-- Download my data (Mr. Singh on PR 319): a one-use, ten-minute link, one a day.
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS export_nonce_hash       text;
ALTER TABLE core.personal_accounts ADD COLUMN IF NOT EXISTS last_export_at          timestamptz;

CREATE INDEX IF NOT EXISTS idx_core_personal_accounts_delete_after
    ON core.personal_accounts (delete_after) WHERE delete_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.address_holds (
    address     citext PRIMARY KEY,
    held_until  timestamptz NOT NULL,
    reason      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON core.address_holds TO tatvaos_app;
COMMENT ON TABLE core.address_holds IS
    'Addresses a deleted personal account used, held until held_until (§8: 90 days) '
    'so nobody receives the previous owner''s mail. Never released while a maildir '
    'leftover for the address exists (core.personal_purge_leftovers).';

CREATE TABLE IF NOT EXISTS core.personal_purge_leftovers (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('space_blob', 'recording', 'maildir')),
    ref         text NOT NULL,          -- blob key, recording path, or maildir address
    address     citext,                 -- the deleted account's address
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, ref)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON core.personal_purge_leftovers TO tatvaos_app;

-- ---- 4. The purge: every row a personal account owns, in ONE statement batch --
--  Called by PersonalLifecycle inside a transaction. Returns the FILES still
--  to remove (Space blobs, recording files, the maildir) — the caller deletes
--  those AFTER the rows are gone and records any that fail as leftovers.
--
--  Refuses anyone outside the personal house: this function must never be
--  the way an organisation's person disappears. Organisations keep their soft
--  delete (UserEndpoints.DeleteAsync), untouched.
--
--  What is removed: their Space files and folders (their own, not things
--  shared with them), the meetings they HOSTED (with chat, minutes,
--  recordings, transcripts — all by cascade), their calendars, their
--  contacts, their mailbox (messages, folders, filters, signatures — by
--  cascade), and the person (sessions, avatar, plan, AI switch, product
--  access — by cascade). Their attendance in OTHER people's meetings stays,
--  nameless (participants.user_id SET NULL): it is part of the host's record.
--  core.audit_logs stays (append-only, the platform's legal record).
--  core.ai_trials stays with user_id NULL: one trial per phone, ever (§8).
CREATE OR REPLACE FUNCTION core.purge_personal_account(p_user uuid)
RETURNS TABLE (kind text, ref text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
    v_tenant uuid;
    v_email  text;
BEGIN
    SELECT u.tenant_id, u.email INTO v_tenant, v_email
      FROM core.users u JOIN core.tenants t ON t.id = u.tenant_id
     WHERE u.id = p_user AND t.kind = 'personal_house';
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'purge_personal_account: % is not a personal account', p_user
            USING ERRCODE = 'check_violation';
    END IF;

    -- Files to remove after the rows (returned, not deleted here).
    RETURN QUERY
        SELECT 'space_blob'::text, f.blob_key::text
          FROM space.files f
         WHERE f.tenant_id = v_tenant AND f.owner_user_id = p_user AND f.blob_key IS NOT NULL;
    RETURN QUERY
        SELECT 'recording'::text, r.file_name::text
          FROM connect.recordings r JOIN connect.meetings m ON m.id = r.meeting_id
         WHERE m.tenant_id = v_tenant AND m.created_by_user_id = p_user AND r.file_name IS NOT NULL;
    RETURN QUERY SELECT 'maildir'::text, v_email::text;

    DELETE FROM space.files   WHERE tenant_id = v_tenant AND owner_user_id = p_user;
    DELETE FROM space.folders WHERE tenant_id = v_tenant AND owner_user_id = p_user;
    DELETE FROM connect.meetings WHERE tenant_id = v_tenant AND created_by_user_id = p_user;
    DELETE FROM calendar.calendars WHERE tenant_id = v_tenant AND owner_user_id = p_user;
    DELETE FROM family.contacts WHERE tenant_id = v_tenant AND owner_user_id = p_user;
    DELETE FROM mail.mailboxes WHERE tenant_id = v_tenant AND user_id = p_user;
    DELETE FROM core.users WHERE id = p_user;

    -- The address, held (§8). 90 days from now; never released while a
    -- maildir leftover for it exists (PersonalLifecycle checks before it lets
    -- IsTakenAsync see it as free).
    INSERT INTO core.address_holds (address, held_until, reason)
    VALUES (v_email, now() + interval '90 days', 'deleted personal account')
    ON CONFLICT (address) DO UPDATE SET held_until = EXCLUDED.held_until, reason = EXCLUDED.reason;
END $$;
REVOKE ALL ON FUNCTION core.purge_personal_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.purge_personal_account(uuid) TO tatvaos_app;

DO $$
DECLARE deleting int; suspended int; holds int; leftovers int;
BEGIN
    SELECT count(*) INTO deleting  FROM core.personal_accounts WHERE delete_after IS NOT NULL;
    SELECT count(*) INTO suspended FROM core.personal_accounts WHERE suspended_at IS NOT NULL;
    SELECT count(*) INTO holds     FROM core.address_holds WHERE held_until > now();
    SELECT count(*) INTO leftovers FROM core.personal_purge_leftovers;
    RAISE NOTICE 'personal lifecycle: % scheduled for deletion, % suspended, % address hold(s), % purge leftover(s).',
        deleting, suspended, holds, leftovers;
END $$;

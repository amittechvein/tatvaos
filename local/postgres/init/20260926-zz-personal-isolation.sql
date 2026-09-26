-- ============================================================================
--  Personal accounts, part C: strangers must not see each other — the
--  DATABASE layer (build plan personal-plans-build-plan.md §6).
--
--  DEPENDS ON 20260926-a-personal-join.sql (core.tenants.kind) and on the
--  product schemas (space, family, calendar, connect, mail); sorts last of
--  the day ("zz-") for that reason.
-- ============================================================================
--
--  The API refuses these first, with a sentence a person can read
--  (PersonalGuard, and checks in the handlers). This file is the backstop for
--  every path that does NOT go through those handlers — a worker, an import,
--  the cross-product save gateway, a future endpoint someone forgets: in the
--  personal house the row itself cannot exist, so it cannot be seen.
--
--  1. The house can never have AI switched on at ORGANISATION level (§6:
--     "the house tenant's allow_ai must never switch AI on for anyone"). AI
--     consent there is per person (D3, part D). A CHECK constraint, so no
--     code path and no operator can set it.
--  2. Triggers refusing, IN THE HOUSE ONLY, every row whose meaning is
--     "everyone in this organisation":
--       space.files / space.folders   ownership_type = 'organisational'
--       space.shares                  org_wide
--       family.contacts               ownership_type = 'organisational'
--       family.contact_groups         any row (groups are tenant-wide)
--       calendar.calendars            kind organisation | resource
--       connect.recording_shares      level = 'organisation'
--       mail.mailbox_permissions      any row (delegation)
--     Organisations are untouched: each trigger fires only for a row whose
--     tenant is the personal house, via WHEN on the column that matters, so
--     an organisation's writes do not even call the function.
--
--  Additive. Re-runs on every deploy: CREATE OR REPLACE, DROP TRIGGER IF
--  EXISTS before CREATE, the constraint guarded.
-- ============================================================================

-- ---- 1. No organisation-level AI in the house -------------------------------
UPDATE core.tenants
   SET allow_ai = false, allow_mail_ai = false, mail_ai_triage_since = NULL
 WHERE kind = 'personal_house'
   AND (allow_ai OR allow_mail_ai OR mail_ai_triage_since IS NOT NULL);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'tenants_house_no_org_ai' AND conrelid = 'core.tenants'::regclass) THEN
        ALTER TABLE core.tenants ADD CONSTRAINT tenants_house_no_org_ai
            CHECK (kind <> 'personal_house'
                   OR (NOT allow_ai AND NOT allow_mail_ai AND mail_ai_triage_since IS NULL));
    END IF;
END $$;

-- ---- 2. Organisation-wide rows cannot exist in the house --------------------
CREATE OR REPLACE FUNCTION core.refuse_in_personal_house() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM core.tenants WHERE id = NEW.tenant_id AND kind = 'personal_house') THEN
        RAISE EXCEPTION 'personal accounts: % is not available in the personal house', TG_ARGV[0]
            USING ERRCODE = 'check_violation',
                  HINT = 'Strangers must not see each other (build plan §6). The API should have refused this first.';
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION core.refuse_in_personal_house() IS
    'Refuses an organisation-wide row whose tenant is the personal house. '
    '20260926-zz-personal-isolation.sql; the API refuses first, this is the backstop.';

DROP TRIGGER IF EXISTS trg_house_no_org_files ON space.files;
CREATE TRIGGER trg_house_no_org_files BEFORE INSERT OR UPDATE OF ownership_type ON space.files
    FOR EACH ROW WHEN (NEW.ownership_type = 'organisational')
    EXECUTE FUNCTION core.refuse_in_personal_house('an organisation file');

DROP TRIGGER IF EXISTS trg_house_no_org_folders ON space.folders;
CREATE TRIGGER trg_house_no_org_folders BEFORE INSERT OR UPDATE OF ownership_type ON space.folders
    FOR EACH ROW WHEN (NEW.ownership_type = 'organisational')
    EXECUTE FUNCTION core.refuse_in_personal_house('an organisation folder');

DROP TRIGGER IF EXISTS trg_house_no_orgwide_shares ON space.shares;
CREATE TRIGGER trg_house_no_orgwide_shares BEFORE INSERT OR UPDATE OF org_wide ON space.shares
    FOR EACH ROW WHEN (NEW.org_wide)
    EXECUTE FUNCTION core.refuse_in_personal_house('sharing with everyone');

DROP TRIGGER IF EXISTS trg_house_no_org_contacts ON family.contacts;
CREATE TRIGGER trg_house_no_org_contacts BEFORE INSERT OR UPDATE OF ownership_type ON family.contacts
    FOR EACH ROW WHEN (NEW.ownership_type = 'organisational')
    EXECUTE FUNCTION core.refuse_in_personal_house('an organisation contact');

DROP TRIGGER IF EXISTS trg_house_no_contact_groups ON family.contact_groups;
CREATE TRIGGER trg_house_no_contact_groups BEFORE INSERT ON family.contact_groups
    FOR EACH ROW
    EXECUTE FUNCTION core.refuse_in_personal_house('a contact group');

DROP TRIGGER IF EXISTS trg_house_no_org_calendars ON calendar.calendars;
CREATE TRIGGER trg_house_no_org_calendars BEFORE INSERT OR UPDATE OF kind ON calendar.calendars
    FOR EACH ROW WHEN (NEW.kind IN ('organisation', 'resource'))
    EXECUTE FUNCTION core.refuse_in_personal_house('an organisation calendar');

DROP TRIGGER IF EXISTS trg_house_no_org_recording_shares ON connect.recording_shares;
CREATE TRIGGER trg_house_no_org_recording_shares BEFORE INSERT OR UPDATE OF level ON connect.recording_shares
    FOR EACH ROW WHEN (NEW.level = 'organisation')
    EXECUTE FUNCTION core.refuse_in_personal_house('sharing a recording with everyone');

-- Delegation: mail.mailbox_permissions has no tenant_id; its mailbox does.
CREATE OR REPLACE FUNCTION mail.refuse_delegation_in_personal_house() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM mail.mailboxes m JOIN core.tenants t ON t.id = m.tenant_id
                WHERE m.id = NEW.mailbox_id AND t.kind = 'personal_house') THEN
        RAISE EXCEPTION 'personal accounts: mailbox delegation is not available in the personal house'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_house_no_delegation ON mail.mailbox_permissions;
CREATE TRIGGER trg_house_no_delegation BEFORE INSERT ON mail.mailbox_permissions
    FOR EACH ROW EXECUTE FUNCTION mail.refuse_delegation_in_personal_house();

-- Report what is here, rather than assert what should be. Any count above zero
-- predates this file and needs a person to look at it.
DO $$
DECLARE house uuid; n int;
BEGIN
    SELECT id INTO house FROM core.tenants WHERE kind = 'personal_house';
    IF house IS NULL THEN
        RAISE NOTICE 'personal isolation: no personal house yet; triggers armed.';
        RETURN;
    END IF;
    SELECT (SELECT count(*) FROM space.files WHERE tenant_id = house AND ownership_type = 'organisational')
         + (SELECT count(*) FROM space.folders WHERE tenant_id = house AND ownership_type = 'organisational')
         + (SELECT count(*) FROM space.shares WHERE tenant_id = house AND org_wide)
         + (SELECT count(*) FROM family.contacts WHERE tenant_id = house AND ownership_type = 'organisational')
         + (SELECT count(*) FROM family.contact_groups WHERE tenant_id = house)
         + (SELECT count(*) FROM calendar.calendars WHERE tenant_id = house AND kind IN ('organisation','resource'))
      INTO n;
    RAISE NOTICE 'personal isolation: triggers armed; % organisation-wide row(s) already in the house.', n;
END $$;

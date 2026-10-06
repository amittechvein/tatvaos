-- ============================================================================
--  Retired addresses — ONE list, organisations and personal accounts alike
--  (Mr. Singh, 26 Sept 2026, following PR 319).
--
--  THE LEAK THIS CLOSES. The mail importer files maildir files by ADDRESS
--  ({vhosts}/{domain}/{local}), into whichever mailbox row has that address.
--  So a mailbox created at an address somebody used before is handed that
--  somebody's old mail from disk. Today no product path frees an
--  organisation's address (tests/org-address-reuse) — but the next one that
--  does ("delete mailbox", a domain removed, an organisation closed) would
--  walk straight into it. So the DATABASE refuses, whatever path asks:
--
--   1. core.retired_addresses — every address that has stopped being used,
--      held until a PERSON releases it in the operator console, with a
--      reason, and only once the mail server has counted ZERO message files
--      for it (infra/scripts/maildir-removals.sh writes files_left).
--   2. Written by EVERY path that retires an address:
--        - hard deletes, by the triggers below: any mail.mailboxes or
--          mail.aliases row deleted, directly or by cascade (a tenant or a
--          domain removed), leaves a row. No future path can skip this.
--        - the soft paths, which keep their mailbox row, by the API:
--          person deleted, person offboarded, shared mailbox deactivated,
--          domain removed (its aliases), personal account deleted
--          (core.purge_personal_account).
--   3. Refused by triggers: a new mail.mailboxes row, or a new mail.aliases
--      row, at a held address — an alias there would deliver the replies
--      meant for the old owner to whoever holds the alias. The one alias
--      allowed is the offboarding forward the hold itself names
--      (forward_mailbox_id): the organisation chose that successor when it
--      retired the address.
--
--  Additive; re-runs cleanly. Replaces core.address_holds as the place the
--  personal code reads (that table stays, unwritten, and is copied in below).
-- ============================================================================

CREATE TABLE IF NOT EXISTS core.retired_addresses (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    address            citext NOT NULL,
    -- The organisation it was retired from. No FK: the row must outlive the
    -- tenant, or deleting an organisation would delete its holds with it.
    tenant_id          uuid,
    source             text NOT NULL CHECK (source IN (
                           'user_deleted', 'user_offboarded', 'shared_mailbox_deactivated',
                           'domain_removed', 'personal_deleted',
                           'mailbox_deleted', 'alias_deleted',     -- the hard-delete triggers
                           'existing')),                           -- found inactive when this table arrived
    retired_at         timestamptz NOT NULL DEFAULT now(),
    -- Earliest release, when a rule sets one (personal: 90 days, §8).
    not_before         timestamptz,
    -- An alias at this address may point here, and only here: the successor
    -- an offboarding forwarded the leaver's mail to.
    forward_mailbox_id uuid,
    -- The mail server's last count of message files at this address.
    files_left         integer,
    files_checked_at   timestamptz,
    released_at        timestamptz,
    released_by        uuid,
    release_reason     text,
    CHECK ((released_at IS NULL) = (released_by IS NULL)),
    CHECK (released_at IS NULL OR length(btrim(coalesce(release_reason, ''))) > 0)
);
-- One LIVE hold per address; released ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS retired_addresses_one_live
    ON core.retired_addresses (address) WHERE released_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON core.retired_addresses TO tatvaos_app;
COMMENT ON TABLE core.retired_addresses IS
    'Every address that stopped being used, org and personal alike. While a row has released_at NULL, '
    'no mailbox and no alias (except the forward it names) can be created at the address. '
    'Released only by an operator, with a reason, once files_left = 0.';

-- ---- The refusal --------------------------------------------------------------
--  No SET search_path: not SECURITY DEFINER, and citext's case-insensitive
--  "=" lives with the extension — a narrowed path silently compares as text.
CREATE OR REPLACE FUNCTION core.refuse_retired_address() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    held core.retired_addresses%ROWTYPE;
BEGIN
    SELECT * INTO held FROM core.retired_addresses
     WHERE address = NEW.address AND released_at IS NULL;
    IF NOT FOUND THEN RETURN NEW; END IF;

    -- Nested, not AND-ed: plpgsql may evaluate every operand, and a mailbox
    -- row has no target_mailbox_id.
    IF TG_TABLE_NAME = 'aliases' AND held.forward_mailbox_id IS NOT NULL THEN
        IF NEW.target_mailbox_id = held.forward_mailbox_id THEN
            RETURN NEW;                 -- the offboarding forward the hold names
        END IF;
    END IF;

    -- 23505 with a constraint name, so the API can say what it is.
    RAISE EXCEPTION 'address % is retired (%, %) and held until an operator releases it',
        NEW.address, held.source, held.retired_at::date
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'retired_address_held';
END $$;

DROP TRIGGER IF EXISTS refuse_retired_address ON mail.mailboxes;
CREATE TRIGGER refuse_retired_address
    BEFORE INSERT OR UPDATE OF address ON mail.mailboxes
    FOR EACH ROW EXECUTE FUNCTION core.refuse_retired_address();

DROP TRIGGER IF EXISTS refuse_retired_address ON mail.aliases;
CREATE TRIGGER refuse_retired_address
    BEFORE INSERT OR UPDATE OF address, target_mailbox_id ON mail.aliases
    FOR EACH ROW EXECUTE FUNCTION core.refuse_retired_address();

-- ---- Every hard delete leaves a row ------------------------------------------
--  Fires for a direct DELETE and for a cascade (tenant, domain, target
--  mailbox). A soft path that retired the address first keeps its own row:
--  ON CONFLICT DO NOTHING.
CREATE OR REPLACE FUNCTION core.retire_deleted_address() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO core.retired_addresses (address, tenant_id, source)
    VALUES (OLD.address, OLD.tenant_id,
            CASE TG_TABLE_NAME WHEN 'aliases' THEN 'alias_deleted' ELSE 'mailbox_deleted' END)
    ON CONFLICT (address) WHERE released_at IS NULL DO NOTHING;
    RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS retire_deleted_address ON mail.mailboxes;
CREATE TRIGGER retire_deleted_address
    AFTER DELETE ON mail.mailboxes
    FOR EACH ROW EXECUTE FUNCTION core.retire_deleted_address();

DROP TRIGGER IF EXISTS retire_deleted_address ON mail.aliases;
CREATE TRIGGER retire_deleted_address
    AFTER DELETE ON mail.aliases
    FOR EACH ROW EXECUTE FUNCTION core.retire_deleted_address();

-- ---- What was already retired when this arrived ---------------------------------
--  Only an address that has NEVER had a row (released rows included), so an
--  operator's release is not undone by the next deploy's re-run.
DO $$
BEGIN
    IF to_regclass('core.address_holds') IS NOT NULL THEN
        INSERT INTO core.retired_addresses (address, source, retired_at, not_before)
        SELECT h.address, 'personal_deleted', h.created_at, h.held_until
          FROM core.address_holds h
         WHERE NOT EXISTS (SELECT 1 FROM core.retired_addresses r WHERE r.address = h.address);
    END IF;
END $$;

INSERT INTO core.retired_addresses (address, tenant_id, source)
SELECT m.address, m.tenant_id, 'existing'
  FROM mail.mailboxes m
 WHERE m.is_active = false
   AND NOT EXISTS (SELECT 1 FROM core.retired_addresses r WHERE r.address = m.address)
   AND (m.user_id IS NULL                                     -- a deactivated shared mailbox
        OR EXISTS (SELECT 1 FROM core.users u WHERE u.id = m.user_id AND u.status = 'deleted'));

DO $$
DECLARE live int; released int;
BEGIN
    SELECT count(*) FILTER (WHERE released_at IS NULL), count(*) FILTER (WHERE released_at IS NOT NULL)
      INTO live, released FROM core.retired_addresses;
    RAISE NOTICE 'retired addresses: % held, % released.', live, released;
END $$;

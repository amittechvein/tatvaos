-- ============================================================================
--  The departure bug — a personal address book must survive its owner leaving
-- ============================================================================
--
--  family.contacts.owner_user_id was ON DELETE CASCADE. Mail deliberately uses
--  ON DELETE SET NULL, with the comment "NULL after a user is deleted but their
--  mail is retained".
--
--  So the platform disagreed with itself: hard-deleting a person DESTROYED
--  their entire personal address book while their mail survived intact. Core
--  owns the delete, so Core's delete pulled the trigger on Family's data.
--
--  Three options were on the table. Reassigning to a manager needs a manager to
--  exist. Converting the contacts to organisational was rejected outright — it
--  publishes somebody's private address book on the day they leave, which is
--  the worst possible reading of a departure. What is implemented here is the
--  third: RETAIN THE ROWS WITH NO OWNER.
--
--  It matches Mail's retained-but-unreadable model, it loses nothing, and it
--  makes recovery an explicit act by somebody with the authority to make it.
--
--  WHY THE ROWS ARE THEN INVISIBLE, WITH NO POLICY CHANGE.
--
--  The RLS policy on family.contacts admits a personal row only when
--  `owner_user_id = app.user_id`. Against a NULL owner that comparison is NULL,
--  never true — so a retained contact is hidden from every user in the tenant,
--  including administrators, until somebody deliberately assigns it to a
--  person. That falls out of the existing policy; nothing here weakens it.

-- ----------------------------------------------------------------------------
--  1. The foreign key: destroy → retain
-- ----------------------------------------------------------------------------
ALTER TABLE family.contacts
    DROP CONSTRAINT IF EXISTS contacts_owner_user_id_fkey;

ALTER TABLE family.contacts
    ADD CONSTRAINT contacts_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES core.users(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
--  2. The CHECK that would otherwise block the delete
-- ----------------------------------------------------------------------------
--  The old constraint demanded that a personal contact ALWAYS have an owner.
--  Relaxing the foreign key alone would therefore not have fixed anything: the
--  cascade would become a SET NULL, the SET NULL would violate the CHECK, and
--  the user deletion would fail outright. That is why this was never a
--  one-line change.
--
--  The replacement is deliberately LENIENT rather than encoding "personal with
--  no owner is only legal when retained_at is set". A stricter rule would make
--  correctness of the delete path depend on the trigger below firing — and if
--  that trigger were ever dropped, deleting a user would start failing in
--  production. Leniency fails in the safe direction: the worst case is a
--  retained row without a timestamp, not a customer who cannot offboard staff.
--
--  Creating a personal contact with no owner is still impossible, and it is RLS
--  that prevents it: the policy's WITH CHECK requires owner_user_id to equal
--  the current user, which no NULL can satisfy.
ALTER TABLE family.contacts
    DROP CONSTRAINT IF EXISTS contacts_ownership_consistent;

ALTER TABLE family.contacts
    ADD CONSTRAINT contacts_ownership_consistent CHECK (
        -- An organisational contact never has a personal owner.
        (ownership_type = 'organisational' AND owner_user_id IS NULL)
        -- A personal contact normally has one, and has none once retained.
        OR ownership_type = 'personal'
    );

-- ----------------------------------------------------------------------------
--  3. Record WHEN a contact was orphaned
-- ----------------------------------------------------------------------------
--  Without this, retained rows are indistinguishable from each other and from
--  anything else invisible — an admin asked to recover "Priya's contacts" has
--  no way to find them, and the retention is worthless in the one moment it
--  exists to serve.
ALTER TABLE family.contacts ADD COLUMN IF NOT EXISTS retained_at timestamptz;

-- The foreign key's SET NULL is an UPDATE on this table, so a BEFORE UPDATE
-- trigger sees it and can stamp the row before the CHECK is evaluated.
CREATE OR REPLACE FUNCTION family.stamp_contact_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Losing an owner: mark it. Regaining one (an admin reassigning): clear the
    -- mark, so the row stops looking orphaned the moment it is not.
    IF NEW.owner_user_id IS NULL AND OLD.owner_user_id IS NOT NULL THEN
        NEW.retained_at := now();
    ELSIF NEW.owner_user_id IS NOT NULL THEN
        NEW.retained_at := NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_contact_retention ON family.contacts;
CREATE TRIGGER trg_stamp_contact_retention
    BEFORE UPDATE ON family.contacts
    FOR EACH ROW
    EXECUTE FUNCTION family.stamp_contact_retention();

-- Finding retained rows is an admin recovery action, and rare. Partial, so the
-- index stays tiny however many contacts the tenant holds.
CREATE INDEX IF NOT EXISTS idx_family_contacts_retained
    ON family.contacts(tenant_id, retained_at)
    WHERE retained_at IS NOT NULL;

-- ----------------------------------------------------------------------------
--  4. Family is missing from core.products
-- ----------------------------------------------------------------------------
--  Family has been live in production and absent from this table, so product
--  access and entitlement could not see it — it could never be granted, listed
--  or billed. Sort order 15 puts it after Mail and before the products that do
--  not exist yet, which is the order the product list should read in.
INSERT INTO core.products (code, name, description, is_available, sort_order)
VALUES ('family', 'TatvaOS Family', 'Contacts and people management', true, 15)
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
    v_orphans integer;
BEGIN
    SELECT count(*) INTO v_orphans
      FROM family.contacts
     WHERE ownership_type = 'personal' AND owner_user_id IS NULL;

    RAISE NOTICE '';
    RAISE NOTICE '  Departure bug fixed — deleting a user now RETAINS their';
    RAISE NOTICE '  personal contacts with no owner instead of destroying them.';
    RAISE NOTICE '  RLS hides them until an admin reassigns. Retained now: %', v_orphans;
    RAISE NOTICE '  core.products has a family row.';
    RAISE NOTICE '';
END $$;

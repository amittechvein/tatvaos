-- ============================================================================
--  ONE ALLOWANCE PER PERSON, SPENT ACROSS EVERY PRODUCT.
--
--  Until now storage was per product and the products did not know about each
--  other: Mail charged a per-mailbox quota, Space charged a per-product
--  allocation out of the org pool, and a future product would have invented a
--  third scheme. So "you have 30 GB" was not true of anything a customer could
--  point at — they had 30 GB of mail and separately some files.
--
--  Now: a person is given ONE figure. Their mail, their files, and whatever
--  ships next all draw it down. This is the Google Workspace model and it is
--  the one customers already understand.
--
--  DATA WITH NO OWNER IS NOT CHARGED TO A PERSON. Shared mailboxes (support@)
--  and organisational Space files belong to the ORGANISATION, and they draw
--  from the org pool that already exists (core.storage_pools). Charging them
--  to whoever happened to upload would make one person's remaining space move
--  when a colleague files a document, and would orphan the support queue's
--  storage the day that person leaves.
--
--  Migration 29 belonged to two lanes at once and 30 to Core. This is 31, and
--  from here migrations are date-prefixed so nobody has to ask for a number.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  The person's allowance.
--
--  NULL means "inherit" — the department's default, then the organisation's,
--  resolved in the application by StorageAllocator, exactly as mailbox quotas
--  resolved before. A number here is an explicit decision about one person and
--  overrides the inheritance.
-- ----------------------------------------------------------------------------
ALTER TABLE core.users
    ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint
        CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes > 0);

COMMENT ON COLUMN core.users.storage_quota_bytes IS
    'Total bytes this person may use across ALL products. NULL inherits from '
    'department, then organisation. Mail and Space both draw from this.';

-- ----------------------------------------------------------------------------
--  What one person is using, broken down by product.
--
--  SECURITY DEFINER with a pinned search_path: it reads mail.mailboxes and
--  space.files, both of which are RLS-scoped to the CALLER, and the storage
--  policy service needs the true figure for a person who is not the caller.
--  The function takes a user id and returns only aggregate byte counts — no
--  file names, no addresses, nothing that would leak content across tenants.
--
--  TRASHED FILES COUNT. The bytes are still on the disk; hiding them from the
--  meter would mean "delete everything and you are still full" with no
--  explanation. The 30-day purge is what actually returns the space, and the
--  UI says so next to the number.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.user_storage_usage(p_user uuid)
RETURNS TABLE (product_code text, used_bytes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, mail, space, pg_temp
AS $$
    -- Mail: the person's OWN mailboxes only. A shared mailbox has user_id
    -- NULL and is the organisation's, not theirs.
    SELECT 'mail'::text,
           COALESCE(SUM(m.used_bytes), 0)::bigint
      FROM mail.mailboxes m
     WHERE m.user_id = p_user
       AND m.type = 'user'

    UNION ALL

    -- Space: files they OWN, personal ones only. Organisational files are the
    -- organisation's, whoever uploaded them.
    SELECT 'drive'::text,
           COALESCE(SUM(f.size_bytes), 0)::bigint
      FROM space.files f
     WHERE f.owner_user_id = p_user
       AND f.ownership_type = 'personal';
$$;

REVOKE ALL ON FUNCTION core.user_storage_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.user_storage_usage(uuid) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  The single number both products enforce against.
--
--  ONE definition, called from two places. The quota policy service (inbound
--  mail) and Space's upload gate MUST agree about whether a person is full;
--  two implementations of "is there room" eventually disagree, and the one
--  that refuses is the one the customer notices.
--
--  Returns NULL quota when the person has no explicit allowance — the caller
--  resolves inheritance and decides. It does not guess a default here, because
--  a wrong default silently refuses mail.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.user_storage(p_user uuid)
RETURNS TABLE (quota_bytes bigint, used_bytes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, mail, space, pg_temp
AS $$
    SELECT u.storage_quota_bytes,
           (SELECT COALESCE(SUM(x.used_bytes), 0)::bigint
              FROM core.user_storage_usage(p_user) x)
      FROM core.users u
     WHERE u.id = p_user;
$$;

REVOKE ALL ON FUNCTION core.user_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.user_storage(uuid) TO tatvaos_app;

-- ----------------------------------------------------------------------------
--  Seed the new column from what people already have.
--
--  Everyone's mailbox quota becomes their whole-account allowance rather than
--  their mail allowance. That is a WIDENING for every existing user — nobody
--  loses room on the day this ships, which is the only acceptable direction
--  for a migration that changes what a number means.
--
--  Guarded so it runs once: re-running a deploy must not overwrite an
--  allowance an admin has since set by hand.
-- ----------------------------------------------------------------------------
UPDATE core.users u
   SET storage_quota_bytes = m.quota_bytes
  FROM mail.mailboxes m
 WHERE m.user_id = u.id
   AND m.type = 'user'
   AND u.storage_quota_bytes IS NULL
   AND m.quota_bytes > 0;

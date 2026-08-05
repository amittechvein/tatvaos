-- ============================================================================
--  Departments — categories become a tree
-- ============================================================================
--
--  What Google calls an Organisational Unit. A named group that carries
--  policy — storage, which products, whether members may email outsiders —
--  and passes it down to the departments beneath it.
--
--  ---------------------------------------------------------------------------
--  WHY RENAME RATHER THAN ADD A TABLE
--
--  core.user_categories already did exactly this job: a named group carrying
--  default quota, default products and can_send_external. Adding a separate
--  "departments" table would leave two overlapping concepts, and every future
--  question about storage would start with "which one wins?".
--
--  So the table is renamed and given a parent. One concept, one answer.
--  ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS core.user_categories RENAME TO departments;

-- Self-reference. NULL parent = top level.
--
-- ON DELETE CASCADE, deliberately: deleting Engineering deletes Engineering >
-- Backend with it. The alternative — orphaning children to the root — silently
-- promotes a team to top level and grants it whatever the root permits, which
-- is a privilege change nobody asked for.
ALTER TABLE core.departments
    ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES core.departments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_departments_parent ON core.departments(tenant_id, parent_id);

-- ----------------------------------------------------------------------------
--  NULL now means "inherit", not "unset"
-- ----------------------------------------------------------------------------
--
--  default_quota_bytes was already nullable. With a hierarchy that NULL gains
--  a precise meaning: take the parent's value, and the parent's parent's if
--  that is NULL too, up to the tenant's pool setting.
--
--  This is the whole point of a tree. Set 30 GB on Engineering and every team
--  under it gets 30 GB; raise it to 50 and they all move, with no per-team
--  edit. Copying the value down instead would look identical on day one and
--  drift apart by the end of the quarter.

COMMENT ON COLUMN core.departments.default_quota_bytes IS
    'NULL means inherit from the parent department, then the tenant storage pool.';

-- can_send_external stays NOT NULL and does NOT inherit. A parent permitting
-- external mail must not silently grant it to a Students department created
-- underneath later — the safe value has to be chosen explicitly, every time.

-- ----------------------------------------------------------------------------
--  Cycle guard
-- ----------------------------------------------------------------------------
--
--  A department cannot be its own ancestor. Without this, one mis-set parent
--  makes every recursive query on that tenant hang forever — and the tenant
--  affected is the one whose admin made the mistake, so they would experience
--  it as the product being broken.

CREATE OR REPLACE FUNCTION core.departments_no_cycle() RETURNS trigger AS $$
DECLARE
    cursor_id uuid := NEW.parent_id;
    hops int := 0;
BEGIN
    IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;

    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION 'A department cannot be its own parent';
    END IF;

    WHILE cursor_id IS NOT NULL LOOP
        IF cursor_id = NEW.id THEN
            RAISE EXCEPTION 'That would put % inside one of its own sub-departments', NEW.name;
        END IF;

        -- Depth stop as well as the cycle check: a hierarchy 50 deep is a
        -- mistake or an attack, not an organisation chart.
        hops := hops + 1;
        IF hops > 50 THEN
            RAISE EXCEPTION 'Department hierarchy is too deep';
        END IF;

        SELECT parent_id INTO cursor_id FROM core.departments WHERE id = cursor_id;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_departments_no_cycle ON core.departments;
CREATE TRIGGER trg_departments_no_cycle
    BEFORE INSERT OR UPDATE OF parent_id ON core.departments
    FOR EACH ROW EXECUTE FUNCTION core.departments_no_cycle();

-- ----------------------------------------------------------------------------
--  Effective quota, resolved in one place
-- ----------------------------------------------------------------------------
--
--  Walks up until it finds a value. In SQL rather than C# because the users
--  list needs it for every row, and doing the walk per user in application
--  code is one query per person on a screen built for four hundred of them.

CREATE OR REPLACE FUNCTION core.department_effective_quota(p_department uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
    WITH RECURSIVE chain AS (
        SELECT id, parent_id, default_quota_bytes, 0 AS depth
          FROM core.departments WHERE id = p_department
        UNION ALL
        SELECT d.id, d.parent_id, d.default_quota_bytes, c.depth + 1
          FROM core.departments d
          JOIN chain c ON d.id = c.parent_id
         WHERE c.depth < 50
    )
    SELECT default_quota_bytes
      FROM chain
     WHERE default_quota_bytes IS NOT NULL
     ORDER BY depth
     LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION core.department_effective_quota(uuid) TO tatvaos_app;

DO $$ BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '  Departments ready — hierarchical, quota inherits, cycles refused';
    RAISE NOTICE '';
END $$;

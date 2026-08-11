-- ============================================================================
--  Family — birthdays, anniversaries and custom dates
-- ============================================================================
--
--  A separate table, not columns on family.contacts, because "custom dates"
--  is in the requirement: a person can have a birthday, a work anniversary,
--  the date you signed them, and their child's name day. Fixed columns would
--  cover the first two and force the rest into notes.
--
--  ── THE DECISION THAT MATTERS: YEAR IS NULLABLE ──────────────────────────
--
--  Storing this as a DATE would be the obvious choice and the wrong one.
--  People routinely know a birthday's day and month and NOT the year — asking
--  is awkward, and guessing is worse. A DATE column forces a placeholder year,
--  which then leaks into every screen ("born 1900"), sorts wrong, and computes
--  a nonsense age.
--
--  So: month and day are required, year is optional. A row with year NULL is
--  a real, complete birthday that simply has no year, rather than a broken one.
--
--  It also makes the query this table exists for straightforward. "Whose
--  birthday falls in the next thirty days" is a day-of-year question, and on a
--  DATE column with varying years it needs date arithmetic that breaks over
--  the new year. Here it is a comparison on (month, day).
--
--  Deliberately NOT a calendar event. When TatvaOS Calendar arrives it should
--  READ this table and project recurring entries from it — the contact owns
--  the fact, the calendar owns the reminder. Writing events here instead would
--  mean a birthday changing in two places, and one of them going stale.
-- ============================================================================

CREATE TABLE IF NOT EXISTS family.contact_dates (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES family.contacts(id) ON DELETE CASCADE,

    kind text NOT NULL CHECK (kind IN ('birthday','anniversary','other')),

    -- Required for 'other', meaningless for the rest. The CHECK stops an
    -- unlabelled custom date, which would render as a bare date with no clue
    -- what it commemorates.
    label text,
    CONSTRAINT contact_dates_label_required CHECK (
        (kind = 'other' AND label IS NOT NULL AND length(btrim(label)) > 0) OR
        (kind <> 'other')
    ),

    -- NULL means the year is genuinely unknown, not missing data.
    year  int CHECK (year IS NULL OR (year BETWEEN 1900 AND 2200)),
    month int NOT NULL CHECK (month BETWEEN 1 AND 12),
    day   int NOT NULL CHECK (day BETWEEN 1 AND 31),

    -- Rejects 31 February. COALESCE to 2000 because it is a leap year, so
    -- 29 February validates for a year-less birthday — which is exactly the
    -- case a naive check gets wrong once every four years.
    CONSTRAINT contact_dates_real_date CHECK (
        day <= EXTRACT(DAY FROM (
            make_date(COALESCE(year, 2000), month, 1) + INTERVAL '1 month - 1 day'
        ))
    ),

    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One birthday and one anniversary per contact; any number of custom dates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_contact_dates_singular
    ON family.contact_dates (contact_id, kind)
    WHERE kind IN ('birthday', 'anniversary');

CREATE INDEX IF NOT EXISTS idx_family_contact_dates_contact
    ON family.contact_dates(contact_id);

-- The index for "what is coming up", which is the only query with a
-- performance shape worth planning for.
CREATE INDEX IF NOT EXISTS idx_family_contact_dates_upcoming
    ON family.contact_dates(tenant_id, month, day);

-- ----------------------------------------------------------------------------
-- RLS — through the contact, exactly like every other child table
-- ----------------------------------------------------------------------------

ALTER TABLE family.contact_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE family.contact_dates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON family.contact_dates;

CREATE POLICY tenant_isolation ON family.contact_dates
    USING (EXISTS (SELECT 1 FROM family.contacts c
                    WHERE c.id = contact_id
                      AND c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
                      AND (c.ownership_type = 'organisational'
                           OR c.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)))
    WITH CHECK (EXISTS (SELECT 1 FROM family.contacts c
                    WHERE c.id = contact_id
                      AND c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
                      AND (c.ownership_type = 'organisational'
                           OR c.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)));

GRANT SELECT, INSERT, UPDATE, DELETE ON family.contact_dates TO tatvaos_app;

-- ----------------------------------------------------------------------------
-- Upcoming, as a function — the seam TatvaOS Calendar will read
-- ----------------------------------------------------------------------------
--
--  Two difficulties, both easy to get wrong and both covered here.
--
--  The year boundary: on 20 December, "the next thirty days" includes
--  5 January. Comparing (month, day) pairs directly misses it, so this
--  projects both this year's and next year's occurrence and takes whichever
--  has not yet passed.
--
--  And 29 February. make_date(2026, 2, 29) does not return null, it RAISES —
--  so one leap-day birthday would break this query for the entire tenant in
--  three years out of four. The day is clamped to the length of the month.
--
--  Returns the NEXT occurrence as a real date, so the caller does not repeat
--  this arithmetic. Age is NULL when the year is unknown rather than a
--  fabricated number.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION family.upcoming_dates(p_days int DEFAULT 30)
RETURNS TABLE (
    contact_id   uuid,
    display_name text,
    kind         text,
    label        text,
    occurs_on    date,
    days_away    int,
    turning      int
)
LANGUAGE sql STABLE AS $$
    WITH bounds AS (
        SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS y0
    ), candidate AS (
        SELECT
            c.id, c.display_name, d.kind, d.label, d.year, d.month, d.day, b.y0
        FROM family.contact_dates d
        JOIN family.contacts c ON c.id = d.contact_id
        CROSS JOIN bounds b
        WHERE c.deleted_at IS NULL
    ), projected AS (
        -- 29 February in a non-leap year is observed on the 28th.
        --
        -- Not a rounding detail: make_date(2026, 2, 29) RAISES, so without
        -- this clamp a single leap-day birthday takes the whole query down
        -- for everyone in the tenant, three years in every four.
        SELECT id, display_name, kind, label, year,
               make_date(y0, month, LEAST(day,
                   EXTRACT(DAY FROM (make_date(y0, month, 1) + INTERVAL '1 month - 1 day'))::int
               )) AS this_year,
               make_date(y0 + 1, month, LEAST(day,
                   EXTRACT(DAY FROM (make_date(y0 + 1, month, 1) + INTERVAL '1 month - 1 day'))::int
               )) AS next_year
        FROM candidate
    ), resolved AS (
        SELECT id, display_name, kind, label, year,
               CASE WHEN this_year >= CURRENT_DATE THEN this_year ELSE next_year END AS occurs_on
        FROM projected
    )
    SELECT id, display_name, kind, label, occurs_on,
           (occurs_on - CURRENT_DATE)::int AS days_away,
           -- NULL, never a fabricated age, when the year is unknown.
           CASE WHEN year IS NULL THEN NULL
                ELSE EXTRACT(YEAR FROM occurs_on)::int - year END AS turning
    FROM resolved
    WHERE occurs_on <= CURRENT_DATE + make_interval(days => p_days)
    ORDER BY occurs_on, display_name;
$$;

-- ============================================================================
--  Scheduled Connect meetings that predate the calendar mirror go on their
--  host's calendar too — CTO condition 1 on PR 176, 18 September 2026
-- ============================================================================
--
--  From PR 176 the API puts every scheduled meeting on its host's calendar
--  as it is created (ConnectCalendarMirror). Meetings scheduled BEFORE that
--  deploy got nothing, because nothing ever did that for them.
--
--  The CTO's reason for this file: "on Monday a teacher opens their calendar
--  and sees SOME of their classes — the ones created after Friday — and not
--  the ones created before. That is harder to explain than seeing none at
--  all, because 'the calendar doesn't show classes' is a known limitation
--  while 'the calendar shows four of my six classes' reads as data loss and
--  generates a support call."
--
--  So: one pass over meetings whose start is still in the future, writing
--  the same row the mirror would have. Past meetings stay absent; nobody is
--  looking for them.
--
--  ── THIS MUST PRODUCE WHAT ConnectCalendarMirror.UpsertAsync PRODUCES ────
--  Same UID (ConnectInvitations.Uid), same title fallback, same one-hour
--  default end (ConnectInvitations.EndOf), same zone fallback, same
--  description, same join URL (ConnectEndpoints.JoinUrlOf, whose base is a
--  constant in the API and repeated here). If either side changes, the other
--  must, and tests/orgapi step 18 is what notices: it deletes a mirrored
--  row, re-runs this file, and compares every one of those fields with what
--  the API had written.
--
--  Idempotent: keyed on the UID, a second run finds every row present and
--  inserts nothing. Re-runs on every deploy like every file here, which is
--  fine — after the first run it is a no-op, and a meeting created after
--  that deploy already has its row from the mirror.
--
--  Read on production before it was written (18 Sept 2026, 14:30 UTC):
--  45 scheduled meetings, 0 of them in the future with a host, 0 calendar
--  rows with a connect- UID. On that day this inserts nothing on production;
--  it exists for whichever customer has next week's classes scheduled at the
--  moment a later deploy lands.
-- ----------------------------------------------------------------------------

INSERT INTO calendar.events
    (tenant_id, calendar_id, uid, sequence,
     created_by_user_id, organiser_user_id,
     title, description, meeting_url,
     starts_at, ends_at, timezone,
     status, transparency)
SELECT m.tenant_id,
       c.id,
       'connect-' || m.id::text || '@tatvaos.com',
       m.invite_sequence,
       m.created_by_user_id,
       m.created_by_user_id,
       coalesce(nullif(btrim(m.title), ''), 'Meeting'),
       'A TatvaOS Connect meeting. Open the link at the time of the meeting to join.',
       'https://connect.tatvaos.com/connect/room/' || m.code,
       m.scheduled_start,
       CASE WHEN m.scheduled_end IS NOT NULL AND m.scheduled_end > m.scheduled_start
            THEN m.scheduled_end
            ELSE m.scheduled_start + interval '1 hour' END,
       coalesce(nullif(m.timezone, ''), 'Asia/Kolkata'),
       'confirmed',
       'opaque'
  FROM connect.meetings m
  JOIN calendar.calendars c
    ON c.owner_user_id = m.created_by_user_id
   AND c.is_primary
   AND c.deleted_at IS NULL
 WHERE m.kind = 'scheduled'
   AND m.status NOT IN ('ended', 'cancelled')
   AND m.scheduled_start IS NOT NULL
   AND m.scheduled_start > now()
   AND m.created_by_user_id IS NOT NULL
   AND NOT EXISTS (
        SELECT 1 FROM calendar.events e
         WHERE e.uid = 'connect-' || m.id::text || '@tatvaos.com'
           AND e.deleted_at IS NULL);

DO $$
DECLARE
    n_future  int;
    n_rows    int;
BEGIN
    SELECT count(*) INTO n_future
      FROM connect.meetings m
     WHERE m.kind = 'scheduled' AND m.status NOT IN ('ended', 'cancelled')
       AND m.scheduled_start > now() AND m.created_by_user_id IS NOT NULL;
    -- Rows FOR THOSE meetings, not every connect- row with a future start:
    -- a row left behind by something else (a cancelled meeting whose
    -- removal failed, say) would otherwise make the two numbers disagree
    -- for a reason this file has nothing to do with.
    SELECT count(*) INTO n_rows
      FROM connect.meetings m
     WHERE m.kind = 'scheduled' AND m.status NOT IN ('ended', 'cancelled')
       AND m.scheduled_start > now() AND m.created_by_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM calendar.events e
                    WHERE e.uid = 'connect-' || m.id::text || '@tatvaos.com'
                      AND e.deleted_at IS NULL);
    RAISE NOTICE '';
    RAISE NOTICE '  Connect meetings on the calendar: % future meeting(s) with a host, % calendar row(s) for them', n_future, n_rows;
    -- Not equal means a host with no primary calendar, which 20260816's
    -- backfill (alphabetically earlier, so already run) should have made
    -- impossible. Said out loud rather than silently short.
    IF n_rows < n_future THEN
        RAISE WARNING '  % future meeting(s) are NOT on a calendar — a host without a primary calendar?', n_future - n_rows;
    END IF;
    RAISE NOTICE '';
END $$;

# Calendar reminders were never sent (16 Aug – fix pending, 2026)

**Status:** fixed in PR (branch `mail/calendar-reminders-fix`), **not yet deployed.**
**Kept so that** if a school asks why a reminder did not come, the answer is in
writing rather than reconstructed (Mr. Singh, 27 Sept 2026).

## The dates

| | |
|---|---|
| Calendar and its reminder worker merged to `main` | **16 August 2026**, commit `acab405` |
| First production deploy that included it | **not established.** The deploy history before the workflow era was not read for this record |
| Found | **27 September 2026**, by the decision-0007 isolation audit, while sizing a schema change for `calendar.reminder_sends` |
| Confirmed on production | **27 September 2026** (read-only counts, on Amit's approval): 7 reminders set; 1 due in the past week; `calendar.reminder_sends` **0 rows, ever**; last send "never" |
| **Fix live on production** | **— fill in on deploy day: the commit, the UTC time, and the run or hand-deploy record —** |

**Between those dates no calendar reminder was sent by TatvaOS**, whatever
anyone set: email or notification, one-off or recurring. Nothing reported it.

## What happened

`CalendarReminderWorker` wakes every minute, finds reminders that are due, and
sends them. It runs with no signed-in person and no organisation set. It read
`calendar.event_reminders` and `calendar.events` with `IgnoreQueryFilters()`,
which removes the application's filters.

Those tables also have **forced row-level security** in Postgres, keyed on the
organisation, and the API's database role cannot bypass it. With no
organisation set, every policy compares against nothing, so the worker saw
**no reminders at all**. An empty list is not an error: it concluded there was
nothing due, sent nothing, and logged nothing, every minute, for six weeks.

`IgnoreQueryFilters()` looked like the cross-organisation switch. Nothing in the
application is one; that is what forced RLS is for.

## The fix

The pattern Connect's workers already use (Mr. Singh, 27 Sept):

- `calendar.reminder_tenants()` is a `SECURITY DEFINER` function that answers
  only "which organisations have reminders". It returns organisation ids, with
  no titles, people or times. Its search path is pinned, and only the API's role
  may call it.
- The worker enters each organisation in turn, pushes it into the database
  session, and reads that organisation's reminders under row-level security,
  as a signed-in person would. One organisation failing is logged and does not
  stop the others.

## How we know

`tests/calendar/test-reminders.sh` starts the real API and lets the real worker
run. It plants a reminder due now in **two** organisations, and a third not yet
due, and asserts on what the worker **did**: each send is recorded, and each
email arrives at the local mail sink, once, to its own person.

| Build | Result |
|---|---|
| `main` c7cb110 (before) | **4 of 11 red**: nothing recorded, nothing sent, **and "no sweep failure" green**, which is exactly the silence that hid it |
| fix c0aca3b | **11/11** |

## On deploy day

1. Set a reminder on production for a few minutes ahead, on a real calendar,
   and watch it arrive.
2. Read `SELECT count(*) FROM calendar.reminder_sends` before and after: it
   must rise.
3. Fill in the **Fix live on production** row above, in the same PR as the
   deploy record.

A reminder whose time passed more than 15 minutes before the fix goes live is
**not** sent late: the worker's grace window is 15 minutes, by design. None of
the six weeks' missed reminders will be delivered.

## The class, and the rule it produced

A worker without a tenant, reading forced-RLS tables, sees nothing and says
nothing. The sweep of all eleven background workers (decision 0007,
`docs/decisions/0007-tenantless-paths.md` §5, on the Connect isolation PR)
found this worker the only one. Every new worker must state how it crosses
organisations (an unprotected routing table, or a definer function), and must
have a test that runs it with a real item due.

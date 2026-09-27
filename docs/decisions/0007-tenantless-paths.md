# 0007 — Connect's tenantless paths: the inventory

**Started 25 September 2026 in PR 288, on Mr. Singh's ruling on 0007:** "the
tenantless-path inventory is started as a checked-in file in the same PR, even
though the child-table filters come in step two. Nobody holds that inventory
today; it is worth more than the filters."

**Started, not finished.** Everything below was found by reading the code on
branch `connect/meetings-query-filter` (base `main` f9e961f) and, where it
says so, by running it. A row marked *read* has not been run. Whoever changes
one of these paths updates its row in the same change.

## What "tenantless" means here

A request or job that starts **without a signed-in person**, so no session sets
the organisation. Each one has to find the organisation itself before it may
read anything. In this codebase the application layer fails loudly if it does
not: `TenantContext.TenantId` **throws** when unset, and every EF query filter
reads it. Row-level security reads `app.tenant_id`, which is set only by
`SyncTenantAsync` (or when a connection opens), so entering the tenant without
syncing leaves RLS blind. Several paths below have been bitten by exactly that.

## 1. Entry points

| Entry point | Who calls it | How the organisation is found | Connect tables read or written (EF) | Definer functions used | Run by |
|---|---|---|---|---|---|
| `GET /api/connect/g/{code}` (guest doorstep) | anyone with a link | `connect.resolve_meeting_code()` → `EnterAnonymousScope(row.TenantId, "guest")` | meetings, participants | `resolve_meeting_code` | `tests/connect-guest-ceiling` (15), `tests/connect-isolation` |
| `POST /api/connect/g/{code}/join` | anyone with a link | same | meetings, participants, lobby_requests | `resolve_meeting_code` | `tests/connect-guest-ceiling`, `tests/connect-isolation` |
| `GET /api/connect/g/wait/{token}` (waiting room poll) | a parked guest or colleague | `connect.peek_lobby_request()`; on admission `connect.claim_lobby_admission()` → `EnterAnonymousScope(claimed.TenantId)` + `SyncTenantAsync` | lobby_requests, participants, meetings | `peek_lobby_request`, `claim_lobby_admission` | `tests/connect-isolation` step 3 |
| `POST /api/connect/webhooks/livekit`: room and participant events | LiveKit, signed | `connect.webhook_meeting_tenant(meetingId)` from the room name `m-{id}` → `EnterAnonymousScope(…, "system")` + `SyncTenantAsync` | meeting_events, meetings, participants | `webhook_meeting_tenant`, `recording_allowed`, `storage_headroom` (auto-record) | `tests/connect-isolation` step 2 |
| same, egress events (the recording callback) | LiveKit egress, signed | same, the room from `egressInfo.roomName` | recordings, meeting_notes, meetings | `webhook_meeting_tenant`, `reconcile_recording_storage` | `tests/connect-isolation` step 2b |
| same, screen-share track events | LiveKit, signed | same | meetings | `webhook_meeting_tenant` | *read* |
| `GET /api/connect/recordings/file` (ticketed download) | a browser holding a signed ticket | the ticket's claim → `EnterAnonymousScope(claim.TenantId, "system")` | meetings, participants, recordings | none | *read* |
| Meetings API `/api/v1/org/meetings…` | a customer's software, organisation key | `OrgApiAuth` → `EnterAnonymousScope(keyTenantId, "org_api")` + `SyncTenantAsync` | meetings | none | `tests/orgapi` (123), paging-promises (20, and 20 with RLS bypassed) |
| `ConnectNotesWorker` (transcription, notes, minutes email, retention, stuck recordings, invitation sweep) | the API process, on a timer | a definer function lists work across organisations (`pending_notes`, `pending_transcription`, `pending_minutes_email`, `expired_recordings`, `stuck_recordings`, `notes_tenant`, `recording_tenant`), then `EnterAnonymousScope(tenantId, "system")` per item | meetings, participants, recordings, transcripts, caption_lines, meeting_notes | the seven named, plus `attendance`, `reconcile_recording_storage`, `sweep_meeting_invitations`, `webhook_meeting_tenant` | **read only. No suite drives the worker.** This is the largest gap in the list |

Every read of `ConnectMeetings` (26 sites, 8 files) was checked before PR
288's filter went in. The table in PR 288's description lists them.

## 2. Tables

The step-two column follows the ruling: "the child tables get a `tenant_id`
column rather than a join through the meeting".

| Table | `tenant_id` | EF filter | RLS forced | Step two |
|---|---|---|---|---|
| meetings | yes | **yes (PR 288)** | yes | done in step one |
| meeting_invitations | yes | no | yes | filter only: the column exists |
| recording_shares | yes | no | yes | filter only |
| recording_share_grants | yes | no | yes | filter only |
| recording_access_log | yes | no | yes | filter only |
| tenant_settings | yes | no | yes | filter only |
| participants | **no** | no | yes | add `tenant_id`, then the filter |
| lobby_requests | **no** | no | yes | add, then filter |
| meeting_events | **no** | no | yes | add, then filter |
| meeting_chat | **no** | no | yes | add, then filter (high volume: the ruling's reason) |
| caption_lines | **no** | no | yes | add, then filter (high volume) |
| meeting_blocks | **no** | no | yes | add, then filter |
| meeting_notes | **no** | no | yes | add, then filter |
| recordings | **no** | no | yes | add, then filter |
| transcripts | **no** | no | yes | add, then filter |

"RLS forced" was read from `pg_class` on the local database built from this
branch's init files. Production was not read.

## 3. Definer functions in `connect`

These run as their owner, so **neither RLS nor any EF filter applies inside
them.** Each is a deliberate hole, and its body is the only guard. There are 24
on the local database:

`claim_lobby_admission`, `expired_recordings`, `log_recording_access`,
`meeting_chat_lines`, `meetings_with_captions`, `minutes_recipients`,
`minutes_unreachable`, `notes_tenant`, `peek_lobby_request`,
`pending_minutes_email`, `pending_notes`, `pending_transcription`,
`reconcile_recording_storage`, `recording_allowed`, `recording_bytes`,
`recording_retention_days`, `recording_tenant`, `resolve_meeting_code`,
`resolve_share_token`, `share_for_user`, `storage_headroom`, `stuck_recordings`,
`sweep_meeting_invitations`, `webhook_meeting_tenant`.

**Not yet reviewed in this inventory:** what each one returns, and whether it
could return another organisation's rows to its caller. The 25 Sept audit
(Hire lane, PR 275) checked only that each pins `search_path`; eight Connect
functions omit `pg_temp` and were assigned to this lane.

## 4. Open items

1. **Drive `ConnectNotesWorker` in a test.** It is the widest tenantless path
   and nothing runs it.
2. **Walk the ticketed download and the screen-share event.**
3. **Review each definer function's body** against section 3's question.
4. **Step two:** `tenant_id` on the ten child tables, then filters. The
   enforcement test (PR 288) lists them as its only allowed exceptions, so the
   list can only shrink.
5. **`core.departments`** (the ruling's first addition): policy on, the mail
   edge reads it through a definer function. Not Connect, but absorbed by 0007.
   It is its own migration PR.
6. **Found by the enforcement test, outside Connect** (`tests/tenant-filters`,
   first run 25 Sept). These are twelve tenant-owned entities with no EF
   filter; each is named in the test's allowed list with its owner:
   - **Calendar** (Mail lane): calendars, events, event_attendees,
     event_exceptions, calendar_members, event_reminders. RLS is forced on
     all six. **`calendar.reminder_sends` has no RLS either: no layer at all,
     and nothing documents why.**
   - **Mail** (Mail lane): api_keys, api_sends, app_passwords,
     mailbox_permissions. RLS is forced.
   - **Core** (auth): `mfa_recovery_codes`. **No RLS, by design**: it is read
     before the organisation is known (`0024-mfa.sql`), and every lookup is by
     `user_id` plus a 256-bit hash.
7. **Arrived on `main` after this list was started (found on the merge of
   27 Sept):**
   - the **anonymous** `/api/connect/shared` group, where recording-share links
     are opened by people with no account. How it finds the organisation has
     **not been walked yet**;
   - `connect.recording_share_password_failures`, read on that path. It has
     RLS forced and no EF filter, and is in the enforcement test's allowed
     list.

   This row belongs in section 1 once the path is walked.


## 5. Every background worker (sweep of 27 September, on Mr. Singh's instruction)

> "This is a class, not an instance. The shape is: a worker runs without a
> tenant, the database correctly shows it nothing, and the worker treats an
> empty result as a quiet day. […] sweep every background worker: does it
> enter a tenant before reading a forced-RLS table?" (Mr. Singh, 27 Sept)

All eleven hosted services registered in `Program.cs` on `main` (c7cb110,
27 Sept) are listed below. "Finds its work in" is the first read, made
**before** any tenant is entered.

| Worker | Finds its work in (no tenant) | That source's protection | Then | Verdict |
|---|---|---|---|---|
| **CalendarReminderWorker** | `calendar.event_reminders`, `calendar.events`, `calendar.reminder_sends`, with `IgnoreQueryFilters()` | **RLS forced, strict**: with no tenant, nothing is visible | never enters a tenant | **BROKEN.** It sees nothing, sends nothing, and reports nothing. **Confirmed on production 27 Sept:** 7 reminders set, 1 due in the past week, `reminder_sends` = 0, ever |
| ConnectNotesWorker | definer functions (`pending_notes`, `pending_transcription`, `pending_minutes_email`, `expired_recordings`, `stuck_recordings`, …) | definer: sees across tenants by design | `EnterAnonymousScope` + `SyncTenantAsync` per item (10 sites) | correct pattern; **no test drives it** |
| AttachmentScanWorker | `mail.mailboxes` | **no RLS** (routing table) | `EnterPlatformScope(box.TenantId)` + sync, then attachments and messages (RLS forced) | correct pattern |
| MaildirIngestWorker | `mail.mailboxes` | no RLS | enters per mailbox, then messages, folders and filter rules | correct pattern |
| ThreadBackfillWorker | `mail.mailboxes` | no RLS | enters per mailbox | correct pattern |
| VacationReplyWorker | `mail.mailboxes`; later `mail.mailboxes` / `mail.aliases` cross-tenant to decide "inside the organisation" | no RLS | enters per mailbox for responders, messages and sends | correct pattern; the cross-tenant audience read is by design, on unprotected routing tables |
| MailTriageWorker | `core.tenants` | no RLS | `EnterAnonymousScope(tenantId)` + sync per organisation | correct pattern |
| StorageReconcileWorker | `core.tenants`; trash purge via `space.purgeable_files()` / `space.purge_trash()` | no RLS; definer | enters per organisation for pools and users | correct pattern |
| PostfixPolicyWorker | `mail.mailboxes`, `mail.aliases`, then `core.users` | no RLS | enters per mailbox; storage via `core.user_storage()` (definer) | correct pattern |
| SpaceBlobSweepWorker | `space.blob_keys_present()`, `core.sweep_handoff_codes()` | definer | no tenant needed | correct pattern |
| BounceIntakeWorker | `mail.record_bounce()` | definer | no tenant needed | correct pattern |

**How this was checked:**
- the order of reads against tenant entry in each file on `main`;
- `relrowsecurity` / `relforcerowsecurity` and the policy text for each first-read table;
- `prosecdef` for each function.

The RLS and definer readings are from the **local** database built from the
init files; production was read only for the reminder counts.

**The class, named.** Two shapes let a worker cross organisations, and only
one of them fails:
1. **An unprotected routing table** (`mail.mailboxes`, `mail.aliases`,
   `core.users`, `core.tenants` have no RLS at all). This works, and it is
   *isolation bypassed by design*. Those tables are the mail edge's
   exemption, and any worker can read every organisation's rows in them.
2. **A definer function.** This works; the function body is the only guard
   (section 3).

A worker that uses **neither**, and reads a forced-RLS table without a
tenant, sees nothing and says nothing. CalendarReminderWorker is the only
one today. **A new worker must name which of the two it uses, and a test must
drive it with a real row due.** That is the only thing that would have caught
this one.

# 0007 — Connect's tables get a second isolation layer

**Status:** proposed, for Mr. Singh's tenancy gate. Nothing in this record is built.
**Date:** 2026-09-21
**Written by** the developer session that found the gap, while calibrating the
isolation check Mr. Singh asked for on PR 191. Evidence: PR 193,
`docs/reviews/evidence/EVIDENCE-PR190.md` (addendum).

## Context

The rest of the platform keeps one organisation out of another's data twice:

1. **In the application**, an Entity Framework query filter on the entity:
   `b.Entity<X>().HasQueryFilter(e => e.TenantId == tenant.TenantId)` in
   `AppDbContext.cs`. Domain, User, Department, Subscription, AuditLog,
   RefreshToken, OidcApplication, OrgApiKey and others have one.
2. **In the database**, Postgres row-level security, enabled and FORCED, with the
   API connecting as `tatvaos_app`, which is neither superuser nor `BYPASSRLS`.

**Connect has only the second.** On 21 September, checked in the code: none of
the fifteen Connect entities mapped in `AppDbContext.cs` has a query filter —
ConnectMeeting, ConnectParticipant, ConnectLobbyRequest, ConnectMeetingEvent,
ConnectMeetingChat, ConnectMeetingNotes, ConnectMeetingBlock,
ConnectMeetingInvitation, ConnectRecording, ConnectRecordingShare,
ConnectRecordingShareGrant, ConnectRecordingAccess, ConnectTranscript,
ConnectCaptionLine, ConnectTenantSettings. The Meetings API's timetable query
has no tenant condition of its own either.

**What that means, shown by running it.** With the API connected as a role that
bypasses RLS, the isolation check went red, 9 of 20 on `d7d1980`: another
organisation's class appeared in an ordinary timetable read with any
organisation's key, no crafted input needed. Production is safe today, because
RLS is forced and `tatvaos_app` cannot bypass it. But one migration that drops a
policy, or one configuration change that points the API at a privileged role,
would open every Connect table to every organisation at once, and nothing in the
application would notice.

Connect's child tables carry no `tenant_id`. They are scoped through their
meeting (`20260817-connect.sql`). That is why a filter cannot simply be copied
onto them.

## How Connect reads without a tenant today

These are the paths a filter must not break, or must be made to pass through
deliberately:

| Path | How it reaches data | Tenant set? |
|---|---|---|
| Guest door (`ConnectGuestEndpoints`) | a `SECURITY DEFINER` function resolves the code, then `EnterAnonymousScope(tenantId)` | **yes**, after the lookup |
| LiveKit webhooks | resolve the meeting from the room name | to be checked, path by path |
| Recording share links, egress callbacks, the minutes sweeper | background and anonymous | to be checked, path by path |

Two points matter for the design. `EnterAnonymousScope` **sets** the tenant; it
does not switch RLS off. So a filter written as the rest of the codebase writes
it would **still work** on the guest path once the tenant is entered. And a
`SECURITY DEFINER` function is plain SQL, which an EF filter never touches.

## Options

1. **Leave it: RLS alone.**
   Nothing to build. One layer, and it is the database's. Every future
   mistake in the database's configuration is a cross-organisation leak with no
   second chance.

2. **Filter ConnectMeeting only.**
   Covers the Meetings API and most console reads. The fourteen other tables
   stay single-layer, and a query that starts from them — chat, recordings,
   transcripts — is not covered. Partial safety that reads as complete.

3. **Filter every Connect entity: meetings directly, children through their
   meeting.**
   `ConnectMeeting`: `e => e.TenantId == tenant.TenantId`, the codebase's own
   pattern. Children with a `MeetingId`: a filter through the meeting, or a
   `tenant_id` column added. Every path that reads without a tenant is found and
   either enters the tenant first or uses `IgnoreQueryFilters()` with a comment
   naming why. Most work; the only option that makes Connect match the rest.

## Recommendation

**Option 3, in two steps.**

- **Step one, ConnectMeeting**, because it is the table the finding was made on
  and the Meetings API reads it with an organisation key. Proof: the PR 193
  mutation run (`MUTATE_BYPASS_RLS=1`) must turn **green** — the other
  organisation's class must stay out even with RLS bypassed. Every Connect suite
  re-run, and the guest door walked end to end.
- **Step two, the child tables**, after an inventory of every tenantless read
  path, table by table.

**One warning for whoever builds it.** `IgnoreQueryFilters()` removes EVERY filter
on that query, including any added later. It must never be the default fix for
"the filter broke this path". The first choice is to enter the tenant before the
query. `IgnoreQueryFilters()` is for a path that genuinely has no tenant, and
each use carries a comment saying why.

## Consequences

- Connect gains the same two layers as the rest. A lost RLS policy becomes a
  failure the application also stops, rather than a silent leak.
- `AppDbContext.cs` is a shared registry: the change is additive only, and needs
  this gate anyway.
- Every tenantless path has to be found and named. That inventory is itself
  worth having; nobody holds it today.
- Some Connect reads get a join they did not have. Not measured.

## Revisit when

- Any migration touches RLS on a `connect.*` table.
- The API's database role changes, or a second role is introduced.
- A Connect table is added: it gets its filter in the same change, or this record
  is reopened.

## Questions for Mr. Singh

1. Option 1, 2 or 3?
2. If 3: may step one ship on its own, before the child-table inventory?
3. Should the rule go further: every new tenant-owned entity must have a query
   filter, enforced by a test that fails when one is mapped without it?

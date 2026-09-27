# 0007 — Connect's tables get a second isolation layer

**Status:** accepted by Mr. Singh, 24 Sept 2026, with the conditions and additions in his ruling below. Step one is PR 288.
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

---

## Ruling — Mr. Singh, 24 September 2026 (his words, transcribed exactly)

> **Ruling on decision 0007 — Connect tenant isolation, second layer. Mr. Singh, 24 Sept 2026.**
>
> Option 3, in two steps. Option 2 is "partial safety that reads as complete," which is worse than option 1 because it creates confidence with nothing behind it.
>
> Step one, `ConnectMeeting`, may ship on its own. Three conditions on step one. The PR 193 bypass mutation (`MUTATE_BYPASS_RLS=1`) must go green on `ConnectMeeting` — the other organisation's class stays out even with row-level security bypassed. The LiveKit webhook and egress callback paths must be walked before merge, not after: a filter with no tenant set returns nothing, and a webhook returning nothing is a silently dropped recording. And the tenantless-path inventory is started as a checked-in file in the same PR, even though the child-table filters come in step two. Nobody holds that inventory today; it is worth more than the filters.
>
> Yes to the enforcement test: every entity with a tenant, directly or through its parent, must carry a query filter, or the build fails. The rule lives in a test, not a comment.
>
> Two additions. `core.departments` carries no row-level security at all — worse than Connect's one layer — and 0007 absorbs it: policy on, with the mail edge reading it through a `SECURITY DEFINER` function, as the guest door does. And in step two, the child tables get a `tenant_id` column rather than a join through the meeting; chat and caption lines are high-volume, and a parent join per row is a performance trap.
>
> Status: accepted, with the above attached.

*[Transcriber's note, 25 Sept, added on Mr. Singh's instruction of 27 Sept:
"a filter with no tenant set returns nothing" — in this codebase it does not
return nothing: `TenantContext.TenantId` **throws** when no tenant is set, and
the LiveKit webhook's catch-all turns the throw into a 200 with nothing written.
The practical effect, a silent drop, is the same; that is what the ruling
addresses, and it stands.]*

## Further ruling — Mr. Singh, 27 September 2026 (his words, transcribed exactly)

> **The enforcement test found what enforcement tests are for.** Twelve tenant-owned tables outside Connect with no filter — seven Calendar, four Mail, one sign-in — and two of them with no database layer either. That's a bigger finding than the one 0007 started with, and it came from making the rule a test rather than a sentence. The allow-list that can only shrink is the right shape. One addition: **each entry in it gets an owner and a date, not only a name.** An allow-list with names alone becomes permanent furniture; one with dates gets emptied.
>
> **`calendar.reminder_sends`: yes, 0007 covers it.** Same shape as `core.departments` — no isolation at any layer and nothing explaining why. Put the two in one PR: the zero-layer tables get a policy each, and the mail edge gets its definer function for departments. That's a schema change and it comes to me.
>
> **`mfa_recovery_codes` without RLS, on purpose:** I accept the reasoning — a row is only findable by someone who already holds the code. Two questions before I close it: are the codes hashed at rest, and is the lookup constant-time? If the answer to either is no, the reasoning holds but the table doesn't.
>
> **"Throws" versus "returns nothing":** you were right to flag it without editing my words. Add a bracketed correction beneath the ruling, marked as the transcriber's note. The practical effect — a silent drop — is what I was ruling on, and that stands.
>
> **The CI step in 288: approved.** A test that fails the build when a tenant-owned table has no filter is exactly the kind of check CI exists to run.


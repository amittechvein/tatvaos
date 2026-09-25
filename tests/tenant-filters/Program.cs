// ============================================================================
//  EVERY TENANT-OWNED ENTITY CARRIES A QUERY FILTER, OR THE BUILD FAILS.
// ============================================================================
//
//  Mr. Singh's ruling on decision 0007, 24 Sept 2026: "every entity with a
//  tenant, directly or through its parent, must carry a query filter, or the
//  build fails. The rule lives in a test, not a comment."
//
//  WHY. Row-level security was Connect's only isolation layer. With RLS
//  bypassed, the Meetings API returned another organisation's classes
//  (tests/orgapi/test-paging-promises.sh, MUTATE_BYPASS_RLS=1). The EF filter
//  is the second layer, and the gap was invisible because nothing listed
//  which entities had one.
//
//  WHAT IT CHECKS. The EF model is built offline, with no database: Npgsql
//  builds the model without connecting. For every entity type:
//
//    tenant-owned DIRECTLY       it has a TenantId property.
//    tenant-owned THROUGH PARENT it has a declared foreign key to a
//                                tenant-owned entity, OR a property named
//                                "...<Word>Id" where an entity type's name
//                                ends in <Word> and that entity is
//                                tenant-owned. MeetingId -> ConnectMeeting,
//                                MailboxId -> Mailbox, CreatedByUserId ->
//                                User. By name, because many Connect children
//                                declare no foreign key at all.
//
//  A tenant-owned entity with no query filter fails, unless it is in
//  KNOWN_GAPS below. KNOWN_GAPS must match the violations EXACTLY: an entry
//  that has been fixed also fails, so the list can only shrink, and a new
//  entity without a filter can never slip in beside the old ones.
//
//  IT PROVES IT CAN SEE. It fails if it scanned fewer than 60 entity types,
//  if ConnectMeeting is not found tenant-owned-and-filtered, or if a
//  known-unfiltered child (ConnectParticipant) is not found tenant-owned.
//  MUTATE_DROP=<EntityName> makes it treat that entity as unfiltered; with
//  MUTATE_DROP=ConnectMeeting it must go red (house rule 6).
//
//  No test framework, like tests/connect-wire: `dotnet run` and read the last
//  line; the exit code is the verdict.
// ============================================================================

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

// Every entity that is tenant-owned and has NO filter today, with why. Remove
// a line in the same change that adds the filter. Never add one to make a new
// entity pass: give the entity its filter.
var KNOWN_GAPS = new Dictionary<string, string>
{
    // Connect: decision 0007 step two (child tables get tenant_id, then filters).
    ["ConnectCaptionLine"] = "0007 step two",
    ["ConnectLobbyRequest"] = "0007 step two",
    ["ConnectMeetingBlock"] = "0007 step two",
    ["ConnectMeetingChat"] = "0007 step two",
    ["ConnectMeetingEvent"] = "0007 step two",
    ["ConnectMeetingInvitation"] = "0007 step two (has tenant_id; filter only)",
    ["ConnectMeetingNotes"] = "0007 step two",
    ["ConnectParticipant"] = "0007 step two",
    ["ConnectRecording"] = "0007 step two",
    ["ConnectRecordingAccess"] = "0007 step two (has tenant_id; filter only)",
    ["ConnectRecordingShare"] = "0007 step two (has tenant_id; filter only)",
    ["ConnectRecordingShareGrant"] = "0007 step two (has tenant_id; filter only)",
    ["ConnectTenantSettings"] = "0007 step two (has tenant_id; filter only)",
    ["ConnectTranscript"] = "0007 step two",

    // Found by this test on its first run, 25 Sept 2026, outside Connect.
    // Each still has forced RLS unless it says otherwise; the ones that do
    // not are the same class as core.departments (no layer at all).
    ["CalendarCalendar"] = "Mail lane (calendar); RLS forced",
    ["CalendarEvent"] = "Mail lane (calendar); RLS forced",
    ["CalendarAttendee"] = "Mail lane (calendar); RLS forced",
    ["CalendarEventException"] = "Mail lane (calendar); RLS forced",
    ["CalendarMember"] = "Mail lane (calendar); RLS forced",
    ["CalendarReminder"] = "Mail lane (calendar); RLS forced",
    ["CalendarReminderSend"] = "Mail lane (calendar); NO RLS EITHER - no layer at all, undocumented",
    ["MailApiKey"] = "Mail lane; RLS forced",
    ["MailApiSend"] = "Mail lane; RLS forced",
    ["MailAppPassword"] = "Mail lane; RLS forced",
    ["MailboxPermission"] = "Mail lane; RLS forced",
    ["MfaRecoveryCode"] = "Core (auth); NO RLS by design - read before the tenant is known "
                          + "(0024-mfa.sql); every lookup is by user_id + a 256-bit hash",
};

var opts = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql("Host=model-only").Options;
using var db = new AppDbContext(opts, new TenantContext());
var types = db.Model.GetEntityTypes().Where(e => !e.IsOwned()).ToList();
var mutateDrop = Environment.GetEnvironmentVariable("MUTATE_DROP");

bool Filtered(IEntityType e) =>
    e.ClrType.Name != mutateDrop && e.GetDeclaredQueryFilters().Count > 0;

// Tenant-owned, to a fixed point: a child of a child of a tenant-owned entity
// is tenant-owned too.
var owned = types.Where(e => e.FindProperty("TenantId") is not null).ToHashSet();
var reason = owned.ToDictionary(e => e, _ => "TenantId");
for (var changed = true; changed;)
{
    changed = false;
    foreach (var e in types.Where(t => !owned.Contains(t)))
    {
        var viaFk = e.GetForeignKeys().Select(f => f.PrincipalEntityType).FirstOrDefault(owned.Contains);
        string? why = viaFk is not null ? $"foreign key to {viaFk.ClrType.Name}" : null;
        if (why is null)
        {
            foreach (var p in e.GetProperties().Where(p => p.Name.EndsWith("Id") && p.Name != "Id"))
            {
                var stem = p.Name[..^2];
                var word = LastWord(stem);
                var parent = owned.FirstOrDefault(o => o.ClrType.Name.EndsWith(word, StringComparison.Ordinal));
                if (parent is not null) { why = $"{p.Name} -> {parent.ClrType.Name}"; break; }
            }
        }
        if (why is not null) { owned.Add(e); reason[e] = why; changed = true; }
    }
}

var failed = 0;
void Fail(string m) { failed++; Console.WriteLine($"  FAIL  {m}"); }
void Ok(string m) => Console.WriteLine($"  ok    {m}");

Console.WriteLine($"Tenant query filters: {types.Count} entity types, {owned.Count} tenant-owned"
                  + (mutateDrop is null ? "" : $"   *** MUTATE_DROP={mutateDrop} ***") + "\n");

// It can see.
if (types.Count >= 60) Ok($"scanned {types.Count} entity types"); else Fail($"scanned only {types.Count} entity types");
var meeting = types.FirstOrDefault(t => t.ClrType.Name == "ConnectMeeting");
if (meeting is not null && owned.Contains(meeting) && Filtered(meeting)) Ok("ConnectMeeting is tenant-owned and filtered (0007 step one)");
else Fail("ConnectMeeting is not seen as tenant-owned AND filtered");
var participant = types.FirstOrDefault(t => t.ClrType.Name == "ConnectParticipant");
if (participant is not null && owned.Contains(participant)) Ok($"ConnectParticipant is seen as tenant-owned ({reason[participant]})");
else Fail("ConnectParticipant (no TenantId, no declared FK) is not seen as tenant-owned: the by-name rule is blind");

// The rule.
var gaps = owned.Where(e => !Filtered(e)).Select(e => e.ClrType.Name).ToHashSet();
foreach (var name in gaps.OrderBy(n => n))
{
    var e = owned.First(o => o.ClrType.Name == name);
    if (KNOWN_GAPS.ContainsKey(name)) Console.WriteLine($"  known {name} ({reason[e]}) - {KNOWN_GAPS[name]}");
    else Fail($"{name} ({e.GetSchema()}.{e.GetTableName()}) is tenant-owned ({reason[e]}) and has NO query filter");
}
foreach (var name in KNOWN_GAPS.Keys.Where(k => !gaps.Contains(k)).OrderBy(n => n))
    Fail($"{name} is in KNOWN_GAPS but has a filter now (or is gone): remove its line");

Console.WriteLine();
Console.WriteLine(failed == 0
    ? $"  PASS  {owned.Count} tenant-owned entities: {owned.Count - gaps.Count} filtered, {gaps.Count} known gaps"
    : $"  FAIL  {failed} problem(s)");
return failed == 0 ? 0 : 1;

static string LastWord(string pascal)
{
    for (var i = pascal.Length - 1; i > 0; i--)
        if (char.IsUpper(pascal[i])) return pascal[i..];
    return pascal;
}

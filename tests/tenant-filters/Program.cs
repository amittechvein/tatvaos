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
//  MUTATE_DROP=ConnectMeeting it must go red (house rule 6). TODAY_OVERRIDE=
//  <yyyy-mm-dd> runs it as if on that day, to see an overdue gap fail.
//
//  No test framework, like tests/connect-wire: `dotnet run` and read the last
//  line; the exit code is the verdict.
// ============================================================================

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

// Every entity that is tenant-owned and has NO filter today: who owns closing
// it, and by when. Mr. Singh, 27 Sept 2026: "each entry in it gets an owner
// and a date, not only a name. An allow-list with names alone becomes
// permanent furniture; one with dates gets emptied." A date that has passed
// FAILS the build: move the date only with a reason in the same change.
// Remove a line in the same change that adds the filter. Never add one to make
// a new entity pass: give the entity its filter.
//
// Dates proposed by the lane on 27 Sept, for Mr. Singh to confirm or move.
var S2 = new DateOnly(2026, 10, 31);   // 0007 step two
var CAL = new DateOnly(2026, 10, 31);  // calendar / mail filters
var ZERO = new DateOnly(2026, 10, 15); // the zero-layer PR (departments + reminder_sends)
var KNOWN_GAPS = new Dictionary<string, Gap>
{
    // Connect: decision 0007 step two (child tables get tenant_id, then filters).
    ["ConnectCaptionLine"] = new("Connect", S2, "0007 step two"),
    ["ConnectLobbyRequest"] = new("Connect", S2, "0007 step two"),
    ["ConnectMeetingBlock"] = new("Connect", S2, "0007 step two"),
    ["ConnectMeetingChat"] = new("Connect", S2, "0007 step two"),
    ["ConnectMeetingEvent"] = new("Connect", S2, "0007 step two"),
    ["ConnectMeetingInvitation"] = new("Connect", S2, "0007 step two (has tenant_id; filter only)"),
    ["ConnectMeetingNotes"] = new("Connect", S2, "0007 step two"),
    ["ConnectParticipant"] = new("Connect", S2, "0007 step two"),
    ["ConnectRecording"] = new("Connect", S2, "0007 step two"),
    ["ConnectRecordingAccess"] = new("Connect", S2, "0007 step two (has tenant_id; filter only)"),
    ["ConnectRecordingShare"] = new("Connect", S2, "0007 step two (has tenant_id; filter only)"),
    ["ConnectRecordingShareGrant"] = new("Connect", S2, "0007 step two (has tenant_id; filter only)"),
    ["ConnectTenantSettings"] = new("Connect", S2, "0007 step two (has tenant_id; filter only)"),
    ["ConnectTranscript"] = new("Connect", S2, "0007 step two"),

    // Found by this test on its first run, 25 Sept 2026, outside Connect.
    ["CalendarCalendar"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarEvent"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarAttendee"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarEventException"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarMember"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarReminder"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarReminderSend"] = new("Mail (calendar)", ZERO,
        "NO RLS EITHER; 0007 covers it with core.departments (Mr. Singh, 27 Sept)"),
    ["MailApiKey"] = new("Mail", CAL, "RLS forced"),
    ["MailApiSend"] = new("Mail", CAL, "RLS forced"),
    ["MailAppPassword"] = new("Mail", CAL, "RLS forced"),
    ["MailboxPermission"] = new("Mail", CAL, "RLS forced"),
    ["MfaRecoveryCode"] = new("Core (auth)", ZERO,
        "NO RLS by design - read before the tenant is known (0024-mfa.sql); "
        + "Mr. Singh's two questions (hashed at rest? constant-time?) open before he closes it"),
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

// India time: the dates are written in it, and a gap is due at the end of its day there.
var today = DateOnly.FromDateTime(DateTime.UtcNow.AddHours(5.5));
if (Environment.GetEnvironmentVariable("TODAY_OVERRIDE") is { Length: > 0 } t) today = DateOnly.Parse(t);
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
    if (KNOWN_GAPS.TryGetValue(name, out var g))
    {
        if (string.IsNullOrWhiteSpace(g.Owner)) Fail($"{name}: allowed gap with no owner");
        else if (g.Due < today) Fail($"{name}: allowed gap OVERDUE - owner {g.Owner}, due {g.Due:yyyy-MM-dd} ({g.Why})");
        else Console.WriteLine($"  known {name} ({reason[e]}) - {g.Owner}, due {g.Due:yyyy-MM-dd}: {g.Why}");
    }
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

record Gap(string Owner, DateOnly Due, string Why);

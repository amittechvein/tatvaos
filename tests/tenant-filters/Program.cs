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

// ----------------------------------------------------------------------------
//  OWED A FIX (KNOWN_GAPS). Correct-by-design tables are in BY_DESIGN below.
// ----------------------------------------------------------------------------
// Every entity that is tenant-owned and has NO filter today: who owns closing
// it, and by when. Mr. Singh, 27 Sept 2026: "each entry in it gets an owner
// and a date, not only a name. An allow-list with names alone becomes
// permanent furniture; one with dates gets emptied." A date that has passed
// FAILS the build: move the date only with a reason in the same change.
// Remove a line in the same change that adds the filter. Never add one to make
// a new entity pass: give the entity its filter.
//
// Dates proposed by the lane on 27 Sept, for Mr. Singh to confirm or move.
var CAL = new DateOnly(2026, 10, 31);  // calendar / mail filters
var KNOWN_GAPS = new Dictionary<string, Gap>
{
    // Connect: all fourteen closed by 0007 step two (28 Sept 2026).

    // Found by this test on its first run, 25 Sept 2026, outside Connect.
    ["CalendarCalendar"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarEvent"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarAttendee"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarEventException"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarMember"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["CalendarReminder"] = new("Mail (calendar)", CAL, "RLS forced"),
    ["MailApiKey"] = new("Mail", CAL, "RLS forced"),
    ["MailApiSend"] = new("Mail", CAL, "RLS forced"),
    // Mr. Singh, 6 Oct 2026 (his wording). Reached main with PR 373 while this
    // test was on its branch. The database is the ONLY net here, not the second.
    // NO DATE, A CHECK (his second ruling that day): its safety does not decay
    // with time but the moment someone adds a read, so EnvelopeStillWriteOnly
    // below enforces the sentence instead of a date standing in for it.
    ["MailApiSendEnvelope"] = new("Mail", null,
        "No EF query filter. Safe only because nothing reads it: no DbSet, one write site, "
        + "and SELECT/INSERT only. The database is not the second net here, it is the only net. "
        + "Anyone adding a read adds the query filter in the same pull request. Dated 6 Oct 2026",
        EnvelopeStillWriteOnly),
    ["MailAppPassword"] = new("Mail", CAL, "RLS forced"),
    ["MailboxPermission"] = new("Mail", CAL, "RLS forced"),
};

// ----------------------------------------------------------------------------
//  CORRECT BY DESIGN - DO NOT "FIX". Mr. Singh, 6 Oct 2026: a table the scan
//  sees as tenant-owned but that cannot carry a tenant filter, because it is
//  read or written BEFORE any tenant exists. Not a gap and not owed a fix:
//  each entry names what protects it instead. Filed as a gap, someone would
//  one day "tidy" it with a filter and break the flow it serves.
//  Matched as strictly as KNOWN_GAPS: an entry that gains a filter, or that
//  is also in KNOWN_GAPS, fails - either is a sign someone misread it.
// ----------------------------------------------------------------------------
var BY_DESIGN = new Dictionary<string, Design>
{
    ["PersonalSignup"] = new("Core",
        "No tenant_id - by design, a signup precedes its tenant. Not an exception owed a fix. "
        + "Guarded instead by: a random v4 draft id acting as the bearer token; the code hashed with that id "
        + "as salt, single-use, attempt-capped and lifetime-capped; rate limits on phone hash and IP; the "
        + "plaintext phone cleared at completion (JoinEndpoints.cs:428) and the whole row pruned after a day, hourly"),
    // Moved from KNOWN_GAPS by Mr. Singh, 6 Oct 2026.
    ["MfaRecoveryCode"] = new("Core",
        "No tenant filter - by design: the code is read at redeem only, before the tenant is known (0024-mfa.sql)"),
    // Mr. Singh, 6 Oct 2026 (both): arrived with the personal-accounts chain.
    ["AiTrial"] = new("Core",
        "No tenant filter - by design: one AI trial per phone number, ever, across EVERY account, so the "
        + "'no second trial on the same phone' rule must see trials started from any account; a tenant filter "
        + "would quietly grant a second trial. Keyed by phone HASH, not number; user_id SET NULL on delete"),
    ["PersonalAiConsent"] = new("Core",
        "No tenant filter - by design, and a tenant filter would be WORSE than none: every personal account "
        + "shares the one house tenant, so it would protect nothing while turning this check green. Scoped "
        + "instead by the person: every read pins one UserId. PersonalAiReadsOwnRowOnly's real protection is the "
        + "FILE ALLOWLIST (a new reader fails and a person reads it); its pin test proves a UserId is pinned, NOT "
        + "that the id came from the session - `a.UserId == req.UserId` would pass. A secondary signal, not a guarantee",
        PersonalAiReadsOwnRowOnly),
    // Mr. Singh, 6 Oct 2026: confirmed by design (retired_addresses_one_live is
    // unique on (address) alone, platform-wide; the row-content endpoint is SuperAdmin only).
    ["RetiredAddress"] = new("Core",
        "No tenant filter - by design: ONE list of held addresses across every organisation and the "
        + "personal house, so that an address retired by one organisation cannot be taken by another. "
        + "A tenant filter would make IsHeldAsync see only the caller's own holds and let an address be reused - "
        + "live mail routing to the wrong company. tenant_id on this table is PROVENANCE, NOT SCOPE: 'the "
        + "organisation it was retired from', nullable and deliberately without a foreign key so the hold outlives "
        + "a deleted organisation. Never filter on it: the uniqueness it protects is platform-wide. Read only by "
        + "RetiredAddresses.IsHeldAsync (address -> held?, no row content returned) and /api/admin/retired-addresses (SuperAdmin)"),
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
    if (KNOWN_GAPS.ContainsKey(name) && BY_DESIGN.ContainsKey(name))
        Fail($"{name} is in BOTH KNOWN_GAPS and BY_DESIGN: it is one or the other");
    else if (BY_DESIGN.TryGetValue(name, out var bd))
    {
        if (bd.Guard?.Invoke() is string broken) Fail($"{name}: {broken}");
        else Console.WriteLine($"  by design {name} ({reason[e]}) - {bd.Owner}, do not \"fix\": {bd.Why}");
    }
    else if (KNOWN_GAPS.TryGetValue(name, out var g))
    {
        if (string.IsNullOrWhiteSpace(g.Owner)) Fail($"{name}: allowed gap with no owner");
        else if (g.Due is null && g.Guard is null) Fail($"{name}: allowed gap with neither a date nor a check");
        else if (g.Due is DateOnly due && due < today) Fail($"{name}: allowed gap OVERDUE - owner {g.Owner}, due {due:yyyy-MM-dd} ({g.Why})");
        else if (g.Guard?.Invoke() is string broken) Fail($"{name}: {broken}");
        else Console.WriteLine($"  known {name} ({reason[e]}) - {g.Owner}, "
                               + (g.Due is DateOnly d ? $"due {d:yyyy-MM-dd}" : "no date: guarded by a check") + $": {g.Why}");
    }
    else Fail($"{name} ({e.GetSchema()}.{e.GetTableName()}) is tenant-owned ({reason[e]}) and has NO query filter");
}
foreach (var name in KNOWN_GAPS.Keys.Where(k => !gaps.Contains(k)).OrderBy(n => n))
    Fail($"{name} is in KNOWN_GAPS but has a filter now (or is gone): remove its line");
foreach (var name in BY_DESIGN.Keys.Where(k => !gaps.Contains(k)).OrderBy(n => n))
    Fail($"{name} is in BY_DESIGN but has a filter now (or is gone): a pre-tenant table was 'fixed' - check its flow still works, then remove the line");

var byDesign = gaps.Count(BY_DESIGN.ContainsKey);
Console.WriteLine();
Console.WriteLine(failed == 0
    ? $"  PASS  {owned.Count} tenant-owned entities: {owned.Count - gaps.Count} filtered, {gaps.Count - byDesign} owed a fix, {byDesign} correct by design"
    : $"  FAIL  {failed} problem(s)");
return failed == 0 ? 0 : 1;

static string LastWord(string pascal)
{
    for (var i = pascal.Length - 1; i > 0; i--)
        if (char.IsUpper(pascal[i])) return pascal[i..];
    return pascal;
}

// ----------------------------------------------------------------------------
//  MailApiSendEnvelope is safe without a query filter only while nothing reads
//  it (Mr. Singh, 6 Oct 2026). All three protections are visible in source, so
//  this asserts them: the type is named on exactly three lines in apps/api -
//  its declaration, its model line, and the one write (.Add) - and nowhere
//  else. A fourth line is how a read would arrive. Source scan, no database,
//  the same family as tests/ai/every_ai_entry_calls_gate.py. Matched by what
//  each line says, not its line number: AppDbContext's line moves as models
//  are added above it (377 on main, 378 here, on 6 Oct).
// ----------------------------------------------------------------------------
static string? EnvelopeStillWriteOnly()
{
    const string Type = "MailApiSendEnvelope";
    var api = FindApi();
    if (api is null) return "cannot find apps/api from the working directory, so the write-only check did not run";
    var hits = Directory.EnumerateFiles(api, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                 && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
        .SelectMany(f => File.ReadLines(f).Select((line, i) => (File: Path.GetFileName(f), No: i + 1, Line: line)))
        .Where(h => System.Text.RegularExpressions.Regex.IsMatch(h.Line, $@"\b{Type}\b"))
        .ToList();
    bool Has(string file, string text) => hits.Any(h => h.File == file && h.Line.Contains(text));
    var expected = Has("MailApiKey.cs", $"class {Type}")
                && Has("AppDbContext.cs", $"Entity<TatvaOS.Api.Modules.Mail.{Type}>()")
                && Has("MailSendApiEndpoints.cs", $"Set<{Type}>().Add(");
    if (!expected || hits.Count < 3)
        return $"the write-only check lost one of its three known lines (found {hits.Count}): "
             + "re-read where api_send_envelopes is declared, modelled and written before trusting this entry";
    if (hits.Count > 3)
        return "a read may have been added to api_send_envelopes - add the EF query filter in this PR, "
             + "and move the entry out of KNOWN_GAPS. New line(s): "
             + string.Join("; ", hits.Where(h => !(h.File == "MailApiKey.cs" || h.File == "AppDbContext.cs"
                                                   || (h.File == "MailSendApiEndpoints.cs" && h.Line.Contains($"Set<{Type}>().Add("))))
                                     .Select(h => $"{h.File}:{h.No}"));
    return null;
}

static string? FindApi()
{
    for (var d = new DirectoryInfo(Directory.GetCurrentDirectory()); d is not null; d = d.Parent)
        if (Directory.Exists(Path.Combine(d.FullName, "apps", "api"))) return Path.Combine(d.FullName, "apps", "api");
    return null;
}

// ----------------------------------------------------------------------------
//  core.personal_ai is safe without a tenant filter only because every read
//  pins ONE person's row (Mr. Singh, 6 Oct 2026). Asserted in source: the
//  DbSet is used only where it is used today, and each use names a single
//  UserId (or is the one .Add). A new file using it fails, so a new reader is
//  read by a person before it lands - an operator list of everyone's consent,
//  say, would be correct only behind its own check.
//
//  WHAT IT PROVES, AND WHAT IT DOES NOT (Mr. Singh, 6 Oct). The protection is
//  the ALLOWLIST, matched on the path under apps/api (not the bare file name,
//  so a second OpenAiGateway.cs elsewhere is not waved through). The pin test
//  only proves a UserId is pinned, not that it came from the session:
//  `a.UserId == req.UserId` passes it. Treat a green pin as a signal.
//  THE TWO-LINE WINDOW IS DELIBERATE: the pin is looked for on the matched
//  line and the next one. A long LINQ chain with `.UserId ==` further down
//  fails it - put the pin next to the read; do not widen the window.
// ----------------------------------------------------------------------------
static string? PersonalAiReadsOwnRowOnly()
{
    string[] allowed = ["Modules/Personal/PersonalAiService.cs", "Shared/Ai/OpenAiGateway.cs"];
    var api = FindApi();
    if (api is null) return "cannot find apps/api from the working directory, so the own-row check did not run";
    var uses = new List<(string File, int No, string Here)>();
    foreach (var f in Directory.EnumerateFiles(api, "*.cs", SearchOption.AllDirectories)
                 .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                          && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")))
    {
        var lines = File.ReadAllLines(f);
        for (var i = 0; i < lines.Length; i++)
            if (System.Text.RegularExpressions.Regex.IsMatch(lines[i], @"\.PersonalAi\b"))
                uses.Add((Path.GetRelativePath(api, f).Replace(Path.DirectorySeparatorChar, '/'), i + 1,
                          lines[i] + " " + (i + 1 < lines.Length ? lines[i + 1] : "")));
    }
    if (uses.Count == 0) return "found no use of db.PersonalAi at all: the own-row check is looking in the wrong place";
    var outside = uses.Where(u => !allowed.Contains(u.File)).ToList();
    if (outside.Count > 0)
        return "personal_ai is used in a new place - check it reads only the caller's own row, then add the file "
             + "to PersonalAiReadsOwnRowOnly: " + string.Join("; ", outside.Select(u => $"{u.File}:{u.No}"));
    var unpinned = uses.Where(u => !System.Text.RegularExpressions.Regex.IsMatch(u.Here, @"\.UserId == |\.Add\(")).ToList();
    if (unpinned.Count > 0)
        return "a read of personal_ai that does not pin one UserId - every read must be the caller's own row: "
             + string.Join("; ", unpinned.Select(u => $"{u.File}:{u.No}"));
    return null;
}

record Gap(string Owner, DateOnly? Due, string Why, Func<string?>? Guard = null);
record Design(string Owner, string Why, Func<string?>? Guard = null);

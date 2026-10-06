// ============================================================================
//  Organisations unchanged, MEASURED (Mr. Singh on PR 313, 28 Sept 2026).
//
//  For every organisation user in the database it is pointed at, this runs
//  the API's OWN code (not a copy of its logic) for what that person's
//  organisation gets, and writes one line per user:
//      <user id> <tab> <tenant id> <tab> <sha256 of the canonical answer>
//  plus the canonical answers themselves (per organisation, no personal data)
//  so a difference can be read, not just counted.
//
//  The answer: PlanEntitlements.ResolveAsync (plan, products, every feature's
//  included/limit/source), AiCredits.AllowanceAsync (the monthly AI credits),
//  StorageAllocator.GetCapacityAsync (storage model, totals, seats) — the
//  three organisation readers of core.subscriptions PR 313 touched that
//  decide what a customer gets.
//
//  Built as "after" (PR 313's code, -p:Side=after) it ALSO asks the new
//  per-person answer, EffectiveSettings.ForUserAsync, for every organisation
//  user and counts those whose features differ from the organisation's, or
//  that come back Enforced or Personal — the new code path an organisation
//  user now goes through.
//
//  No web host, no workers: nothing here can send mail, call AI or write.
//  Connects as a superuser to a COPY; RLS is not the question here.
// ============================================================================
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Ai;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Plans;
using TatvaOS.Api.Shared.Tenancy;

if (args.Length < 2) { Console.Error.WriteLine("usage: PlansMeasure <connection string> <out prefix>"); return 2; }
var ct = CancellationToken.None;
var tenant = new TenantContext();
var options = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(args[0]).Options;
await using var db = new AppDbContext(options, tenant);

var json = new JsonSerializerOptions { WriteIndented = false };
string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

var tenants = await db.Tenants.IgnoreQueryFilters().AsNoTracking()
    .OrderBy(t => t.Id).Select(t => t.Id).ToListAsync(ct);
var lines = new List<string>();
var answers = new List<string>();
int users = 0, effDiffers = 0, orgTenants = 0;

foreach (var tid in tenants)
{
    tenant.EnterPlatformScope(tid, Guid.Empty);
#if AFTER
    // The personal house is not an organisation (and does not exist on
    // production); everything else is.
    if (await new TatvaOS.Api.Modules.Personal.PersonalHouse(db).IsPersonalHouseAsync(tid, ct)) continue;
#endif
    orgTenants++;
    var ent = await PlanEntitlements.ResolveAsync(db, tid, ct);
    var ai = await AiCredits.AllowanceAsync(db, tid, ct);
    object cap;
    try { cap = await new StorageAllocator(db).GetCapacityAsync(tid, "mail", ct); }
    catch (Exception ex) { cap = new { error = ex.GetType().Name + ": " + ex.Message }; }
    var answer = JsonSerializer.Serialize(new { ent, ai, cap }, json);
    answers.Add($"{tid}\t{answer}");
    var hash = Sha(answer);

    var ids = await db.Users.IgnoreQueryFilters().AsNoTracking()
        .Where(u => u.TenantId == tid).OrderBy(u => u.Id).Select(u => u.Id).ToListAsync(ct);
    foreach (var uid in ids)
    {
        users++;
        lines.Add($"{uid}\t{tid}\t{hash}");
#if AFTER
        var eff = await new EffectiveSettings(db, new TatvaOS.Api.Modules.Personal.PersonalHouse(db),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<EffectiveSettings>.Instance).ForUserAsync(uid, ct);
        var fromOrg = ent.Features.ToDictionary(f => f.Code, f => (f.Included, f.Limit));
        var same = eff is not null && !eff.Enforced && !eff.Personal
                   && eff.Features.Count == fromOrg.Count
                   && eff.Features.All(kv => fromOrg.TryGetValue(kv.Key, out var o)
                                             && o.Included == kv.Value.Included && o.Limit == kv.Value.Limit);
        if (!same) { effDiffers++; Console.Error.WriteLine($"effective answer differs for user {uid} (tenant {tid})"); }
#endif
    }
}

File.WriteAllLines(args[1] + ".users.tsv", lines);
File.WriteAllLines(args[1] + ".answers.tsv", answers);
Console.WriteLine($"organisations={orgTenants} users={users}"
#if AFTER
    + $" effective_differs={effDiffers}"
#endif
);
return 0;

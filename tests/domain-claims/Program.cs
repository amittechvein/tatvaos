using TatvaOS.Api.Modules.Core;

namespace TatvaOS.Tests.DomainClaims;

/// <summary>
/// Who may claim a domain, who wins it, and which claims go stale
/// (Modules/Core/DomainClaims.cs).
///
/// Mr. Singh, 24 September 2026: an unverified claim used to lock a domain
/// name for everyone, so anyone with an account could add the domains of
/// every school in a district and stop all of them onboarding. Exclusivity
/// now comes from verification.
///
/// These rules decide who is locked out of their own domain, so they are
/// tested where they can be: as pure functions, with no database and no DNS.
///
/// Usage: dotnet run --project tests/domain-claims
/// Exit:  0 all passed, 1 otherwise.
/// </summary>
internal static class Program
{
    private static int passed, failed;

    private static void Ok(string what, bool ok)
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}"); }
    }

    private static readonly Guid School = Guid.NewGuid();
    private static readonly Guid Squatter = Guid.NewGuid();
    private static readonly Guid Third = Guid.NewGuid();
    private static readonly DateTimeOffset Now = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);

    private static Api.Modules.Core.DomainClaims.Claim Claim(
        Guid tenant, bool verified = false, bool superseded = false, int ageDays = 0, Guid? id = null) =>
        new(id ?? Guid.NewGuid(), tenant, verified, superseded, Now.AddDays(-ageDays));

    private static int Main()
    {
        Console.WriteLine();
        Console.WriteLine("  Domain claims");
        Console.WriteLine("  =============");

        Console.WriteLine();
        Console.WriteLine("  The squatting case Mr. Singh described");

        // The squatter claims the school's domain first. Before 24 Sept this
        // locked the name and the school could not add it at all.
        var squatterClaim = Claim(Squatter);
        Ok("a pending claim does NOT stop the real owner adding the domain",
            Api.Modules.Core.DomainClaims.RefusalToAdd([squatterClaim], School, 0) is null);

        Ok("a hundred pending claims still do not stop them",
            Api.Modules.Core.DomainClaims.RefusalToAdd(
                Enumerable.Range(0, 100).Select(_ => Claim(Squatter)).ToList(), School, 0) is null);

        // The school publishes the TXT record and verifies.
        var schoolWins = Claim(School, verified: true);
        var refusal = Api.Modules.Core.DomainClaims.RefusalToAdd([schoolWins], Third, 0);
        Ok("once verified, nobody else may claim it", refusal is not null);
        Ok("and the refusal never names the organisation that holds it",
            refusal is not null
            && !refusal.Contains("techvein", StringComparison.OrdinalIgnoreCase)
            && !refusal.Contains(School.ToString())
            && refusal.Contains("contact support"));

        Ok("the losing claims are exactly the other live ones",
            Api.Modules.Core.DomainClaims.LosersOf([schoolWins, squatterClaim], schoolWins.Id)
                is [var only] && only == squatterClaim.Id);

        Ok("an already-closed claim is not closed twice",
            Api.Modules.Core.DomainClaims.LosersOf(
                [schoolWins, Claim(Squatter, superseded: true)], schoolWins.Id).Count == 0);

        Ok("the winner never supersedes itself",
            !Api.Modules.Core.DomainClaims.LosersOf([schoolWins, squatterClaim], schoolWins.Id)
                .Contains(schoolWins.Id));

        Ok("what the loser is told says why, not who",
            Api.Modules.Core.DomainClaims.SupersededNotice.Contains("verified by its owner")
            && !Api.Modules.Core.DomainClaims.SupersededNotice.Contains("organisation named")
            && Api.Modules.Core.DomainClaims.SupersededNotice.Contains("contact support"));

        Console.WriteLine();
        Console.WriteLine("  The ordinary cases");

        Ok("adding a domain nobody has claimed is allowed",
            Api.Modules.Core.DomainClaims.RefusalToAdd([], School, 0) is null);

        Ok("the same organisation adding it twice is told, not duplicated",
            Api.Modules.Core.DomainClaims.RefusalToAdd([Claim(School)], School, 1)
                is { } again && again.Contains("already added"));

        Ok("a claim this organisation lost does not block it trying again",
            Api.Modules.Core.DomainClaims.RefusalToAdd([Claim(School, superseded: true)], School, 0) is null);

        Console.WriteLine();
        Console.WriteLine("  The rate limit (a school adding 500 domains is not a school)");

        Ok($"at the cap ({Api.Modules.Core.DomainClaims.MaxPendingPerTenant}) the next addition is refused",
            Api.Modules.Core.DomainClaims.RefusalToAdd([], School, Api.Modules.Core.DomainClaims.MaxPendingPerTenant)
                is { } capped && capped.Contains("waiting to be verified"));

        Ok("one below the cap is still allowed",
            Api.Modules.Core.DomainClaims.RefusalToAdd([], School,
                Api.Modules.Core.DomainClaims.MaxPendingPerTenant - 1) is null);

        Console.WriteLine();
        Console.WriteLine("  Sweeping abandoned claims");

        var old = Claim(Squatter, ageDays: 31);
        var fresh = Claim(Squatter, ageDays: 29);
        var oldVerified = Claim(School, verified: true, ageDays: 400);
        var oldSuperseded = Claim(Squatter, superseded: true, ageDays: 400);

        var expired = Api.Modules.Core.DomainClaims.Expired([old, fresh, oldVerified, oldSuperseded], Now);
        Ok("a pending claim older than thirty days is swept", expired.Contains(old.Id));
        Ok("a claim of twenty-nine days is left alone", !expired.Contains(fresh.Id));
        Ok("a VERIFIED domain is never swept, however old", !expired.Contains(oldVerified.Id));
        Ok("a superseded row is never swept — it is why that claim ended",
            !expired.Contains(oldSuperseded.Id));
        Ok("exactly one of those four is swept", expired.Count == 1);

        Console.WriteLine();
        Console.WriteLine("  =============");
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed}");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;
    }
}

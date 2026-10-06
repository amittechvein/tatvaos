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
/// ── WHY IT IS LAID OUT LIKE THIS ─────────────────────────────────────────
///
///  Mr. Singh, 25 September: "Show each one with its permitted counterpart in
///  the same run." So the output is four blocks, one per condition, and each
///  block prints the case that is REFUSED next to the case that is ALLOWED.
///  A rule tested only in the refusing direction is half a rule: it cannot
///  tell you whether it refuses everything.
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

    /// <summary>The refused half of a pair.</summary>
    private static void Refused(string what, bool ok) => Ok("REFUSED   " + what, ok);

    /// <summary>The permitted half. Without it the refusal proves nothing.</summary>
    private static void Allowed(string what, bool ok) => Ok("PERMITTED " + what, ok);

    private static void Condition(string n, string title)
    {
        Console.WriteLine();
        Console.WriteLine($"  {n}. {title}");
    }

    private static readonly Guid School = Guid.NewGuid();
    private static readonly Guid Squatter = Guid.NewGuid();
    private static readonly Guid Third = Guid.NewGuid();
    private static readonly DateTimeOffset Now = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);

    private static Api.Modules.Core.DomainClaims.Claim Claim(
        Guid tenant, bool verified = false, bool superseded = false, int ageDays = 0, Guid? id = null) =>
        new(id ?? Guid.NewGuid(), tenant, verified, superseded, Now.AddDays(-ageDays));

    private static Api.Modules.Core.DomainClaims.Refusal? Refusal(
        IReadOnlyCollection<Api.Modules.Core.DomainClaims.Claim> claims, Guid tenant, int pending = 0) =>
        Api.Modules.Core.DomainClaims.RefusalToAdd(claims, tenant, pending);

    /// <summary>
    /// The repository root, found by walking up from the test binary. Used by
    /// the one structural check below; returns null rather than throwing if
    /// the layout ever changes, and that check then fails loudly.
    /// </summary>
    private static string? RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "apps", "api"))) return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private static int Main()
    {
        Console.WriteLine();
        Console.WriteLine("  Domain claims — Mr. Singh's four conditions, each with its counterpart");
        Console.WriteLine("  ====================================================================");

        // ── THE CASE THE WHOLE CHANGE EXISTS FOR ─────────────────────────
        Condition("0", "The squatting case: a claim is not a lock");

        var squatterClaim = Claim(Squatter);
        Allowed("a pending claim does not stop the real owner adding the domain",
            Refusal([squatterClaim], School) is null);

        Allowed("a hundred pending claims still do not stop them",
            Refusal(Enumerable.Range(0, 100).Select(_ => Claim(Squatter)).ToList(), School) is null);

        var schoolWins = Claim(School, verified: true);
        Refused("once VERIFIED, nobody else may claim it",
            Refusal([schoolWins], Third) is not null);

        Allowed("and a claim the asker themselves lost does not block them trying again",
            Refusal([Claim(School, superseded: true)], School) is null);

        // ── CONDITION 1 ──────────────────────────────────────────────────
        Condition("1", "Closing a losing claim destroys nothing");

        Refused("the losing claim is the one closed",
            Api.Modules.Core.DomainClaims.LosersOf([schoolWins, squatterClaim], schoolWins.Id)
                is [var only] && only == squatterClaim.Id);

        Allowed("the winner's own row is left alone — it never supersedes itself",
            !Api.Modules.Core.DomainClaims.LosersOf([schoolWins, squatterClaim], schoolWins.Id)
                .Contains(schoolWins.Id));

        Allowed("an already-closed claim keeps its original closing time, not a later one",
            Api.Modules.Core.DomainClaims.LosersOf(
                [schoolWins, Claim(Squatter, superseded: true)], schoolWins.Id).Count == 0);

        // The belief this condition rests on, checked rather than asserted:
        // closing a claim is safe because NOTHING can be attached to an
        // unverified domain. That guard lives in the endpoints, which need a
        // database and a tenant to run, so this check is structural — it reads
        // the source. It is worth having anyway: if someone relaxes either
        // guard, the reason it is safe to close a claim has gone, and this is
        // the thing that will say so.
        var root = RepoRoot();
        Ok("(structural) the repository root was found", root is not null);
        if (root is not null)
        {
            var guards = new[]
            {
                Path.Combine(root, "apps", "api", "Modules", "Admin", "Endpoints", "UserEndpoints.cs"),
                Path.Combine(root, "apps", "api", "Modules", "Admin", "Endpoints", "SharedMailboxEndpoints.cs"),
            };
            foreach (var g in guards)
            {
                var text = File.Exists(g) ? File.ReadAllText(g) : "";
                Allowed($"nothing attaches to an unverified domain — {Path.GetFileName(g)} still checks OwnershipVerifiedAt",
                    text.Contains("OwnershipVerifiedAt"));
            }
        }

        // ── CONDITION 2 ──────────────────────────────────────────────────
        Condition("2", "The notice says why, and never who");

        var notice = Api.Modules.Core.DomainClaims.SupersededNotice;
        var blocked = Refusal([schoolWins], Third);

        Refused("the notice names no organisation",
            !notice.Contains(School.ToString()) && !notice.Contains(Squatter.ToString())
            && !notice.Contains("techvein", StringComparison.OrdinalIgnoreCase));

        Refused("nor does the refusal the next claimant sees",
            blocked is { } b1 && !b1.Message.Contains(School.ToString())
            && !b1.Message.Contains("techvein", StringComparison.OrdinalIgnoreCase));

        Allowed("but the notice still says enough to act on: why, and where to go",
            notice.Contains("verified by its owner") && notice.Contains("contact support"));

        Allowed("and so does the refusal",
            blocked is { } b2 && b2.Message.Contains("contact support"));

        // ── CONDITION 3 ──────────────────────────────────────────────────
        Condition("3", "Pending claims expire after thirty days");

        var old = Claim(Squatter, ageDays: 31);
        var fresh = Claim(Squatter, ageDays: 29);
        var oldVerified = Claim(School, verified: true, ageDays: 400);
        var oldSuperseded = Claim(Squatter, superseded: true, ageDays: 400);

        var expired = Api.Modules.Core.DomainClaims.Expired([old, fresh, oldVerified, oldSuperseded], Now);

        Refused("a pending claim of thirty-one days is swept", expired.Contains(old.Id));
        Allowed("one of twenty-nine days is left standing", !expired.Contains(fresh.Id));
        Allowed("a VERIFIED domain is never swept, at four hundred days old",
            !expired.Contains(oldVerified.Id));
        Allowed("a superseded row is never swept — it is the record of why that claim ended",
            !expired.Contains(oldSuperseded.Id));
        Ok("exactly one of those four is swept", expired.Count == 1);

        // ── CONDITION 4 ──────────────────────────────────────────────────
        Condition("4", "The rate limit, and a refusal a log reader can tell apart");

        var cap = Api.Modules.Core.DomainClaims.MaxPendingPerTenant;

        Refused($"at the cap ({cap}) the next addition is refused",
            Refusal([], School, cap) is { } capped
            && capped.Code == Api.Modules.Core.DomainClaims.RefusedTooManyPending);

        Allowed($"one below the cap ({cap - 1}) is allowed",
            Refusal([], School, cap - 1) is null);

        Allowed("and being at the cap never blocks the OWNER of a name from being refused for the right reason",
            Refusal([schoolWins], Third, cap) is { } both
            && both.Code == Api.Modules.Core.DomainClaims.RefusedAlreadyVerified);

        // The reason codes are the point: without them the log line for "you
        // have too many pending" and the log line for "this is somebody
        // else's verified domain" are the same sentence, and only the second
        // is a squatter hitting a wall.
        var codes = new[]
        {
            Refusal([schoolWins], Third)?.Code,
            Refusal([Claim(School)], School, 1)?.Code,
            Refusal([], School, cap)?.Code,
        };
        Ok("the three refusals carry three different reason codes",
            codes.All(c => c is not null) && codes.Distinct().Count() == 3);

        Ok("and each code is the one the log claims it is",
            codes[0] == Api.Modules.Core.DomainClaims.RefusedAlreadyVerified
            && codes[1] == Api.Modules.Core.DomainClaims.RefusedAlreadyYours
            && codes[2] == Api.Modules.Core.DomainClaims.RefusedTooManyPending);

        Allowed("adding a domain nobody has claimed is allowed and logs nothing",
            Refusal([], School) is null);

        Refused("the same organisation adding it twice is told, not duplicated",
            Refusal([Claim(School)], School, 1) is { } again && again.Message.Contains("already added"));

        Console.WriteLine();
        Console.WriteLine("  ====================================================================");
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed}");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;
    }
}

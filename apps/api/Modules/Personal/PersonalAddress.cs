using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Mail;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// The rules for a personal address, name@house-domain (build plan §3.1-3.2).
///
/// Stricter than an organisation's IsValidLocalPart (UserEndpoints), on
/// purpose: an admin naming their own staff "a@" is their business; a
/// stranger taking "a@tatvaos.com" is a scarce name gone, and short names are
/// what squatters and impersonators want. 4 to 30 characters; lowercase
/// letters, digits, dots and hyphens; starts with a letter; ends with a
/// letter or digit (a trailing dot is not a valid address); no ".." or
/// "--" runs.
/// </summary>
public static partial class PersonalAddress
{
    public const int MinLength = 4;
    public const int MaxLength = 30;

    [GeneratedRegex(@"^[a-z][a-z0-9.-]*[a-z0-9]$")]
    private static partial Regex Shape();

    /// <summary>Null when valid, else the sentence to show.</summary>
    public static string? RuleProblem(string localPart)
    {
        if (localPart.Length < MinLength) return $"Use at least {MinLength} characters.";
        if (localPart.Length > MaxLength) return $"Use at most {MaxLength} characters.";
        if (!char.IsAsciiLetterLower(localPart[0])) return "Start with a letter.";
        if (!Shape().IsMatch(localPart))
            return "Use lowercase letters, numbers, dots and hyphens, ending with a letter or number.";
        if (localPart.Contains("..") || localPart.Contains("--") ||
            localPart.Contains(".-") || localPart.Contains("-."))
            return "Dots and hyphens can't sit next to each other.";
        return null;
    }

    public static string Normalise(string? raw) => (raw ?? "").Trim().ToLowerInvariant();

    /// <summary>
    /// Reserved, in the live list: an exact name, or anything CONTAINING a
    /// "contains" entry. Also compared with dots and hyphens stripped, so
    /// "t.a.t.v.a" and "s-b-i" are caught — separators are free to add and
    /// read as nothing.
    /// </summary>
    public static async Task<bool> IsReservedAsync(AppDbContext db, string localPart, CancellationToken ct)
    {
        var bare = localPart.Replace(".", "").Replace("-", "");
        var live = await db.ReservedUsernames.AsNoTracking()
            .Where(r => r.RemovedAt == null)
            .Select(r => new { r.Name, r.Match })
            .ToListAsync(ct);
        foreach (var r in live)
        {
            var name = r.Name.ToLowerInvariant();
            if (r.Match == "contains")
            {
                if (localPart.Contains(name) || bare.Contains(name)) return true;
            }
            else if (localPart == name || bare == name.Replace(".", "").Replace("-", ""))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Taken by anything that shares the address namespace: a sign-in, a
    /// mailbox, an alias — platform-wide, like CreatePersonAsync — or an
    /// address somebody used before (core.retired_addresses), until an
    /// operator releases it.
    /// </summary>
    public static async Task<bool> IsTakenAsync(AppDbContext db, string address, CancellationToken ct)
    {
        if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == address, ct) ||
            await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct) ||
            await db.Aliases.IgnoreQueryFilters().AnyAsync(a => a.Address == address, ct))
            return true;

        // Retired (Mr. Singh, 26 Sept 2026): held — organisation or personal,
        // whatever the date says — until an operator releases it, which needs
        // a reason and the mail server's count of zero files. The mail importer
        // matches maildir files by ADDRESS, so a new owner of an address with
        // the old files still there would be handed the previous owner's mail.
        // The leftover check stays as a second reason, in case a row is ever
        // released by hand in the database.
        return await RetiredAddresses.IsHeldAsync(db, address, ct)
            || await db.PurgeLeftovers.AnyAsync(l => l.Kind == "maildir" && l.Address == address, ct);
    }

    /// <summary>Null if the address can be had, else "unavailable" or a rule sentence.</summary>
    public static async Task<string?> ProblemAsync(
        AppDbContext db, string localPart, string domain, CancellationToken ct)
    {
        if (RuleProblem(localPart) is string rule) return rule;
        // Same sentence for reserved and taken (§3.2): saying "reserved"
        // tells an impersonator which names we are protecting.
        if (await IsReservedAsync(db, localPart, ct)) return Unavailable;
        if (await IsTakenAsync(db, $"{localPart}@{domain}", ct)) return Unavailable;
        return null;
    }

    public const string Unavailable = "That address isn't available.";

    /// <summary>
    /// Two or three free alternatives. Built from the wanted name, so they
    /// are only offered for a name that passed the rules; each is checked
    /// like any other, so a suggestion is never itself reserved or taken.
    /// </summary>
    public static async Task<List<string>> SuggestAsync(
        AppDbContext db, string localPart, string domain, CancellationToken ct)
    {
        var stem = localPart.Length > MaxLength - 4 ? localPart[..(MaxLength - 4)] : localPart;
        stem = stem.TrimEnd('.', '-');
        var year = DateTime.UtcNow.Year % 100;
        var candidates = new List<string>
        {
            $"{stem}.{Random.Shared.Next(10, 100)}",
            $"{stem}{year}",
            $"{stem}-{Random.Shared.Next(100, 1000)}",
            $"{stem}{Random.Shared.Next(1000, 10000)}",
        };
        // Suggestions are held to a STRICTER rule than typed names: none may
        // contain ANY reserved name, even an "exact" one. Found in the browser
        // on 26 Sept: typing "admin" offered admin26@ and admin.14@, which
        // pass the rules (admin is reserved exactly) but are exactly the
        // look-official names nobody should be handed by us. A person may
        // still type such a name; we just never propose one.
        // Four letters and up only: "rbi" sits inside the ordinary name
        // Harbir, and "gov" inside Govind — a three-letter entry here would
        // quietly withhold suggestions from real people.
        var bareStem = stem.Replace(".", "").Replace("-", "");
        var reservedInside = await db.ReservedUsernames.AsNoTracking()
            .Where(r => r.RemovedAt == null && r.Name.Length >= 4)
            .Select(r => r.Name)
            .ToListAsync(ct);
        if (reservedInside.Any(r => bareStem.Contains(r.ToLowerInvariant().Replace(".", "").Replace("-", ""))))
            return [];

        var free = new List<string>();
        foreach (var c in candidates.Distinct())
        {
            if (free.Count == 3) break;
            if (await ProblemAsync(db, c, domain, ct) is null) free.Add(c);
        }
        return free;
    }
}

namespace TatvaOS.Api.Modules.Family;

// ============================================================================
//  The shape that sits between a file and the database.
//
//  CSV and vCard both parse INTO this and both render FROM it, so the rules
//  that matter — how a label becomes a type, how long a field may be, what
//  counts as a name — are written once and cannot drift between the two
//  formats. Adding a third format later means one parser and one writer, not
//  another copy of the import engine.
// ============================================================================

/// <summary>One address or number, with the label it arrived under.</summary>
public sealed class LabelledValue
{
    public required string Value { get; init; }
    public string Type { get; init; } = "other";
}

public sealed class PostalRecord
{
    public string Type { get; set; } = "work";
    public string? Street1 { get; set; }
    public string? Street2 { get; set; }
    public string? City { get; set; }
    public string? Region { get; set; }
    public string? Postcode { get; set; }
    public string? Country { get; set; }

    public bool IsEmpty =>
        string.IsNullOrWhiteSpace(Street1) && string.IsNullOrWhiteSpace(Street2) &&
        string.IsNullOrWhiteSpace(City) && string.IsNullOrWhiteSpace(Region) &&
        string.IsNullOrWhiteSpace(Postcode) && string.IsNullOrWhiteSpace(Country);
}

/// <summary>
/// One person, as a file describes them. Deliberately dumb: no validation, no
/// database types, nothing that assumes the row will survive. The import engine
/// decides what is usable.
/// </summary>
public sealed class ContactRecord
{
    /// <summary>1-based line in the source file, for the report.</summary>
    public int Row { get; set; }

    public string? DisplayName { get; set; }
    public string? FirstName { get; set; }
    public string? MiddleName { get; set; }
    public string? LastName { get; set; }
    public string? Nickname { get; set; }
    public string? JobTitle { get; set; }
    public string? CompanyName { get; set; }
    public string? Notes { get; set; }
    public bool IsFavourite { get; set; }

    /// <summary>
    /// Ours alone: "Mine" or "Shared". Written on export so somebody auditing
    /// what their organisation can see does not have to open four hundred
    /// contacts to find out. Ignored on the way back in — ownership is decided
    /// by the import options, not by a column anyone can edit.
    /// </summary>
    public string? Visibility { get; set; }

    public List<LabelledValue> Emails { get; } = [];
    public List<LabelledValue> Phones { get; } = [];
    public List<PostalRecord> Addresses { get; } = [];
    public List<string> Labels { get; } = [];

    /// <summary>
    /// Parsed but not yet stored. family.contact_dates exists in SQL and has no
    /// entity behind it, so a birthday in the file is counted and reported
    /// rather than written — losing 400 birthdays silently, and only finding
    /// out next March, is the failure worth avoiding here.
    /// </summary>
    public string? Birthday { get; set; }

    /// <summary>
    /// The name to file this person under.
    ///
    /// Order matters. A file that carries both a full name and its parts
    /// usually disagrees with itself on spacing, and the full name is the one a
    /// human typed. Falling back through the company and then the address means
    /// a row with nothing but accounts@supplier.com still lands somewhere
    /// findable instead of being thrown away.
    /// </summary>
    public string? ResolveName()
    {
        if (!string.IsNullOrWhiteSpace(DisplayName)) return DisplayName.Trim();

        var parts = new[] { FirstName, MiddleName, LastName }
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p!.Trim());
        var joined = string.Join(' ', parts);
        if (joined.Length > 0) return joined;

        if (!string.IsNullOrWhiteSpace(CompanyName)) return CompanyName.Trim();

        var email = Emails.FirstOrDefault()?.Value;
        if (!string.IsNullOrWhiteSpace(email))
            return ContactMatching.DisplayNameFromEmail(null, email);

        return null;
    }
}

/// <summary>
/// Labels in the wild versus the four words the database will accept.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS IS WHERE AN IMPORT SILENTLY FAILS IF YOU GET IT WRONG.
///
///  Every type column carries a CHECK constraint, and the sets are NOT the
///  same across the three tables:
///
///    emails     work | personal | other          (no "home")
///    phones     mobile | work | home | other
///    addresses  work | home | other              (no "mobile")
///
///  Google exports "* Home" for an email address. Passing that through, or
///  even helpfully lowercasing it to "home", violates the email CHECK and
///  takes the whole transaction down — so a home email becomes "personal"
///  here, once, rather than in three call sites.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Anything unrecognised falls back rather than failing the row: "other" for a
/// number or a postal address, and "work" for an email, which is what the
/// create endpoint already assumes for an unlabelled one. A custom
/// Google label like "Farmhouse" is not worth failing a row over; the number
/// is still the number.
/// </summary>
public static class ContactTypes
{
    /// <summary>Strips Google's "* " prefix, vCard's quoting, and the case.</summary>
    private static string Clean(string? raw)
    {
        var s = (raw ?? string.Empty).Trim().Trim('"').Trim();
        if (s.StartsWith("* ", StringComparison.Ordinal)) s = s[2..];
        return s.Trim().ToLowerInvariant();
    }

    public static string Email(string? raw) => Clean(raw) switch
    {
        "work" or "business" or "office" or "company" => "work",
        "home" or "personal" or "private" or "internet home" => "personal",
        _ => "work",   // an address with no useful label is far more often a work one
    };

    public static string Phone(string? raw)
    {
        var s = Clean(raw);
        if (s.Contains("cell") || s.Contains("mobile") || s.Contains("iphone")) return "mobile";
        if (s.Contains("work") || s.Contains("business") || s.Contains("office")) return "work";
        if (s.Contains("home")) return "home";
        return "other";
    }

    public static string Address(string? raw)
    {
        var s = Clean(raw);
        if (s.Contains("work") || s.Contains("business") || s.Contains("office")) return "work";
        if (s.Contains("home") || s.Contains("residence")) return "home";
        return "other";
    }

    /// <summary>Our type back out to the label a Google or Apple import expects.</summary>
    public static string ToVCardEmail(string type) => type switch
    {
        "personal" => "HOME",
        "work" => "WORK",
        _ => "OTHER",
    };

    public static string ToVCardPhone(string type) => type switch
    {
        "mobile" => "CELL",
        "work" => "WORK",
        "home" => "HOME",
        _ => "VOICE",
    };

    public static string ToVCardAddress(string type) => type switch
    {
        "home" => "HOME",
        "work" => "WORK",
        _ => "OTHER",
    };
}

/// <summary>
/// Trimming to what the column will hold.
///
/// Every text column in family.contacts has a MaxLength, and EF enforces it
/// before PostgreSQL gets the chance. One 500-character company name in row
/// 3,000 of an import would otherwise abort the entire transaction — so values
/// are cut to fit and the row survives. A company name longer than 300
/// characters is already wrong in the source file; the address is the part
/// worth keeping.
/// </summary>
public static class Fit
{
    public static string? Cap(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var s = value.Trim();
        return s.Length <= max ? s : s[..max];
    }
}

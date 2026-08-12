using System.Text;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Family;

/// <summary>
/// What the columns of a contacts CSV mean.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE ONLY HARD PART OF IMPORTING IS THE HEADER ROW.
///
///  Nobody hands you a file in your own format. They hand you whatever Google
///  Contacts, Outlook, Apple, a phone backup app or a colleague's spreadsheet
///  produced, and those disagree about nearly every column name:
///
///    Google (2019)   Given Name    Family Name   E-mail 1 - Value
///    Google (now)    First Name    Last Name     E-mail 1 - Value
///    Outlook         First Name    Last Name     E-mail Address
///    Apple           First Name    Last Name     Email 1 - Value
///
///  An importer that only reads its own export is an export feature wearing an
///  import feature's label. So the header is matched against a table of
///  aliases and a handful of patterns, and anything unrecognised is ignored
///  rather than fatal.
/// ─────────────────────────────────────────────────────────────────────────
///
/// One thing that is NOT guessed here: the delimiter. Csv.DetectDelimiter
/// works it out, because Excel writes the locale's list separator and half of
/// Europe gets semicolons.
/// </summary>
public static partial class ContactCsvFormat
{
    /// <summary>U+FEFF. Named, because it is invisible in every editor.</summary>
    private const char ByteOrderMark = '\uFEFF';

    // ======================================================================
    //  Writing
    // ======================================================================

    /// <summary>
    /// Every contact, in a shape Google Contacts will re-import.
    ///
    /// The email, phone and address blocks repeat as many times as the busiest
    /// contact needs, which is how Google's own format fits a variable number
    /// of values into a fixed grid. There is no cap: an export exists so
    /// somebody can leave with everything, and quietly dropping a fourth
    /// address would defeat the point of having the feature at all.
    /// </summary>
    public static string Write(IReadOnlyList<ContactRecord> records)
    {
        var maxEmails = Slots(records, r => r.Emails.Count);
        var maxPhones = Slots(records, r => r.Phones.Count);
        var maxAddresses = Slots(records, r => r.Addresses.Count);

        var sb = new StringBuilder();

        // Excel on Windows assumes the system codepage unless the file opens
        // with a byte-order mark, which turns every non-ASCII name into
        // mojibake the moment it is double-clicked — and double-clicking is
        // how most people open a CSV.
        sb.Append(ByteOrderMark);

        var header = new List<string>
        {
            "Name", "First Name", "Middle Name", "Last Name", "Nickname",
            "Organization Name", "Organization Title", "Notes", "Labels",
            "Starred", "Visibility",
        };

        for (var i = 1; i <= maxEmails; i++)
        {
            header.Add($"E-mail {i} - Label");
            header.Add($"E-mail {i} - Value");
        }
        for (var i = 1; i <= maxPhones; i++)
        {
            header.Add($"Phone {i} - Label");
            header.Add($"Phone {i} - Value");
        }
        for (var i = 1; i <= maxAddresses; i++)
        {
            header.Add($"Address {i} - Label");
            header.Add($"Address {i} - Street");
            header.Add($"Address {i} - City");
            header.Add($"Address {i} - Region");
            header.Add($"Address {i} - Postal Code");
            header.Add($"Address {i} - Country");
        }

        Csv.AppendRow(sb, header.Select(h => Csv.Cell(h)));

        foreach (var r in records)
        {
            var cells = new List<string>
            {
                Csv.Cell(r.ResolveName()),
                Csv.Cell(r.FirstName),
                Csv.Cell(r.MiddleName),
                Csv.Cell(r.LastName),
                Csv.Cell(r.Nickname),
                Csv.Cell(r.CompanyName),
                Csv.Cell(r.JobTitle),
                Csv.Cell(r.Notes),
                Csv.Cell(string.Join(" ::: ", r.Labels)),
                Csv.Cell(r.IsFavourite ? "True" : ""),
                Csv.Cell(r.Visibility),
            };

            for (var i = 0; i < maxEmails; i++)
            {
                var e = i < r.Emails.Count ? r.Emails[i] : null;
                cells.Add(Csv.Cell(e is null ? "" : LabelOf(e.Type)));
                // Addresses and numbers skip the formula guard: neither can
                // start a formula, and "+91 98765 43210" has to survive intact.
                cells.Add(Csv.Cell(e?.Value, guardFormulas: false));
            }

            for (var i = 0; i < maxPhones; i++)
            {
                var p = i < r.Phones.Count ? r.Phones[i] : null;
                cells.Add(Csv.Cell(p is null ? "" : LabelOf(p.Type)));
                cells.Add(Csv.Cell(p?.Value, guardFormulas: false));
            }

            for (var i = 0; i < maxAddresses; i++)
            {
                var a = i < r.Addresses.Count ? r.Addresses[i] : null;
                cells.Add(Csv.Cell(a is null ? "" : LabelOf(a.Type)));
                cells.Add(Csv.Cell(Join(a?.Street1, a?.Street2)));
                cells.Add(Csv.Cell(a?.City));
                cells.Add(Csv.Cell(a?.Region));
                cells.Add(Csv.Cell(a?.Postcode));
                cells.Add(Csv.Cell(a?.Country));
            }

            Csv.AppendRow(sb, cells);
        }

        return sb.ToString();
    }

    /// <summary>Always at least one slot, so the header shape never varies.</summary>
    private static int Slots(IReadOnlyList<ContactRecord> records, Func<ContactRecord, int> count)
    {
        var most = 0;
        foreach (var r in records) most = Math.Max(most, count(r));
        return Math.Max(1, most);
    }

    private static string Join(string? a, string? b) =>
        string.Join(", ", new[] { a, b }
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s!.Trim()));

    /// <summary>Our type words, in the spelling Google and Apple write.</summary>
    private static string LabelOf(string type) => type switch
    {
        "personal" or "home" => "* Home",
        "work" => "* Work",
        "mobile" => "* Mobile",
        _ => "* Other",
    };

    // ======================================================================
    //  Reading
    // ======================================================================

    public static List<ContactRecord> Parse(string text)
    {
        var records = new List<ContactRecord>();

        var delimiter = Csv.DetectDelimiter(text);
        var rows = Csv.Parse(text, delimiter);
        if (rows.Count == 0) return records;

        var layout = Map(rows[0]);
        if (!layout.IsUsable) return records;

        for (var i = 1; i < rows.Count; i++)
        {
            var row = rows[i];
            if (Csv.IsBlank(row)) continue;

            var record = ReadRow(row, layout);
            record.Row = i + 1;              // 1-based, counting the header
            records.Add(record);
        }

        return records;
    }

    /// <summary>
    /// True when the header row parses as a contacts file at all. Used by the
    /// endpoint to explain WHY nothing imported, which is otherwise the most
    /// baffling possible outcome.
    /// </summary>
    public static bool LooksLikeContacts(string text) =>
        Csv.Parse(text, Csv.DetectDelimiter(text)) is { Count: > 0 } rows &&
        Map(rows[0]).IsUsable;

    private static ContactRecord ReadRow(string[] row, Layout layout)
    {
        string Get(int? index) =>
            index is int i && i >= 0 && i < row.Length
                ? Csv.Unguard(row[i]).Trim()
                : string.Empty;

        var r = new ContactRecord
        {
            DisplayName = Blank(Get(layout.Display)),
            FirstName = Blank(Get(layout.First)),
            MiddleName = Blank(Get(layout.Middle)),
            LastName = Blank(Get(layout.Last)),
            Nickname = Blank(Get(layout.Nickname)),
            CompanyName = Blank(Get(layout.Company)),
            JobTitle = Blank(Get(layout.JobTitle)),
            Notes = Blank(Get(layout.Notes)),
            Birthday = Blank(Get(layout.Birthday)),
        };

        var starred = Get(layout.Starred);
        r.IsFavourite = starred.Equals("true", StringComparison.OrdinalIgnoreCase)
                     || starred == "1"
                     || starred.Equals("yes", StringComparison.OrdinalIgnoreCase);

        foreach (var slot in layout.Emails)
        {
            var label = Pick(Get(slot.Label), slot.ImpliedLabel);
            foreach (var value in SplitValues(Get(slot.Value)))
            {
                if (!LooksLikeEmail(value)) continue;
                if (r.Emails.Any(e => e.Value.Equals(value, StringComparison.OrdinalIgnoreCase))) continue;
                r.Emails.Add(new LabelledValue { Value = value, Type = ContactTypes.Email(label) });
            }
        }

        foreach (var slot in layout.Phones)
        {
            var label = Pick(Get(slot.Label), slot.ImpliedLabel);
            foreach (var value in SplitValues(Get(slot.Value)))
            {
                // No digits at all means it is not a number — "N/A" and "-"
                // turn up in exported spreadsheets more often than you would
                // like, and storing them makes the field useless for matching.
                if (ContactMatching.NormalisePhone(value).Length == 0) continue;
                if (r.Phones.Any(p => p.Value == value)) continue;
                r.Phones.Add(new LabelledValue { Value = value, Type = ContactTypes.Phone(label) });
            }
        }

        foreach (var slot in layout.Addresses)
        {
            var street = Get(slot.Street);
            // Google writes a ready-made multi-line address when it has no
            // structured one. Better in the street line than discarded.
            if (street.Length == 0) street = Get(slot.Formatted).Replace('\n', ' ').Trim();

            var postal = new PostalRecord
            {
                Type = ContactTypes.Address(Pick(Get(slot.Label), slot.ImpliedLabel)),
                Street1 = Blank(street),
                Street2 = Blank(Get(slot.Extended)),
                City = Blank(Get(slot.City)),
                Region = Blank(Get(slot.Region)),
                Postcode = Blank(Get(slot.Postcode)),
                Country = Blank(Get(slot.Country)),
            };
            if (!postal.IsEmpty) r.Addresses.Add(postal);
        }

        foreach (var index in layout.Labels)
        {
            foreach (var raw in SplitLabels(Get(index)))
            {
                var label = raw.Trim();
                if (label.Length == 0) continue;

                // Google's own bookkeeping, not anything a person made.
                if (label.Equals("* myContacts", StringComparison.OrdinalIgnoreCase) ||
                    label.Equals("myContacts", StringComparison.OrdinalIgnoreCase)) continue;

                if (label.Equals("* starred", StringComparison.OrdinalIgnoreCase))
                {
                    r.IsFavourite = true;
                    continue;
                }

                if (!r.Labels.Contains(label, StringComparer.OrdinalIgnoreCase)) r.Labels.Add(label);
            }
        }

        return r;
    }

    private static string Pick(string explicitLabel, string implied) =>
        explicitLabel.Length > 0 ? explicitLabel : implied;

    private static string? Blank(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>
    /// Google packs several values into one cell separated by " ::: ". Nothing
    /// else does, and a bare split on comma or semicolon would tear apart
    /// numbers and labels that legitimately contain them.
    /// </summary>
    private static IEnumerable<string> SplitValues(string cell)
    {
        if (cell.Length == 0) return [];
        return cell.Split(":::", StringSplitOptions.RemoveEmptyEntries)
                   .Select(s => s.Trim())
                   .Where(s => s.Length > 0);
    }

    private static IEnumerable<string> SplitLabels(string cell)
    {
        if (cell.Length == 0) return [];
        if (cell.Contains(":::")) return cell.Split(":::");
        if (cell.Contains(';')) return cell.Split(';');
        return [cell];      // a label may legitimately contain a comma
    }

    /// <summary>
    /// Enough of a check to keep junk out of the address column, and no more.
    /// Validating email addresses properly is a famous waste of an afternoon;
    /// what matters here is that "N/A", "-" and a phone number do not become
    /// somebody's primary address.
    /// </summary>
    private static bool LooksLikeEmail(string value)
    {
        if (value.Length is 0 or > 320) return false;
        if (value.Any(char.IsWhiteSpace)) return false;

        var at = value.LastIndexOf('@');
        if (at <= 0 || at == value.Length - 1) return false;

        var domain = value[(at + 1)..];
        return domain.Contains('.') && !domain.StartsWith('.') && !domain.EndsWith('.');
    }

    // ======================================================================
    //  The header
    // ======================================================================

    /// <summary>One repeated block of columns — an email or a phone number.</summary>
    private sealed class ValueSlot
    {
        public int Index { get; init; }
        public int? Value { get; set; }
        public int? Label { get; set; }

        /// <summary>
        /// For Outlook, where the label is baked into the column name:
        /// "Mobile Phone" has no separate type column, it IS the type.
        /// </summary>
        public string ImpliedLabel { get; set; } = "";
    }

    private sealed class AddressSlot
    {
        public int Index { get; init; }
        public string ImpliedLabel { get; set; } = "";
        public int? Label { get; set; }
        public int? Street { get; set; }
        public int? Extended { get; set; }
        public int? Formatted { get; set; }
        public int? City { get; set; }
        public int? Region { get; set; }
        public int? Postcode { get; set; }
        public int? Country { get; set; }

        public bool HasAnything =>
            Street is not null || Formatted is not null || City is not null ||
            Region is not null || Postcode is not null || Country is not null ||
            Extended is not null;
    }

    private sealed class Layout
    {
        public int? Display, First, Middle, Last, Nickname, Company, JobTitle,
                    Notes, Starred, Birthday;

        public List<int> Labels { get; } = [];
        public List<ValueSlot> Emails { get; } = [];
        public List<ValueSlot> Phones { get; } = [];
        public List<AddressSlot> Addresses { get; } = [];

        /// <summary>
        /// A file with no name column and no address column is not a contacts
        /// file, and importing it would produce four hundred contacts called
        /// "Unnamed". Better to refuse and say so than to make a mess somebody
        /// has to undo one row at a time.
        /// </summary>
        public bool IsUsable =>
            Display is not null || First is not null || Last is not null ||
            Company is not null || Emails.Count > 0;
    }

    [GeneratedRegex(@"^e-?mail\s*(\d*)\s*-\s*(value|address)$", RegexOptions.IgnoreCase)]
    private static partial Regex EmailValue();

    [GeneratedRegex(@"^e-?mail\s*(\d*)\s*-\s*(type|label)$", RegexOptions.IgnoreCase)]
    private static partial Regex EmailLabel();

    /// <summary>Outlook: "E-mail Address", "E-mail 2 Address", "E-mail 3 Address".</summary>
    [GeneratedRegex(@"^e-?mail\s*(\d*)\s*address$", RegexOptions.IgnoreCase)]
    private static partial Regex EmailOutlook();

    [GeneratedRegex(@"^phone\s*(\d*)\s*-\s*(value|number)$", RegexOptions.IgnoreCase)]
    private static partial Regex PhoneValue();

    [GeneratedRegex(@"^phone\s*(\d*)\s*-\s*(type|label)$", RegexOptions.IgnoreCase)]
    private static partial Regex PhoneLabel();

    /// <summary>Outlook: "Mobile Phone", "Business Phone 2", "Home Phone".</summary>
    [GeneratedRegex(@"^(.+?)\s+phone\s*(\d*)$", RegexOptions.IgnoreCase)]
    private static partial Regex PhoneOutlook();

    [GeneratedRegex(@"^address\s*(\d*)\s*-\s*(.+)$", RegexOptions.IgnoreCase)]
    private static partial Regex AddressPart();

    /// <summary>Outlook: "Home Street", "Business City", "Other Postal Code".</summary>
    [GeneratedRegex(@"^(home|business|work|other)\s+(street 2|street 3|street|city|state|province|postal code|zip|country/region|country|address)$", RegexOptions.IgnoreCase)]
    private static partial Regex AddressOutlook();

    private static Layout Map(string[] header)
    {
        var layout = new Layout();
        var emails = new Dictionary<int, ValueSlot>();
        var phones = new Dictionary<int, ValueSlot>();
        var addresses = new Dictionary<int, AddressSlot>();

        // Outlook's named phone columns have no number of their own. They are
        // keyed above any plausible "Phone 12 - Value" so the two numbering
        // schemes cannot collide, and in the order they appear in the file.
        var outlookPhoneKey = 1000;

        for (var column = 0; column < header.Length; column++)
        {
            var name = Normalise(header[column]);
            if (name.Length == 0) continue;

            switch (name)
            {
                case "name" or "display name" or "full name" or "contact name":
                    layout.Display ??= column; continue;
                case "first name" or "given name":
                    layout.First ??= column; continue;
                case "middle name" or "additional name":
                    layout.Middle ??= column; continue;
                case "last name" or "family name" or "surname":
                    layout.Last ??= column; continue;
                case "nickname":
                    layout.Nickname ??= column; continue;
                case "organization name" or "organisation name" or "organization 1 - name"
                  or "company" or "company name" or "organization" or "organisation":
                    layout.Company ??= column; continue;
                // NOT "title": in an Outlook export that column holds Mr / Ms.
                case "organization title" or "organisation title" or "organization 1 - title"
                  or "job title" or "position" or "role":
                    layout.JobTitle ??= column; continue;
                case "notes" or "note" or "comments" or "description":
                    layout.Notes ??= column; continue;
                case "labels" or "group membership" or "categories" or "tags" or "groups":
                    layout.Labels.Add(column); continue;
                case "starred" or "starred value" or "favourite" or "favorite":
                    layout.Starred ??= column; continue;
                case "birthday" or "birthday - value" or "date of birth" or "bday":
                    layout.Birthday ??= column; continue;
                case "e-mail" or "email" or "email address" or "e-mail address":
                    Slot(emails, 1).Value ??= column; continue;
                case "phone" or "telephone" or "tel" or "mobile" or "mobile number":
                    Slot(phones, 1).Value ??= column; continue;
            }

            var m = EmailValue().Match(name);
            if (m.Success) { Slot(emails, Number(m.Groups[1].Value)).Value ??= column; continue; }

            m = EmailLabel().Match(name);
            if (m.Success) { Slot(emails, Number(m.Groups[1].Value)).Label ??= column; continue; }

            m = EmailOutlook().Match(name);
            if (m.Success) { Slot(emails, Number(m.Groups[1].Value)).Value ??= column; continue; }

            m = PhoneValue().Match(name);
            if (m.Success) { Slot(phones, Number(m.Groups[1].Value)).Value ??= column; continue; }

            m = PhoneLabel().Match(name);
            if (m.Success) { Slot(phones, Number(m.Groups[1].Value)).Label ??= column; continue; }

            m = AddressPart().Match(name);
            if (m.Success)
            {
                AssignAddressPart(Address(addresses, Number(m.Groups[1].Value)),
                                  m.Groups[2].Value.Trim(), column);
                continue;
            }

            m = AddressOutlook().Match(name);
            if (m.Success)
            {
                var family = m.Groups[1].Value.ToLowerInvariant();
                var slot = Address(addresses, OutlookAddressKey(family));
                slot.ImpliedLabel = family;
                AssignAddressPart(slot, m.Groups[2].Value.Trim(), column);
                continue;
            }

            m = PhoneOutlook().Match(name);
            if (m.Success)
            {
                var slot = Slot(phones, outlookPhoneKey++);
                slot.Value ??= column;
                slot.ImpliedLabel = m.Groups[1].Value;
                continue;
            }
        }

        foreach (var slot in emails.Values.Where(s => s.Value is not null).OrderBy(s => s.Index))
            layout.Emails.Add(slot);
        foreach (var slot in phones.Values.Where(s => s.Value is not null).OrderBy(s => s.Index))
            layout.Phones.Add(slot);
        foreach (var slot in addresses.Values.Where(s => s.HasAnything).OrderBy(s => s.Index))
            layout.Addresses.Add(slot);

        return layout;
    }

    /// <summary>
    /// Fixed keys, not a hash. A hash can collide or come out negative, and an
    /// address slot that collides silently merges somebody's home and office.
    /// </summary>
    private static int OutlookAddressKey(string family) => family switch
    {
        "home" => 1001,
        "business" or "work" => 1002,
        _ => 1003,
    };

    private static void AssignAddressPart(AddressSlot slot, string part, int column)
    {
        switch (part.ToLowerInvariant())
        {
            case "street" or "street 1": slot.Street ??= column; break;
            // Outlook's "Home Address" is the whole thing run together and it
            // sits BEFORE "Home Street" in the file. Treating it as the street
            // would win the ??= race and throw away the structured columns
            // that follow, so it goes where the fallback goes.
            case "address": slot.Formatted ??= column; break;
            case "street 2" or "street 3" or "extended address": slot.Extended ??= column; break;
            case "formatted": slot.Formatted ??= column; break;
            case "city": slot.City ??= column; break;
            case "region" or "state" or "province": slot.Region ??= column; break;
            case "postal code" or "zip" or "postcode": slot.Postcode ??= column; break;
            case "country" or "country/region": slot.Country ??= column; break;
            case "type" or "label": slot.Label ??= column; break;
        }
    }

    private static ValueSlot Slot(Dictionary<int, ValueSlot> map, int index)
    {
        if (!map.TryGetValue(index, out var slot))
        {
            slot = new ValueSlot { Index = index };
            map[index] = slot;
        }
        return slot;
    }

    private static AddressSlot Address(Dictionary<int, AddressSlot> map, int index)
    {
        if (!map.TryGetValue(index, out var slot))
        {
            slot = new AddressSlot { Index = index };
            map[index] = slot;
        }
        return slot;
    }

    private static int Number(string digits) =>
        int.TryParse(digits, out var n) && n > 0 ? n : 1;

    /// <summary>
    /// Header cells as written versus header cells as compared: lowercased,
    /// underscores turned into spaces, runs of whitespace collapsed. The
    /// byte-order mark is stripped here too — it is invisible in every editor
    /// and would otherwise stop the first column matching "name".
    /// </summary>
    private static string Normalise(string header)
    {
        var s = header.Trim().Trim(ByteOrderMark).Trim().Replace('_', ' ').ToLowerInvariant();

        var sb = new StringBuilder(s.Length);
        var lastWasSpace = false;
        foreach (var ch in s)
        {
            if (char.IsWhiteSpace(ch))
            {
                if (!lastWasSpace) sb.Append(' ');
                lastWasSpace = true;
                continue;
            }
            sb.Append(ch);
            lastWasSpace = false;
        }
        return sb.ToString().Trim();
    }
}

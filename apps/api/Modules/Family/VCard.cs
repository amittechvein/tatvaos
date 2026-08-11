using System.Text;

namespace TatvaOS.Api.Modules.Family;

/// <summary>
/// vCard, both directions.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WE WRITE 3.0 AND READ 2.1, 3.0 AND 4.0.
///
///  Writing 3.0 is not conservatism for its own sake: it is the one version
///  that iOS Contacts, Android, Outlook and Google all import without
///  complaint. 4.0 is the better specification and Outlook still chokes on it.
///
///  Reading has to be broader, because what people actually have on disk is
///  whatever their old phone produced a decade ago. The 2.1 files are the
///  awkward ones — quoted-printable bodies, bare type parameters, soft line
///  breaks that are not the same thing as folding — and they are exactly the
///  files someone is trying to rescue when they reach for an importer.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Not handled, deliberately: PHOTO. There is nowhere to put it yet, and
/// carrying a megabyte of base64 through the parser to discard it is waste.
/// </summary>
public static class VCard
{
    // ======================================================================
    //  Writing
    // ======================================================================

    public static void Append(StringBuilder sb, ContactRecord c)
    {
        sb.Append("BEGIN:VCARD\r\n");
        sb.Append("VERSION:3.0\r\n");

        var display = c.ResolveName() ?? "Unnamed contact";

        // N is mandatory in 3.0 and readers use it for sorting. When the file
        // only ever knew one string, split it rather than emitting an empty N —
        // a card with no surname sorts under "unknown" in most address books.
        var last = c.LastName;
        var first = c.FirstName;
        if (string.IsNullOrWhiteSpace(last) && string.IsNullOrWhiteSpace(first))
        {
            var bits = display.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (bits.Length > 1) { first = bits[0]; last = string.Join(' ', bits[1..]); }
            else first = display;
        }

        Fold(sb, $"N:{Esc(last)};{Esc(first)};{Esc(c.MiddleName)};;");
        Fold(sb, $"FN:{Esc(display)}");

        if (!string.IsNullOrWhiteSpace(c.Nickname)) Fold(sb, $"NICKNAME:{Esc(c.Nickname)}");
        if (!string.IsNullOrWhiteSpace(c.CompanyName)) Fold(sb, $"ORG:{Esc(c.CompanyName)}");
        if (!string.IsNullOrWhiteSpace(c.JobTitle)) Fold(sb, $"TITLE:{Esc(c.JobTitle)}");

        // The first entry of each kind is the primary one — that is the order
        // the export query imposes, and PREF is how a vCard says so.
        for (var i = 0; i < c.Emails.Count; i++)
        {
            var e = c.Emails[i];
            var type = ContactTypes.ToVCardEmail(e.Type) + (i == 0 ? ",PREF" : "");
            Fold(sb, $"EMAIL;TYPE={type}:{Esc(e.Value)}");
        }

        for (var i = 0; i < c.Phones.Count; i++)
        {
            var p = c.Phones[i];
            var type = ContactTypes.ToVCardPhone(p.Type) + (i == 0 ? ",PREF" : "");
            Fold(sb, $"TEL;TYPE={type}:{Esc(p.Value)}");
        }

        foreach (var a in c.Addresses)
        {
            // pobox ; extended ; street ; locality ; region ; postcode ; country
            var street = string.Join(", ", new[] { a.Street1, a.Street2 }
                .Where(s => !string.IsNullOrWhiteSpace(s)));
            Fold(sb, $"ADR;TYPE={ContactTypes.ToVCardAddress(a.Type)}:;;" +
                     $"{Esc(street)};{Esc(a.City)};{Esc(a.Region)};{Esc(a.Postcode)};{Esc(a.Country)}");
        }

        if (c.Labels.Count > 0)
            Fold(sb, "CATEGORIES:" + string.Join(",", c.Labels.Select(Esc)));

        if (!string.IsNullOrWhiteSpace(c.Notes)) Fold(sb, $"NOTE:{Esc(c.Notes)}");

        sb.Append("END:VCARD\r\n");
    }

    /// <summary>
    /// Escape for a vCard text value. Backslash first, or every escape we add
    /// afterwards gets escaped again.
    /// </summary>
    private static string Esc(string? value) =>
        (value ?? string.Empty)
            .Replace("\\", "\\\\")
            .Replace("\r\n", "\\n")
            .Replace("\n", "\\n")
            .Replace("\r", "\\n")
            .Replace(";", "\\;")
            .Replace(",", "\\,");

    /// <summary>
    /// Break a line at 75 octets, continuation lines beginning with one space.
    ///
    /// Octets, not characters — a Devanagari or accented name is three or two
    /// bytes per letter and a naive 75-character fold produces lines that
    /// strict readers reject. A surrogate pair is never split: each half alone
    /// is not valid UTF-8, and a reader that unfolds before decoding would see
    /// a corrupt file.
    /// </summary>
    private static void Fold(StringBuilder sb, string line)
    {
        const int Max = 75;
        var chunk = new StringBuilder();
        var used = 0;
        var isFirst = true;

        for (var i = 0; i < line.Length;)
        {
            var pair = char.IsHighSurrogate(line[i])
                       && i + 1 < line.Length && char.IsLowSurrogate(line[i + 1]);
            var take = pair ? 2 : 1;
            var octets = pair ? 4 : Utf8Length(line[i]);

            // A continuation line spends one of its octets on the leading space.
            var limit = isFirst ? Max : Max - 1;
            if (used > 0 && used + octets > limit)
            {
                if (!isFirst) sb.Append(' ');
                sb.Append(chunk).Append("\r\n");
                chunk.Clear();
                used = 0;
                isFirst = false;
            }

            chunk.Append(line, i, take);
            used += octets;
            i += take;
        }

        if (!isFirst) sb.Append(' ');
        sb.Append(chunk).Append("\r\n");
    }

    private static int Utf8Length(char c) => c < 0x80 ? 1 : c < 0x800 ? 2 : 3;

    // ======================================================================
    //  Reading
    // ======================================================================

    /// <summary>
    /// Every card in the file. A malformed card is skipped rather than fatal —
    /// one bad entry in an export of four hundred should not cost the other
    /// three hundred and ninety-nine.
    /// </summary>
    public static List<ContactRecord> Parse(string text)
    {
        var records = new List<ContactRecord>();
        var lines = Unfold(text);

        ContactRecord? current = null;
        var lineNumber = 0;
        var startedAt = 0;

        foreach (var (line, sourceLine) in lines)
        {
            lineNumber = sourceLine;

            if (line.StartsWith("BEGIN:VCARD", StringComparison.OrdinalIgnoreCase))
            {
                current = new ContactRecord();
                startedAt = lineNumber;
                continue;
            }

            if (line.StartsWith("END:VCARD", StringComparison.OrdinalIgnoreCase))
            {
                if (current is not null)
                {
                    current.Row = startedAt;
                    records.Add(current);
                }
                current = null;
                continue;
            }

            if (current is null) continue;      // stray line outside a card
            ApplyLine(current, line);
        }

        // A file whose last card never closed is still worth keeping.
        if (current is not null) { current.Row = startedAt; records.Add(current); }

        return records;
    }

    /// <summary>
    /// Physical lines to logical ones, carrying the original line number for
    /// the import report.
    ///
    /// Two different continuation rules, and they are not the same mechanism:
    ///
    ///   folding      the next line begins with a space or tab (all versions)
    ///   soft break   a quoted-printable value ends with '=' (2.1 only), and
    ///                the continuation has NO leading space
    ///
    /// Handling only the first turns a wrapped quoted-printable address into
    /// two half-decoded fragments, which is the classic "why is my old Nokia
    /// export full of question marks" failure.
    /// </summary>
    private static List<(string Line, int Number)> Unfold(string text)
    {
        var result = new List<(string, int)>();
        var raw = text.Split('\n');

        for (var i = 0; i < raw.Length; i++)
        {
            var line = raw[i].TrimEnd('\r');

            if (result.Count > 0 && line.Length > 0 && (line[0] == ' ' || line[0] == '\t'))
            {
                var (prev, n) = result[^1];
                result[^1] = (prev + line[1..], n);
                continue;
            }

            if (result.Count > 0 && IsSoftBreak(result[^1].Item1))
            {
                var (prev, n) = result[^1];
                result[^1] = (prev[..^1] + line, n);
                continue;
            }

            if (line.Length == 0) continue;
            result.Add((line, i + 1));
        }

        return result;
    }

    private static bool IsSoftBreak(string line) =>
        line.EndsWith('=') &&
        line.Contains("QUOTED-PRINTABLE", StringComparison.OrdinalIgnoreCase);

    private static void ApplyLine(ContactRecord c, string line)
    {
        var colon = -1;
        var inQuotes = false;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '"') { inQuotes = !inQuotes; continue; }
            if (line[i] == ':' && !inQuotes) { colon = i; break; }
        }
        if (colon <= 0) return;

        var head = line[..colon];
        var value = line[(colon + 1)..];

        var segments = SplitOn(head, ';');
        if (segments.Length == 0) return;

        // Apple writes item1.EMAIL, item1.X-ABLabel. The group prefix is a
        // grouping device, not part of the property name.
        var name = segments[0];
        var dot = name.IndexOf('.');
        if (dot >= 0 && dot < name.Length - 1) name = name[(dot + 1)..];
        name = name.Trim().ToUpperInvariant();

        var quotedPrintable = false;
        var types = new List<string>();

        for (var i = 1; i < segments.Length; i++)
        {
            var seg = segments[i].Trim();
            if (seg.Length == 0) continue;

            var eq = seg.IndexOf('=');
            if (eq < 0)
            {
                // vCard 2.1 writes bare parameters: TEL;CELL;VOICE:…
                types.Add(seg.Trim('"'));
                continue;
            }

            var key = seg[..eq].Trim().ToUpperInvariant();
            var val = seg[(eq + 1)..].Trim().Trim('"');

            if (key == "ENCODING" && val.Contains("QUOTED-PRINTABLE", StringComparison.OrdinalIgnoreCase))
                quotedPrintable = true;
            else if (key == "TYPE")
                types.AddRange(val.Split(',', StringSplitOptions.RemoveEmptyEntries));
        }

        if (quotedPrintable) value = DecodeQuotedPrintable(value);

        var typeLabel = string.Join(' ', types.Where(t =>
            !t.Equals("PREF", StringComparison.OrdinalIgnoreCase) &&
            !t.Equals("INTERNET", StringComparison.OrdinalIgnoreCase) &&
            !t.Equals("VOICE", StringComparison.OrdinalIgnoreCase)));

        var preferred = types.Any(t => t.Equals("PREF", StringComparison.OrdinalIgnoreCase));

        switch (name)
        {
            case "FN":
                c.DisplayName = Unescape(value);
                break;

            case "N":
            {
                var n = SplitOn(value, ';');
                c.LastName ??= Blank(Unescape(At(n, 0)));
                c.FirstName ??= Blank(Unescape(At(n, 1)));
                c.MiddleName ??= Blank(Unescape(At(n, 2)));
                break;
            }

            case "NICKNAME":
                c.Nickname = Blank(Unescape(value));
                break;

            case "ORG":
            {
                // ORG is Company;Department;… — the department is not a company.
                var org = SplitOn(value, ';');
                c.CompanyName = Blank(Unescape(At(org, 0)));
                break;
            }

            case "TITLE":
            case "ROLE":
                c.JobTitle ??= Blank(Unescape(value));
                break;

            case "EMAIL":
            {
                var address = Unescape(value).Trim();
                if (address.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
                    address = address[7..];                      // vCard 4.0 writes a URI
                if (address.Length > 0)
                {
                    var entry = new LabelledValue { Value = address, Type = ContactTypes.Email(typeLabel) };
                    if (preferred) c.Emails.Insert(0, entry); else c.Emails.Add(entry);
                }
                break;
            }

            case "TEL":
            {
                var number = Unescape(value).Trim();
                if (number.StartsWith("tel:", StringComparison.OrdinalIgnoreCase))
                    number = number[4..];
                if (number.Length > 0)
                {
                    var entry = new LabelledValue { Value = number, Type = ContactTypes.Phone(typeLabel) };
                    if (preferred) c.Phones.Insert(0, entry); else c.Phones.Add(entry);
                }
                break;
            }

            case "ADR":
            {
                // pobox ; extended ; street ; locality ; region ; postcode ; country
                var a = SplitOn(value, ';');
                var postal = new PostalRecord
                {
                    Type = ContactTypes.Address(typeLabel),
                    Street1 = Blank(Unescape(At(a, 2))),
                    Street2 = Blank(Unescape(At(a, 1))),
                    City = Blank(Unescape(At(a, 3))),
                    Region = Blank(Unescape(At(a, 4))),
                    Postcode = Blank(Unescape(At(a, 5))),
                    Country = Blank(Unescape(At(a, 6))),
                };
                if (!postal.IsEmpty) c.Addresses.Add(postal);
                break;
            }

            case "NOTE":
                c.Notes = Blank(Unescape(value));
                break;

            case "CATEGORIES":
                foreach (var label in SplitOn(value, ','))
                {
                    var l = Unescape(label).Trim();
                    if (l.Length > 0 && !c.Labels.Contains(l)) c.Labels.Add(l);
                }
                break;

            case "BDAY":
                c.Birthday = Blank(Unescape(value));
                break;
        }
    }

    private static string At(string[] parts, int index) =>
        index >= 0 && index < parts.Length ? parts[index] : string.Empty;

    private static string? Blank(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>Split on a separator that a backslash can escape.</summary>
    private static string[] SplitOn(string value, char separator)
    {
        var parts = new List<string>();
        var sb = new StringBuilder();

        for (var i = 0; i < value.Length; i++)
        {
            var ch = value[i];
            if (ch == '\\' && i + 1 < value.Length)
            {
                sb.Append(ch).Append(value[i + 1]);   // keep the escape for Unescape
                i++;
                continue;
            }
            if (ch == separator) { parts.Add(sb.ToString()); sb.Clear(); continue; }
            sb.Append(ch);
        }
        parts.Add(sb.ToString());
        return [.. parts];
    }

    private static string Unescape(string value)
    {
        if (value.IndexOf('\\') < 0) return value;

        var sb = new StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            if (value[i] != '\\' || i + 1 >= value.Length) { sb.Append(value[i]); continue; }

            var next = value[++i];
            sb.Append(next switch
            {
                'n' or 'N' => '\n',
                '\\' => '\\',
                ';' => ';',
                ',' => ',',
                _ => next,
            });
        }
        return sb.ToString();
    }

    /// <summary>
    /// Quoted-printable, as vCard 2.1 uses it. The bytes are decoded as UTF-8
    /// because that is what every exporter of the last fifteen years has meant
    /// by CHARSET, and a mis-guess here is the difference between "Müller" and
    /// "MÃ¼ller".
    /// </summary>
    private static string DecodeQuotedPrintable(string value)
    {
        var bytes = new List<byte>(value.Length);

        for (var i = 0; i < value.Length; i++)
        {
            var ch = value[i];

            if (ch == '=' && i + 2 < value.Length &&
                Uri.IsHexDigit(value[i + 1]) && Uri.IsHexDigit(value[i + 2]))
            {
                bytes.Add(Convert.ToByte(value.Substring(i + 1, 2), 16));
                i += 2;
                continue;
            }

            if (ch < 128) { bytes.Add((byte)ch); continue; }

            // Already decoded text mixed into a quoted-printable value. Rare,
            // but re-encoding it keeps the byte stream consistent.
            bytes.AddRange(Encoding.UTF8.GetBytes(ch.ToString()));
        }

        return Encoding.UTF8.GetString(bytes.ToArray());
    }
}

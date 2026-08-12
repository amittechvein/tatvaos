using System.Text;

namespace TatvaOS.Api.Modules.Family;

/// <summary>
/// Reading and writing the bytes of a CSV file. Nothing in here knows what a
/// contact is — that lives in ContactCsvFormat.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY NOT A LIBRARY: because the interesting part of importing a contacts
///  file is never the comma. It is that the file came out of Google, Outlook,
///  a phone, or a spreadsheet somebody edited by hand, and each of those bends
///  the format differently. A parser we own can be forgiving in exactly the
///  places those tools are sloppy, and strict everywhere else.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class Csv
{
    // A cell needs quoting if it contains any separator we might emit, a quote,
    // or a line break. Semicolon and tab are in the list even though we always
    // write commas: a file that will be opened in a European Excel is safer if
    // its semicolons are quoted anyway.
    private static readonly char[] MustQuote = [',', ';', '\t', '"', '\n', '\r'];

    /// <summary>
    /// Which character separates the columns.
    ///
    /// Excel writes the list separator of the machine's locale, not a comma —
    /// German and French installations write semicolons, and a "CSV" exported
    /// there parses as one enormous column if you assume otherwise. Counted on
    /// the header line only, outside quotes.
    /// </summary>
    public static char DetectDelimiter(string text)
    {
        int comma = 0, semicolon = 0, tab = 0;
        var inQuotes = false;

        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if (ch == '"') { inQuotes = !inQuotes; continue; }
            if (inQuotes) continue;
            if (ch is '\n' or '\r') break;      // header line ends here
            if (ch == ',') comma++;
            else if (ch == ';') semicolon++;
            else if (ch == '\t') tab++;
        }

        if (semicolon > comma && semicolon >= tab) return ';';
        if (tab > comma && tab > semicolon) return '\t';
        return ',';
    }

    /// <summary>
    /// Parse into rows of raw cells. Ragged rows are returned as they are —
    /// deciding whether a short row is an error is the caller's business, and
    /// plenty of real exports omit trailing empty columns.
    ///
    /// Handles: quoted cells, doubled quotes inside them, embedded newlines,
    /// and CRLF / LF / bare-CR line endings in the same file.
    /// </summary>
    public static List<string[]> Parse(string text, char delimiter)
    {
        var rows = new List<string[]>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var inQuotes = false;
        var i = 0;

        void EndCell() { row.Add(cell.ToString()); cell.Clear(); }
        void EndRow() { EndCell(); rows.Add([.. row]); row.Clear(); }

        while (i < text.Length)
        {
            var ch = text[i];

            if (inQuotes)
            {
                if (ch == '"')
                {
                    // "" is a literal quote; a lone " closes the cell.
                    if (i + 1 < text.Length && text[i + 1] == '"') { cell.Append('"'); i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                // Line endings inside a quoted cell are content. Normalise them
                // so a multi-line note does not carry stray carriage returns
                // into the database.
                if (ch == '\r')
                {
                    cell.Append('\n');
                    i += (i + 1 < text.Length && text[i + 1] == '\n') ? 2 : 1;
                    continue;
                }
                cell.Append(ch); i++; continue;
            }

            if (ch == '"') { inQuotes = true; i++; continue; }
            if (ch == delimiter) { EndCell(); i++; continue; }

            if (ch == '\r')
            {
                EndRow();
                i += (i + 1 < text.Length && text[i + 1] == '\n') ? 2 : 1;
                continue;
            }
            if (ch == '\n') { EndRow(); i++; continue; }

            cell.Append(ch); i++;
        }

        // A file that ends without a newline still has a last row. A file that
        // ends WITH one does not — row is empty and there is nothing to add.
        if (cell.Length > 0 || row.Count > 0) EndRow();

        return rows;
    }

    /// <summary>True when every cell in the row is blank.</summary>
    public static bool IsBlank(string[] row)
    {
        foreach (var c in row)
            if (!string.IsNullOrWhiteSpace(c)) return false;
        return true;
    }

    /// <summary>
    /// One cell, quoted and escaped for output.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    ///  guardFormulas is not decoration. A spreadsheet treats a cell starting
    ///  with = + - or @ as a formula, so a contact named
    ///  =HYPERLINK("http://…","Click") — which anyone can put in your address
    ///  book merely by emailing you, since auto-save takes the display name
    ///  from the From header — becomes a live link the moment you export and
    ///  open the file in Excel. Prefixing an apostrophe makes it text again.
    ///
    ///  Phone numbers pass guardFormulas: false. "+91 98765 43210" starts with
    ///  a plus and is not an attack, and mangling every mobile number to defend
    ///  against a name nobody has is the wrong trade. Our own importer strips
    ///  the apostrophe back off on the way in, so a round trip is lossless.
    /// ─────────────────────────────────────────────────────────────────────
    /// </summary>
    public static string Cell(string? value, bool guardFormulas = true)
    {
        var s = value ?? string.Empty;
        if (s.Length == 0) return s;

        if (guardFormulas && (s[0] is '=' or '+' or '-' or '@' or '\t' or '\r'))
            s = "'" + s;

        var needsQuotes = s.IndexOfAny(MustQuote) >= 0
                       || char.IsWhiteSpace(s[0])
                       || char.IsWhiteSpace(s[^1]);

        return needsQuotes ? '"' + s.Replace("\"", "\"\"") + '"' : s;
    }

    /// <summary>Undo the formula guard on the way back in.</summary>
    public static string Unguard(string value) =>
        value.Length > 1 && value[0] == '\'' && value[1] is '=' or '+' or '-' or '@'
            ? value[1..]
            : value;

    /// <summary>Join already-escaped cells into a line. CRLF, as RFC 4180 asks.</summary>
    public static void AppendRow(StringBuilder sb, IEnumerable<string> escapedCells)
    {
        var first = true;
        foreach (var c in escapedCells)
        {
            if (!first) sb.Append(',');
            sb.Append(c);
            first = false;
        }
        sb.Append("\r\n");
    }
}

/// <summary>
/// Turning uploaded bytes into a string without guessing wrongly.
/// </summary>
public static class TextFile
{
    /// <summary>
    /// Decode an uploaded file.
    ///
    /// Byte-order marks are honoured first — Google's CSV export carries a
    /// UTF-8 one, and some Windows tools write UTF-16. With no BOM we try
    /// strict UTF-8, which either succeeds or throws; a throw means the file is
    /// almost certainly a legacy single-byte encoding, and Latin-1 recovers the
    /// accented names rather than leaving a page of replacement characters.
    ///
    /// Latin-1 is not Windows-1252: the eight positions holding smart quotes
    /// and dashes will come through as control characters. That is a cosmetic
    /// loss in a Notes field, against a total loss of every accented surname,
    /// and it needs no extra encoding-provider registration to get right.
    /// </summary>
    public static string Decode(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
            return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);

        try
        {
            return new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.Latin1.GetString(bytes);
        }
    }
}

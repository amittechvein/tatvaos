using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// The server's check on the .xlsx a spreadsheet checkpoint uploads — the
/// file Space serves, downloads and lets Mail attach.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY. The editor builds the .xlsx in the browser; a hand-made client can
///  send any zip. Formulas are ordinary content and are NOT blocked as a
///  class (Mr. Singh, 25 Sept 2026). What is refused is what turns a
///  workbook into an attack on whoever opens it:
///
///    · macros and embedded code: vbaProject, ActiveX, OLE embeddings,
///      macro-enabled content types, any .bin part;
///    · reaching outside the file: external-link parts, data connections,
///      query tables, and any relationship with TargetMode="External";
///    · HYPERLINK targets other than a quoted http:, https: or mailto:
///      link — file: and \\server paths make Windows sign in to someone
///      else's server and leak the password hash (Mr. Singh, 25 Sept);
///    · formulas that call out (same rules as apps/web/lib/sheets/io/
///      safety.ts — change both or neither): "|" outside quoted text (DDE),
///      "[" or "]" (a reference into another workbook), and WEBSERVICE,
///      IMPORTDATA/IMPORTXML/IMPORTHTML/IMPORTFEED/IMPORTRANGE, RTD, CALL,
///      REGISTER.ID, EXEC, DDE. Checked in every cell formula and every
///      defined name;
///    · a DOCTYPE in any XML part (external entities in other readers).
///
///  The editor's own writer never produces any of these (it writes a
///  calling-out formula as text), so an honest client is never refused;
///  tests/sheets/sheets-live.e2e.ts proves both halves in one run.
///
///  WHAT THIS DOES NOT MAKE TRUE. The file can still SAY something
///  different from the spreadsheet everyone edited: the server never reads
///  the Yjs content, so it cannot compare. A clean workbook can show ₹5,000
///  where the live sheet has ₹50,000. Known limitation, as for Docs' HTML;
///  the durable fix is rendering the file on the server from the Yjs state.
///  Until that is built, Sheets goes to no customer but Techvein — decision
///  0011 (docs/decisions/0011-docs-and-sheets-before-customers.md).
///
///  Bounded: at most 10,000 parts, 200 MB uncompressed, 20 MB per XML part
///  read — enforced while reading, not taken from the zip's own claims.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static partial class XlsxGuard
{
    private const int MaxEntries = 10_000;
    private const long MaxTotalBytes = 200L * 1024 * 1024;
    private const int MaxXmlBytes = 20 * 1024 * 1024;

    private static readonly string[] CallOut =
    [
        "WEBSERVICE", "IMPORTDATA", "IMPORTXML", "IMPORTHTML", "IMPORTFEED", "IMPORTRANGE",
        "RTD", "CALL", "REGISTER.ID", "EXEC", "DDE",
    ];

    /// <summary>null if the workbook may be stored; else a short reason code for the refusal and the log.</summary>
    public static string? Check(byte[] xlsx)
    {
        ZipArchive zip;
        try { zip = new ZipArchive(new MemoryStream(xlsx, writable: false), ZipArchiveMode.Read); }
        catch (InvalidDataException) { return "not_a_zip"; }

        using (zip)
        {
            if (zip.Entries.Count > MaxEntries) return "too_many_parts";
            long total = 0;
            var sawWorkbook = false;

            foreach (var e in zip.Entries)
            {
                var name = e.FullName.Replace('\\', '/');
                var lower = name.ToLowerInvariant();

                if (lower.StartsWith('/') || lower.Contains("../")) return "bad_part_name";
                if (lower.Contains("vbaproject") || lower.EndsWith(".bin")) return "macro_or_binary_part";
                if (lower.StartsWith("xl/activex/") || lower.StartsWith("xl/embeddings/")) return "embedded_object";
                if (lower.StartsWith("xl/externallinks/")) return "external_link";
                if (lower == "xl/connections.xml" || lower.StartsWith("xl/querytables/")) return "data_connection";
                if (lower == "xl/workbook.xml") sawWorkbook = true;

                var isXml = lower.EndsWith(".xml") || lower.EndsWith(".rels");
                if (!isXml) { total += Math.Max(0, e.Length); if (total > MaxTotalBytes) return "too_large"; continue; }

                string? text;
                try { text = ReadCapped(e, ref total); }
                catch (InvalidDataException) { return "not_a_zip"; }
                if (text is null) return "too_large";

                if (text.Contains("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)) return "doctype";

                if (lower == "[content_types].xml"
                    && (text.Contains("macroEnabled", StringComparison.OrdinalIgnoreCase)
                        || text.Contains("vbaProject", StringComparison.OrdinalIgnoreCase)
                        || text.Contains("activeX", StringComparison.OrdinalIgnoreCase)
                        || text.Contains("oleObject", StringComparison.OrdinalIgnoreCase)))
                    return "macro_content_type";

                if (lower.EndsWith(".rels") && ExternalTarget().IsMatch(text)) return "external_relationship";

                if (lower.StartsWith("xl/worksheets/") || lower == "xl/workbook.xml")
                {
                    var pattern = lower == "xl/workbook.xml" ? DefinedName() : CellFormula();
                    foreach (Match m in pattern.Matches(text))
                    {
                        var formula = WebUtility.HtmlDecode(m.Groups[1].Value);
                        if (!FormulaIsSafe(formula)) return "calling_out_formula";
                    }
                }
            }

            return sawWorkbook ? null : "no_workbook";
        }
    }

    /// <summary>Same rules as safety.ts formulaIsSafe. The input may start with '=' or not.</summary>
    public static bool FormulaIsSafe(string formula)
    {
        var f = formula.StartsWith('=') ? formula[1..] : formula;
        // Blank out "quoted text" so no rule fires on text.
        var bare = QuotedText().Replace(f, m => new string(' ', m.Length));
        if (bare.Contains('|') || bare.Contains('[') || bare.Contains(']')) return false;
        if (!HyperlinksAreSafe(f, bare)) return false;
        var upper = bare.ToUpperInvariant().Replace("_XLFN.", "").Replace("_XLWS.", "");
        foreach (var fn in CallOut)
        {
            if (Regex.IsMatch(upper, $@"(^|[^A-Z0-9_.]){Regex.Escape(fn)}\s*\(")) return false;
        }
        return true;
    }

    /// <summary>Every HYPERLINK( starts with a quoted http:, https: or mailto: target (safety.ts hyperlinksAreSafe).</summary>
    private static bool HyperlinksAreSafe(string src, string bare)
    {
        foreach (Match m in Hyperlink().Matches(bare))
        {
            var i = m.Index + m.Length;
            while (i < src.Length && char.IsWhiteSpace(src[i])) i++;
            if (i >= src.Length || src[i] != '"') return false; // not a literal: cannot be checked
            var target = new StringBuilder();
            for (i++; i < src.Length; i++)
            {
                if (src[i] == '"')
                {
                    if (i + 1 < src.Length && src[i + 1] == '"') { target.Append('"'); i++; continue; }
                    break;
                }
                target.Append(src[i]);
            }
            if (!AllowedLink().IsMatch(target.ToString())) return false;
        }
        return true;
    }

    [GeneratedRegex(@"(^|[^A-Z0-9_.])(_XLFN\.)?HYPERLINK\s*\(", RegexOptions.IgnoreCase)]
    private static partial Regex Hyperlink();

    [GeneratedRegex(@"^\s*(https?:|mailto:)", RegexOptions.IgnoreCase)]
    private static partial Regex AllowedLink();

    /// <summary>An XML part as text, counting its REAL size against the total as it is read.</summary>
    private static string? ReadCapped(ZipArchiveEntry e, ref long total)
    {
        using var s = e.Open();
        using var ms = new MemoryStream();
        var buf = new byte[81920];
        int n;
        while ((n = s.Read(buf, 0, buf.Length)) > 0)
        {
            total += n;
            if (ms.Length + n > MaxXmlBytes || total > MaxTotalBytes) return null;
            ms.Write(buf, 0, n);
        }
        return Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
    }

    [GeneratedRegex("\"(?:[^\"]|\"\")*\"?")]
    private static partial Regex QuotedText();

    [GeneratedRegex(@"TargetMode\s*=\s*[""']External[""']", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalTarget();

    [GeneratedRegex(@"<(?:\w+:)?f(?:\s[^>]*)?>(.*?)</(?:\w+:)?f>", RegexOptions.Singleline)]
    private static partial Regex CellFormula();

    [GeneratedRegex(@"<(?:\w+:)?definedName(?:\s[^>]*)?>(.*?)</(?:\w+:)?definedName>", RegexOptions.Singleline)]
    private static partial Regex DefinedName();
}

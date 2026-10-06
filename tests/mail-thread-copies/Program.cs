// An alias, and a namespace that is NOT called MailThreadCopies: inside one
// that is, the bare name resolves to the namespace and the class is unreachable.
using Copies = TatvaOS.Api.Modules.Mail.MailThreadCopies;

namespace TatvaOS.Tests.ThreadCopies;

/// <summary>
/// Runs MailThreadCopies.Fold against the conversation a client reported on
/// 28 September 2026 as "two mails are going out", and against the shapes
/// where folding would HIDE mail rather than tidy it.
///
/// Usage:  dotnet run --project tests/mail-thread-copies
/// Exit:   0 = all assertions passed, 1 = at least one failed. Read the last line.
/// </summary>
internal static class Program
{
    private sealed record Row(string Tag, string? MessageId, bool InSent);

    private static int _failed;
    private static int _passed;

    private static void Check(string what, string expected, string actual)
    {
        if (expected == actual) { _passed++; Console.WriteLine($"  ok    {what}"); return; }
        _failed++;
        Console.WriteLine($"  FAIL  {what}");
        Console.WriteLine($"          expected  {expected}");
        Console.WriteLine($"          actual    {actual}");
    }

    /// <summary>"B[BC]" = row B is shown and stands for B and C.</summary>
    private static string Shape(IEnumerable<Row> rows) =>
        string.Join(" ", Copies.Fold(rows, r => r.MessageId, r => r.InSent)
            .Select(g => g.Copies.Count == 1
                ? g.Shown.Tag
                : $"{g.Shown.Tag}[{string.Concat(g.Copies.Select(c => c.Tag))}]"));

    private static int Main()
    {
        Console.WriteLine();
        Console.WriteLine("  MailThreadCopies — GET /api/mail/threads/{id}/messages");
        Console.WriteLine("  ══════════════════════════════════════════════════════════");

        // ── THE REPORT. Oldest first, as the endpoint hands them over: the
        //    first message (Sent only), then the reminder he addressed to
        //    himself - delivered copy first, because its time is the Date
        //    header and the Sent copy's is stamped after the submit returns.
        var reported = new[]
        {
            new Row("A", "first@shippingxpress.in",    InSent: true),
            new Row("B", "reminder@shippingxpress.in", InSent: false),
            new Row("C", "reminder@shippingxpress.in", InSent: true),
        };
        Check("the reported trail is TWO messages, not three", "A C[BC]", Shape(reported));
        Check("...and the Sent copy is the one shown whichever came first",
            "A C[CB]", Shape(new[] { reported[0], reported[2], reported[1] }));

        // ── The calibration: what the old endpoint did, so the check above
        //    has something to differ from. No ids in common, nothing folds.
        Check("three different messages stay three", "A B C", Shape(new[]
        {
            new Row("A", "1@x", true), new Row("B", "2@x", false), new Row("C", "3@x", true),
        }));

        // ── Where folding would hide mail. ──────────────────────────────────
        Check("rows with NO Message-ID never fold (seed mail has none)", "A B C", Shape(new[]
        {
            new Row("A", null, false), new Row("B", null, false), new Row("C", null, true),
        }));
        Check("empty and whitespace ids are 'no id', not an id they share", "A B C", Shape(new[]
        {
            new Row("A", "", false), new Row("B", "   ", false), new Row("C", "<>", false),
        }));
        Check("ids differing only in case are different messages", "A B", Shape(new[]
        {
            new Row("A", "Abc@x", false), new Row("B", "abc@x", false),
        }));

        // ── One form must not miss the other. ───────────────────────────────
        Check("a bracketed id and a bare one are the same message", "B[AB]", Shape(new[]
        {
            new Row("A", "<r@x>", false), new Row("B", "r@x", true),
        }));
        Check("...with stray spaces too", "A[AB]", Shape(new[]
        {
            new Row("A", " <r@x> ", false), new Row("B", "r@x", false),
        }));

        // ── Order and choice. ───────────────────────────────────────────────
        Check("an entry sits where its FIRST copy sat", "B[BD] C A", Shape(new[]
        {
            new Row("B", "r@x", false), new Row("C", "2@x", false),
            new Row("A", "3@x", false), new Row("D", "r@x", false),
        }));
        Check("no Sent copy: the first copy is shown", "A[AB]", Shape(new[]
        {
            new Row("A", "r@x", false), new Row("B", "r@x", false),
        }));
        Check("three copies fold into one", "B[ABC]", Shape(new[]
        {
            new Row("A", "r@x", false), new Row("B", "r@x", true), new Row("C", "r@x", false),
        }));
        Check("an empty conversation is empty", "", Shape(Array.Empty<Row>()));

        // ── SEARCH: pages of the folded list. ───────────────────────────────
        //
        //  Twelve stored rows, nine mails. The pairs are placed where they
        //  hurt: one straddling the end of the first page of 3 (c|C), one at
        //  the very top (a,A), one at the very end (i,I).
        //  Lower case = delivered copy, upper case = the Sent copy of the same mail.
        var stored = new List<Row>
        {
            new("a", "1@x", false), new("A", "1@x", true),
            new("b", "2@x", false),
            new("c", "3@x", false), new("C", "3@x", true),
            new("d", null,  false), new("e", null, false),
            new("f", "6@x", false), new("g", "7@x", true), new("h", "8@x", false),
            new("i", "9@x", false), new("I", "9@x", true),
        };
        const string whole = "AbCdefghI";

        // The phone's way of paging: skip = the rows already on screen. The
        // server reads only the top Window(skip, take) stored rows each time.
        string Paged(int take, Func<IEnumerable<Row>, int, int, IEnumerable<Row>> page)
        {
            var shown = new List<Row>();
            for (var guard = 0; guard < 50; guard++)
            {
                var got = page(stored, shown.Count, take).ToList();
                if (got.Count == 0) break;
                shown.AddRange(got);
            }
            return string.Concat(shown.Select(r => r.Tag));
        }

        IEnumerable<Row> Folded(IEnumerable<Row> all, int skip, int take) =>
            Copies.Page(all.Take(Copies.Window(skip, take)), r => r.MessageId, r => r.InSent, skip, take)
                  .Select(g => g.Shown);

        foreach (var take in new[] { 1, 2, 3, 4, 5, 30 })
            Check($"search, pages of {take}: every mail once, in order", whole, Paged(take, Folded));

        // THE CALIBRATION, and the reason folding is not done inside a page:
        // fold each page of stored rows by itself and the phone's next skip
        // lands one row early. Must NOT equal `whole`, or the checks above
        // would pass for any implementation at all.
        IEnumerable<Row> FoldedInsideThePage(IEnumerable<Row> all, int skip, int take) =>
            Copies.Fold(all.Skip(skip).Take(take), r => r.MessageId, r => r.InSent).Select(g => g.Shown);
        var naive = Paged(3, FoldedInsideThePage);
        Check("folding inside each page of 3 is WRONG (rows repeat) - what was not built",
            "True", $"{naive != whole}");
        Console.WriteLine($"          (it gives {naive})");

        Check("the window is twice what is asked for", "70", $"{Copies.Window(5, 30)}");
        var overflowed = false;
        try { Copies.Window(int.MaxValue - 10, 30); } catch (OverflowException) { overflowed = true; }
        Check("a skip near the top of int throws rather than wrapping to a small window", "True", $"{overflowed}");
        Check("a page past the end is empty", "", string.Concat(Folded(stored, 9, 3).Select(r => r.Tag)));

        Console.WriteLine();
        Console.WriteLine(_failed == 0
            ? $"  PASSED  {_passed} checks"
            : $"  FAILED  {_failed} of {_passed + _failed} checks");
        return _failed == 0 ? 0 : 1;
    }
}

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

        Console.WriteLine();
        Console.WriteLine(_failed == 0
            ? $"  PASSED  {_passed} checks"
            : $"  FAILED  {_failed} of {_passed + _failed} checks");
        return _failed == 0 ? 0 : 1;
    }
}

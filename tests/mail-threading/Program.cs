using TatvaOS.Api.Modules.Mail;

namespace TatvaOS.Tests.MailThreading;

/// <summary>
/// Drives MailThreadHeaders through every shape a real conversation has been
/// seen in: a clean chain, a parent with no stored Message-ID, brackets that
/// arrived with the id, duplicates, and a thread longer than the header may be.
///
/// Usage:  dotnet run --project tests/mail-threading
/// Exit:   0 = all assertions passed, 1 = at least one failed. Read the last line.
/// </summary>
internal static class Program
{
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

    /// <summary>One printable string per result, so a wrong ORDER fails too.</summary>
    private static string Show(MailThreadHeaders.Result r) =>
        $"in-reply-to={r.InReplyTo ?? "(none)"} refs=[{string.Join(' ', r.References)}]";

    private static int Main()
    {
        Console.WriteLine("MailThreadHeaders");

        // The case Amit reported: a courier thread, two messages in, answered.
        var courier = new[] { "first.ticket.9001@d.example", "second.ticket.9002@d.example" };
        Check("a two-message thread puts the ancestry in order, parent last",
            "in-reply-to=second.ticket.9002@d.example refs=[first.ticket.9001@d.example second.ticket.9002@d.example]",
            Show(MailThreadHeaders.Build(courier, "second.ticket.9002@d.example")));

        // The bug that shipped: References carrying the parent alone. This is
        // what the old build emitted, and it must NOT be what this returns.
        var single = Show(MailThreadHeaders.Build(courier, "second.ticket.9002@d.example"));
        Check("the root is not dropped from References",
            "True", single.Contains("first.ticket.9001@d.example").ToString());

        // Nothing to thread on. The caller logs and sends unthreaded; it must
        // not invent an id, and it must say so rather than returning an empty
        // In-Reply-To that MimeKit would happily write as garbage.
        Check("no ids at all cannot thread",
            "in-reply-to=(none) refs=[]",
            Show(MailThreadHeaders.Build(Array.Empty<string>(), null)));
        Check("no ids at all reports CanThread false",
            "False", MailThreadHeaders.Build(null, "").CanThread.ToString());

        // A parent ingested before the header was stored. The newest ancestor
        // stands in: threading to the right conversation beats not threading.
        Check("a parent with no Message-ID falls back to the newest ancestor",
            "in-reply-to=second.ticket.9002@d.example refs=[first.ticket.9001@d.example second.ticket.9002@d.example]",
            Show(MailThreadHeaders.Build(courier, null)));

        // Brackets. Stored ids are bare, but mail that arrived by other routes
        // has carried them, and MimeKit adds its own — so a bracketed id would
        // go out as <<id>> and match nothing.
        Check("angle brackets are stripped from both the chain and the parent",
            "in-reply-to=b@x refs=[a@x b@x]",
            Show(MailThreadHeaders.Build(new[] { "<a@x>", " <b@x> " }, "<b@x>")));

        // Duplicates: the same id in the chain twice, and the parent already
        // present in the chain. Neither may appear twice in the header.
        Check("a duplicated id appears once",
            "in-reply-to=b@x refs=[a@x b@x]",
            Show(MailThreadHeaders.Build(new[] { "a@x", "a@x", "b@x" }, "b@x")));
        Check("the parent moves to the end rather than being repeated",
            "in-reply-to=a@x refs=[b@x c@x a@x]",
            Show(MailThreadHeaders.Build(new[] { "a@x", "b@x", "c@x" }, "a@x")));

        // Nulls and blanks: MessageIdHeader is a nullable column and the chain
        // is read straight out of it.
        Check("nulls and blanks in the chain are ignored",
            "in-reply-to=b@x refs=[a@x b@x]",
            Show(MailThreadHeaders.Build(new string?[] { null, "a@x", "  ", "" }, "b@x")));

        // A thread longer than the header may carry. The ROOT must survive —
        // it is what groups the conversation — and so must the recent end.
        var many = Enumerable.Range(1, 40).Select(n => $"m{n}@x").ToArray();
        var capped = MailThreadHeaders.Build(many, "m40@x");
        Check("a long thread is capped",
            MailThreadHeaders.MaxReferences.ToString(), capped.References.Count.ToString());
        Check("the capped chain keeps the root", "m1@x", capped.References[0]);
        Check("the capped chain ends at the parent", "m40@x", capped.References[^1]);
        Check("the capped chain keeps the most recent ids, not the oldest",
            "True", capped.References.Contains("m39@x").ToString());
        Check("the capped chain drops from the middle",
            "False", capped.References.Contains("m5@x").ToString());

        // A chain exactly at the cap must not lose the root to an off-by-one.
        var exact = MailThreadHeaders.Build(
            Enumerable.Range(1, MailThreadHeaders.MaxReferences).Select(n => $"e{n}@x"), null);
        Check("a chain exactly at the cap is unchanged",
            $"{MailThreadHeaders.MaxReferences} e1@x e{MailThreadHeaders.MaxReferences}@x",
            $"{exact.References.Count} {exact.References[0]} {exact.References[^1]}");

        Console.WriteLine();
        Console.WriteLine(_failed == 0
            ? $"PASS {_passed} checks"
            : $"FAIL {_failed} of {_passed + _failed} checks");
        return _failed == 0 ? 0 : 1;
    }
}

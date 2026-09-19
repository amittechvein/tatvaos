using TatvaOS.Api.Modules.Mail;

namespace TatvaOS.Tests.MailSort;

/// <summary>
/// Runs MailListSort against a folder shaped to catch each way an order can be
/// quietly wrong: the wrong direction, a tie that comes back differently on the
/// next page, a nameless sender, a capital letter.
///
/// Usage:  dotnet run --project tests/mail-sort
/// Exit:   0 = all assertions passed, 1 = at least one failed. Read the last line.
/// </summary>
internal static class Program
{
    private sealed class Row : IMailSortable
    {
        public Guid Id { get; init; }
        public string Tag { get; init; } = "";
        public DateTimeOffset ReceivedAt { get; init; }
        public bool IsRead { get; init; }
        public bool IsFlagged { get; init; }
        public string? FromName { get; init; }
        public string? FromAddr { get; init; }
        public long SizeBytes { get; init; }
    }

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

    private static Guid G(int n) => new($"00000000-0000-0000-0000-{n:D12}");

    private static int Main()
    {
        var t0 = new DateTimeOffset(2026, 9, 19, 9, 0, 0, TimeSpan.Zero);

        // Ids are deliberately NOT in time order, so "sorted by Id" and "sorted
        // by time" can never be mistaken for one another.
        var folder = new List<Row>
        {
            new() { Tag = "A", Id = G(5), ReceivedAt = t0.AddHours(-1), IsRead = true,  IsFlagged = false, FromName = "zara",  FromAddr = "z@x.in", SizeBytes = 100 },
            new() { Tag = "B", Id = G(2), ReceivedAt = t0.AddHours(-2), IsRead = false, IsFlagged = true,  FromName = "Amit",  FromAddr = "a@x.in", SizeBytes = 900 },
            new() { Tag = "C", Id = G(9), ReceivedAt = t0.AddHours(-3), IsRead = false, IsFlagged = false, FromName = null,    FromAddr = "meera@x.in", SizeBytes = 500 },
            new() { Tag = "D", Id = G(1), ReceivedAt = t0.AddHours(-4), IsRead = true,  IsFlagged = true,  FromName = "",      FromAddr = "bala@x.in",  SizeBytes = 500 },
            // E and F arrived in the SAME instant, as one delivery's copies do.
            new() { Tag = "E", Id = G(7), ReceivedAt = t0.AddHours(-5), IsRead = true,  IsFlagged = false, FromName = "amit",  FromAddr = "a2@x.in", SizeBytes = 100 },
            new() { Tag = "F", Id = G(3), ReceivedAt = t0.AddHours(-5), IsRead = true,  IsFlagged = false, FromName = "Amit",  FromAddr = "a3@x.in", SizeBytes = 100 },
        };

        string Order(string key, IEnumerable<Row>? over = null) =>
            string.Concat(MailListSort.Apply((over ?? folder).AsQueryable(), key).Select(r => r.Tag));

        Console.WriteLine();
        Console.WriteLine("  MailListSort — GET /api/mail/folders/{id}/messages?sort=");
        Console.WriteLine("  ══════════════════════════════════════════════════════════");

        Check("oldest: earliest first, the same-instant pair by Id (F=3 before E=7)", "FEDCBA", Order(MailListSort.Oldest));
        Check("unread: unread first, each group newest first",                          "BCADFE", Order(MailListSort.Unread));
        Check("starred: starred first, each group newest first",                        "BDACFE", Order(MailListSort.Starred));
        // amit/Amit/Amit are neighbours whatever their case (newest first among
        // them: B, then the same-instant pair F before E by Id); "" and null both
        // fall back to the address: bala@, meera@; zara last.
        Check("sender: by the name shown, case-blind, address when there is no name",   "BFEDCA", Order(MailListSort.Sender));
        Check("largest: biggest first, equal sizes newest first",                       "BCDAFE", Order(MailListSort.Largest));

        // ── the reason every order ends in Id: paging ───────────────────────
        // The same folder handed over in a different storage order must page
        // identically, or "Load more" repeats some rows and never shows others.
        var shuffled = folder.AsEnumerable().Reverse().ToList();
        foreach (var key in MailListSort.All.Where(k => k != MailListSort.Newest))
            Check($"{key}: the order does not depend on the order rows were stored in", Order(key), Order(key, shuffled));

        foreach (var key in MailListSort.All.Where(k => k != MailListSort.Newest))
        {
            var whole = Order(key);
            var paged = string.Concat(Enumerable.Range(0, 3).SelectMany(p =>
                MailListSort.Apply(shuffled.AsQueryable(), key).Skip(p * 2).Take(2).Select(r => r.Tag)));
            Check($"{key}: three pages of two are the whole list, once each", whole, paged);
        }

        // ── parsing ─────────────────────────────────────────────────────────
        Check("nothing sent is the default",      "True newest",  $"{MailListSort.TryParse(null, out var k1)} {k1}");
        Check("blank is the default",             "True newest",  $"{MailListSort.TryParse("  ", out var k2)} {k2}");
        Check("a known key is itself",            "True oldest",  $"{MailListSort.TryParse("oldest", out var k3)} {k3}");
        Check("the wrong case is refused",        "False",        $"{MailListSort.TryParse("Oldest", out _)}");
        Check("an unknown key is refused",        "False",        $"{MailListSort.TryParse("date", out _)}");
        Check("SQL in the key is just unknown",   "False",        $"{MailListSort.TryParse("oldest; drop table", out _)}");

        var threw = false;
        try { MailListSort.Apply(folder.AsQueryable(), MailListSort.Newest); } catch (ArgumentOutOfRangeException) { threw = true; }
        Check("Apply refuses 'newest': the endpoint keeps its own default on purpose", "True", $"{threw}");

        Console.WriteLine();
        Console.WriteLine(_failed == 0
            ? $"  PASSED  {_passed} checks"
            : $"  FAILED  {_failed} of {_passed + _failed} checks");
        return _failed == 0 ? 0 : 1;
    }
}

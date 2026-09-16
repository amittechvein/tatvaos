using System.Globalization;
using TatvaOS.Api.Modules.Connect;

namespace TatvaOS.Tests.Order;

/// <summary>
/// Runs ConnectMeetingOrder against meetings shaped like the ones that got
/// this wrong.
///
/// Usage:  dotnet run --project tests/connect-order
/// Exit:   0 = all assertions passed, 1 = at least one failed.
///
/// Read the last line. Everything above it is there so that a failure tells
/// you what broke without opening a debugger.
/// </summary>
internal static class Program
{
    private static int Main()
    {
        var t = new Harness();

        Console.WriteLine();
        Console.WriteLine("  ConnectMeetingOrder — GET /api/connect/meetings row order");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        RunAll(t);

        // ── The same suite under hostile cultures ─────────────────────────
        //
        // Nothing here formats or parses a date today, and `==` on a string is
        // ordinal in C#. Both of those are properties of the CURRENT
        // expression, not of the rule, and either could be given away by a
        // reasonable-looking edit — string.Compare and ToString("t") are one
        // keystroke from where this sorts. th-TH is 543 years out on any
        // culture-sensitive date path; de-DE swaps the separators. This is the
        // guard that notices the day one of them gets in.
        var repeated = 0;
        foreach (var name in new[] { "th-TH", "de-DE", "ar-SA" })
        {
            var before = t.Failed;
            t.Quiet = true;
            CultureInfo.CurrentCulture = new CultureInfo(name);
            CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
            var start = t.Passed;
            RunAll(t);
            repeated = t.Passed - start;
            if (t.Failed != before)
                Console.WriteLine($"  FAIL  the suite does not hold under culture {name}");
        }
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        t.Quiet = false;
        t.Note($"all {repeated} assertions repeat clean under th-TH, de-DE, ar-SA");

        return t.Report();
    }

    private static void RunAll(Harness t)
    {
        TheBugItself(t);
        LiveAgainstLive(t);
        TheRestStayChronological(t);
        ItSurvivesTheFirstPage(t);
        Today(t);
        Past(t);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Fixtures
    // ══════════════════════════════════════════════════════════════════════
    //
    // A fixed "now" rather than DateTimeOffset.UtcNow, so a failure is the
    // same failure tomorrow and at 23:59:59 on the last day of a month.
    private static readonly DateTimeOffset Now =
        new(2026, 9, 15, 11, 30, 0, TimeSpan.Zero);

    /// <summary>
    /// A meeting somebody booked and nobody ever opened. Its start has gone
    /// by, but only just — the endpoint's two-hour grace window still counts
    /// it as upcoming, and its status is still 'scheduled' because status only
    /// becomes anything else when LiveKit says somebody joined.
    ///
    /// THIS IS THE ROW THAT USED TO SIT ABOVE A LIVE MEETING.
    /// </summary>
    private static ConnectMeeting StaleScheduled => new()
    {
        Id = Guid.Parse("11111111-1111-1111-1111-111111111111"),
        Title = "Budget review (nobody came)",
        Kind = "scheduled",
        Status = "scheduled",
        ScheduledStart = Now.AddHours(-1),
        CreatedAt = Now.AddDays(-3),
    };

    /// <summary>
    /// An instant meeting that is running RIGHT NOW. Created after the one
    /// above — which is the whole point: every time-like column on this row is
    /// LATER, so any ordering that looks only at time puts it second.
    /// </summary>
    private static ConnectMeeting LiveInstant => new()
    {
        Id = Guid.Parse("22222222-2222-2222-2222-222222222222"),
        Title = "Quick sync (happening now)",
        Kind = "instant",
        Status = "active",
        ScheduledStart = null,
        CreatedAt = Now.AddMinutes(-10),
        StartedAt = Now.AddMinutes(-10),
    };

    private static ConnectMeeting Scheduled(string title, TimeSpan inFuture) => new()
    {
        Id = Guid.NewGuid(),
        Title = title,
        Kind = "scheduled",
        Status = "scheduled",
        ScheduledStart = Now + inFuture,
        CreatedAt = Now.AddDays(-5),
    };

    private static List<string> Sort(IEnumerable<ConnectMeeting> rows, string which) =>
        ConnectMeetingOrder.Sort(rows.AsQueryable(), which).Select(m => m.Title).ToList();

    // ══════════════════════════════════════════════════════════════════════
    //  1. The bug itself
    // ══════════════════════════════════════════════════════════════════════
    private static void TheBugItself(Harness t)
    {
        t.Section("the bug this project exists for");

        // Stated as facts about the fixtures first, so that a future failure
        // cannot be explained away as "the test data must be wrong".
        t.Ok("the stale meeting was created BEFORE the live one",
            StaleScheduled.CreatedAt < LiveInstant.CreatedAt);
        t.Ok("and its ordering key is EARLIER than the live one's",
            (StaleScheduled.ScheduledStart ?? StaleScheduled.CreatedAt)
            < (LiveInstant.ScheduledStart ?? LiveInstant.CreatedAt));

        // Both input orders, so the assertion cannot be passing because the
        // list happened to arrive sorted already.
        foreach (var (shape, input) in new (string, ConnectMeeting[])[]
        {
            ("stale first in", [StaleScheduled, LiveInstant]),
            ("live first in", [LiveInstant, StaleScheduled]),
        })
        {
            var order = Sort(input, "upcoming");
            t.Ok($"upcoming: the LIVE meeting comes first ({shape})",
                order[0] == LiveInstant.Title);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  2. Two live meetings
    // ══════════════════════════════════════════════════════════════════════
    private static void LiveAgainstLive(Harness t)
    {
        t.Section("when more than one is live");

        var earlier = LiveInstant;                       // created 11:20
        var later = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "Second live meeting",
            Kind = "instant",
            Status = "active",
            CreatedAt = Now.AddMinutes(-2),              // created 11:28
            StartedAt = Now.AddMinutes(-2),
        };

        var order = Sort(new[] { later, earlier, StaleScheduled }, "upcoming");

        t.Ok("both live meetings sort above the stale one",
            order.IndexOf(StaleScheduled.Title) == 2);
        t.Ok("and between themselves the one that began first wins",
            order[0] == earlier.Title && order[1] == later.Title);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  3. Everything that is not live keeps the order it had
    // ══════════════════════════════════════════════════════════════════════
    private static void TheRestStayChronological(Harness t)
    {
        t.Section("nothing else about the order changes");

        var inAnHour = Scheduled("In an hour", TimeSpan.FromHours(1));
        var tomorrow = Scheduled("Tomorrow", TimeSpan.FromDays(1));
        var nextWeek = Scheduled("Next week", TimeSpan.FromDays(7));

        var order = Sort(new[] { nextWeek, inAnHour, tomorrow, StaleScheduled }, "upcoming");

        t.Ok("with nothing live, upcoming is still soonest-first",
            order.SequenceEqual(new[]
            {
                StaleScheduled.Title, inAnHour.Title, tomorrow.Title, nextWeek.Title,
            }));

        var withLive = Sort(
            new[] { nextWeek, inAnHour, LiveInstant, tomorrow, StaleScheduled }, "upcoming");

        t.Ok("adding a live meeting moves only the live meeting",
            withLive.SequenceEqual(new[]
            {
                LiveInstant.Title,
                StaleScheduled.Title, inAnHour.Title, tomorrow.Title, nextWeek.Title,
            }));
    }

    // ══════════════════════════════════════════════════════════════════════
    //  4. The consequence no client can work around
    // ══════════════════════════════════════════════════════════════════════
    private static void ItSurvivesTheFirstPage(Harness t)
    {
        t.Section("the live meeting is on the first page");

        // Both Connect web pages and the phone ask for page 1 and no more. A
        // client that picks the live meeting out of what it was given — which
        // apps/web/app/connect/(shell)/page.tsx does, and
        // apps/mobile/lib/nextMeeting.js does — cannot pick one that never
        // arrived. Ordering is the ONLY place this can be fixed, which is why
        // "the clients already sort it themselves" is not an argument for
        // leaving the query alone.
        const int pageSize = 50;

        var rows = new List<ConnectMeeting>();
        for (var i = 0; i < 80; i++)
            rows.Add(Scheduled($"Booked #{i}", TimeSpan.FromDays(i + 1)));
        rows.Add(StaleScheduled);
        rows.Add(LiveInstant);

        var firstPage = ConnectMeetingOrder.Sort(rows.AsQueryable(), "upcoming")
            .Take(pageSize).Select(m => m.Title).ToList();

        t.Ok($"live meeting is inside the first {pageSize} of {rows.Count}",
            firstPage.Contains(LiveInstant.Title));
        t.Ok("and it is the first row", firstPage[0] == LiveInstant.Title);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  5. Today
    // ══════════════════════════════════════════════════════════════════════
    private static void Today(Harness t)
    {
        t.Section("today");

        // 'today' only ever holds meetings with a ScheduledStart, so the
        // instant-versus-scheduled inversion cannot happen here — but a
        // scheduled meeting nobody joined at 09:00 still outranks the one that
        // is running at 11:00 under a purely chronological sort. Same rule for
        // both, so that the two arms cannot drift apart later.
        var noShow = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "09:00 that nobody joined",
            Kind = "scheduled",
            Status = "scheduled",
            ScheduledStart = Now.AddHours(-2.5),
            CreatedAt = Now.AddDays(-1),
        };
        var running = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "11:00 running now",
            Kind = "scheduled",
            Status = "active",
            ScheduledStart = Now.AddMinutes(-30),
            CreatedAt = Now.AddDays(-1),
            StartedAt = Now.AddMinutes(-30),
        };

        var order = Sort(new[] { noShow, running }, "today");
        t.Ok("today: the running meeting comes first", order[0] == running.Title);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  6. Past, which must not have moved
    // ══════════════════════════════════════════════════════════════════════
    private static void Past(Harness t)
    {
        t.Section("past is untouched");

        var endedThisMorning = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "Ended this morning",
            Kind = "instant",
            Status = "ended",
            CreatedAt = Now.AddHours(-4),
            StartedAt = Now.AddHours(-4),
            EndedAt = Now.AddHours(-3),
        };
        var endedLastWeek = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "Ended last week",
            Kind = "instant",
            Status = "ended",
            CreatedAt = Now.AddDays(-7),
            EndedAt = Now.AddDays(-7),
        };

        // Booked long ago for yesterday and never held: the reason Past
        // reaches for ScheduledStart before CreatedAt.
        var bookedLongAgoNeverHeld = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "Booked in January for yesterday, never held",
            Kind = "scheduled",
            Status = "scheduled",
            ScheduledStart = Now.AddDays(-1),
            CreatedAt = Now.AddDays(-250),
            EndedAt = null,
        };

        var order = Sort(
            new[] { endedLastWeek, endedThisMorning, bookedLongAgoNeverHeld }, "past");

        t.Ok("past is still latest-first",
            order.SequenceEqual(new[]
            {
                endedThisMorning.Title, bookedLongAgoNeverHeld.Title, endedLastWeek.Title,
            }));

        // The rule added for upcoming must not have leaked into past. An
        // 'active' meeting cannot reach the past filter at all — but if the
        // status expression were applied here a stray one would jump the list,
        // so assert the shape rather than trusting the filter upstream.
        //
        // Its dates are deliberately the OLDEST of the three. A live meeting
        // with today's dates would sort first here on its dates alone, and an
        // assertion that it does not would fail for a reason that has nothing
        // to do with status — which is what the first draft of this check did.
        var stray = new ConnectMeeting
        {
            Id = Guid.NewGuid(),
            Title = "An 'active' row that has no business being in past",
            Kind = "instant",
            Status = "active",
            CreatedAt = Now.AddDays(-30),
            StartedAt = Now.AddDays(-30),
        };
        var withStray = Sort(new[] { endedLastWeek, stray, endedThisMorning }, "past");
        t.Ok("past does not hoist an 'active' row out of date order",
            withStray.SequenceEqual(new[]
            {
                endedThisMorning.Title, endedLastWeek.Title, stray.Title,
            }));
    }
}

internal sealed class Harness
{
    public int Passed { get; private set; }
    public int Failed { get; private set; }
    public bool Quiet { get; set; }

    public void Section(string title)
    {
        if (Quiet) return;
        Console.WriteLine();
        Console.WriteLine($"  {title}");
    }

    public void Note(string text)
    {
        if (Quiet) return;
        Console.WriteLine($"        · {text}");
    }

    public void Ok(string what, bool passed)
    {
        if (passed)
        {
            Passed++;
            if (!Quiet) Console.WriteLine($"    ok  {what}");
        }
        else
        {
            Failed++;
            Console.WriteLine($"  FAIL  {what}");
        }
    }

    public int Report()
    {
        Console.WriteLine();
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");
        Console.WriteLine(Failed == 0
            ? $"  PASS  {Passed} assertions"
            : $"  FAIL  {Failed} of {Passed + Failed} assertions");
        Console.WriteLine();
        return Failed == 0 ? 0 : 1;
    }
}

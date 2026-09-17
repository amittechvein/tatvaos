using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Modules.Connect;

namespace TatvaOS.Tests.Invitations;

/// <summary>
/// Runs ConnectInvitations' rules against Calendar's real Imip.Build.
///
/// Usage:  dotnet run --project tests/connect-invitations
/// Exit:   0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    private const string Join = "https://connect.tatvaos.com/connect/room/abcDEF123";

    private static int Main()
    {
        var t = new Harness();

        Console.WriteLine();
        Console.WriteLine("  ConnectInvitations — who can be invited, and what they receive");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        WhatCountsAsAnAddress(t);
        TheCalendarFile(t);
        UpdatesAndCancels(t);
        TheEmailText(t);

        return t.Report();
    }

    private static ConnectMeeting Meeting() => new()
    {
        Id = Guid.Parse("01a0ae18-3df8-70e6-962a-b76e154c49cb"),
        TenantId = Guid.NewGuid(),
        Code = "abcDEF123",
        Title = "Quarterly review",
        Kind = "scheduled",
        // 09:30 UTC = 15:00 IST. Stored in UTC, like the real column.
        ScheduledStart = new DateTimeOffset(2026, 9, 18, 9, 30, 0, TimeSpan.Zero),
        ScheduledEnd = new DateTimeOffset(2026, 9, 18, 10, 30, 0, TimeSpan.Zero),
        Timezone = "Asia/Kolkata",
        AllowGuests = true,
    };

    private static void WhatCountsAsAnAddress(Harness t)
    {
        t.Section("Parse — what the host typed");
        var p = ConnectInvitations.Parse(["Ravi@Example.com, priya@example.co.in; sam@example.org\nravi@example.com"]);
        t.Ok("comma, semicolon and newline all separate", p.Valid.Count == 3);
        t.Ok("lower-cased", p.Valid[0] == "ravi@example.com");
        t.Ok("the same person twice is invited once", p.Valid.Count(v => v == "ravi@example.com") == 1);
        t.Ok("order kept", p.Valid.SequenceEqual(["ravi@example.com", "priya@example.co.in", "sam@example.org"]));

        var named = ConnectInvitations.Parse(["Ravi Kumar <ravi@example.com>"]);
        t.Ok("\"Name <address>\" becomes the address", named.Valid.SequenceEqual(["ravi@example.com"]) && named.Invalid.Count == 0);

        var spaced = ConnectInvitations.Parse(["a@example.com b@example.com"]);
        t.Ok("spaces separate bare addresses on one line", spaced.Valid.Count == 2);

        var typos = ConnectInvitations.Parse(["ravi", "ravi@gmail", "@example.com", "a@@example.com", "a@example..com", "priya@example.com"]);
        t.Ok("typos are REPORTED, not dropped (5 of them)", typos.Invalid.Count == 5);
        t.Ok("…and named back verbatim", typos.Invalid.Contains("ravi") && typos.Invalid.Contains("ravi@gmail"));
        t.Ok("the good one still gets through", typos.Valid.SequenceEqual(["priya@example.com"]));

        t.Ok("a display name cannot smuggle a second address",
            !ConnectInvitations.IsPlainAddress("\"x@evil.com\" <ravi@example.com>"));
        t.Ok("no whitespace inside", !ConnectInvitations.IsPlainAddress("ravi @example.com"));
        t.Ok("null and blank are nothing, not an error",
            ConnectInvitations.Parse(null).Valid.Count == 0 && ConnectInvitations.Parse(["  ", ""]).Invalid.Count == 0);
    }

    private static void TheCalendarFile(Harness t)
    {
        t.Section("the calendar file — one person, the right hour, the join link");
        var m = Meeting();
        // Unfolded: RFC 5545 wraps lines at 75 octets, and a check that reads
        // the folded text misses an address split across two lines.
        var ics = ConnectInvitations.BuildCalendar(m, Join, "ravi@example.com", "amit@techvein.com", "Amit Dadhich", Imip.MethodRequest)
            .Replace("\r\n ", "");

        t.Ok("METHOD:REQUEST", ics.Contains("METHOD:REQUEST"));
        t.Ok("stable UID for the meeting", ics.Contains("UID:connect-01a0ae18-3df8-70e6-962a-b76e154c49cb@tatvaos.com"));
        t.Ok("starts 09:30 UTC (= 15:00 IST)", ics.Contains("DTSTART:20260918T093000Z"));
        t.Ok("ends 10:30 UTC", ics.Contains("DTEND:20260918T103000Z"));
        t.Ok("the join link is in the file", ics.Replace("\r\n ", "").Contains(Join));
        t.Ok("organiser is the host's mailbox", ics.Contains("mailto:amit@techvein.com"));
        t.Ok("this invitee is an attendee", ics.Contains("mailto:ravi@example.com"));
        var attendees = ics.Split("\r\n").Count(l => l.StartsWith("ATTENDEE"));
        t.Ok("…and the ONLY attendee — nobody else's address travels", attendees == 1);
        t.Ok("SEQUENCE starts at 0", ics.Contains("SEQUENCE:0"));

        var noEnd = Meeting(); noEnd.ScheduledEnd = null;
        t.Ok("no end set: an hour", ConnectInvitations.EndOf(noEnd) == noEnd.ScheduledStart!.Value.AddHours(1));
        var backwards = Meeting(); backwards.ScheduledEnd = backwards.ScheduledStart!.Value.AddMinutes(-5);
        t.Ok("end before start: an hour, not a negative meeting", ConnectInvitations.EndOf(backwards) > backwards.ScheduledStart!.Value);

        var instant = Meeting(); instant.ScheduledStart = null; instant.Kind = "instant";
        t.Ok("an instant meeting has no calendar time", !ConnectInvitations.HasCalendarTime(instant));
    }

    private static void UpdatesAndCancels(Harness t)
    {
        t.Section("reschedule and cancel — replace the entry, never duplicate it");
        var m = Meeting();
        var first = ConnectInvitations.BuildCalendar(m, Join, "ravi@example.com", "amit@techvein.com", null, Imip.MethodRequest);
        m.InviteSequence = 1;
        m.ScheduledStart = m.ScheduledStart!.Value.AddHours(2);
        m.ScheduledEnd = m.ScheduledEnd!.Value.AddHours(2);
        var moved = ConnectInvitations.BuildCalendar(m, Join, "ravi@example.com", "amit@techvein.com", null, Imip.MethodRequest);

        string Uid(string s) => s.Split("\r\n").First(l => l.StartsWith("UID:"));
        t.Ok("same UID after a move (so it REPLACES)", Uid(first) == Uid(moved));
        t.Ok("higher SEQUENCE after a move (so it is not ignored)", moved.Contains("SEQUENCE:1"));
        t.Ok("the new time", moved.Contains("DTSTART:20260918T113000Z"));

        m.InviteSequence = 2;
        var cancel = ConnectInvitations.BuildCalendar(m, Join, "ravi@example.com", "amit@techvein.com", null, Imip.MethodCancel);
        t.Ok("METHOD:CANCEL", cancel.Contains("METHOD:CANCEL"));
        t.Ok("STATUS:CANCELLED in the event too", cancel.Contains("STATUS:CANCELLED"));
        t.Ok("same UID on cancel", Uid(cancel) == Uid(first));
        t.Ok("subject says Cancelled", ConnectInvitations.Subject(m, Imip.MethodCancel) == "Cancelled: Quarterly review");
        t.Ok("subject says Invitation", ConnectInvitations.Subject(m, Imip.MethodRequest) == "Invitation: Quarterly review");
    }

    private static void TheEmailText(Harness t)
    {
        t.Section("the email text — local time, and how to get in");
        var m = Meeting();
        var body = ConnectInvitations.BodyText(m, Join, "Amit Dadhich", "amit@techvein.com", Imip.MethodRequest, guestsAllowed: true);
        t.Note(ConnectInvitations.When(m) ?? "(no time)");
        t.Ok("time printed in IST, not the UTC clock (15:00, not 09:30)",
            body.Contains("18 Sep 2026, 15:00–16:00 (Asia/Kolkata)") && !body.Contains("09:30"));
        t.Ok("the join link", body.Contains("Join: " + Join));
        t.Ok("who invited them", body.StartsWith("Amit Dadhich invited you"));
        t.Ok("guests are told no account is needed", body.Contains("do not need a TatvaOS account"));

        var closed = ConnectInvitations.BodyText(m, Join, null, "amit@techvein.com", Imip.MethodRequest, guestsAllowed: false);
        t.Ok("guests not allowed: told to sign in instead", closed.Contains("sign in") && !closed.Contains("do not need"));
        t.Ok("no display name: the address stands in", closed.StartsWith("amit@techvein.com invited you"));

        var instant = Meeting(); instant.ScheduledStart = null;
        var ib = ConnectInvitations.BodyText(instant, Join, "Amit", "amit@techvein.com", Imip.MethodRequest, true);
        t.Ok("instant meeting: no When line, still the link", !ib.Contains("When:") && ib.Contains(Join));

        var cancelled = ConnectInvitations.BodyText(m, Join, "Amit", "amit@techvein.com", Imip.MethodCancel, true);
        t.Ok("cancel text says cancelled and gives no join link", cancelled.StartsWith("Cancelled:") && !cancelled.Contains("Join:"));

        var odd = Meeting(); odd.Timezone = "Not/AZone";
        t.Ok("an unknown zone falls back to UTC and SAYS UTC", ConnectInvitations.When(odd)!.EndsWith("(UTC)"));
    }
}

internal sealed class Harness
{
    public int Passed { get; private set; }
    public int Failed { get; private set; }

    public void Section(string title)
    {
        Console.WriteLine();
        Console.WriteLine($"  {title}");
    }

    public void Note(string text) => Console.WriteLine($"        · {text}");

    public void Ok(string what, bool passed)
    {
        if (passed)
        {
            Passed++;
            Console.WriteLine($"    ok  {what}");
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

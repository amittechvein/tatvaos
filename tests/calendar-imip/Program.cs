using System.Globalization;
using System.Text;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Tests.CalendarImip;

/// <summary>
/// Every rule in Imip.cs, against real client payloads.
///
/// Usage:  dotnet run --project tests/calendar-imip
/// Exit:   0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    private const string Uid = "tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31";

    private static int Main()
    {
        var t = new Harness();

        Console.WriteLine();
        Console.WriteLine("  Imip — iCalendar out, replies in");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        RunAll(t);

        // The same suite under cultures that break naive formatting. th-TH is
        // the Buddhist calendar — any DateTime through a culture-sensitive
        // ToString comes back 543 years out, and an invitation dated 2569
        // is rejected by every client on earth. de-DE swaps the decimal
        // separator. Imip pins InvariantCulture; this notices the day
        // somebody removes it.
        var repeated = 0;
        foreach (var name in new[] { "th-TH", "de-DE", "ar-SA" })
        {
            var before = t.Failed;
            t.Quiet = true;
            var previous = CultureInfo.CurrentCulture;
            CultureInfo.CurrentCulture = new CultureInfo(name);
            RunAll(t);
            CultureInfo.CurrentCulture = previous;
            t.Quiet = false;
            repeated++;
            if (t.Failed > before) Console.WriteLine($"  FAIL  the suite does not survive {name}");
        }
        Console.WriteLine($"        · every assertion repeated under {repeated} hostile cultures");

        Console.WriteLine("  ═════════════════════════════════════════════════════════════");
        Console.WriteLine($"  {t.Passed} ok, {t.Failed} failed");
        Console.WriteLine();
        return t.Failed == 0 ? 0 : 1;
    }

    private static void RunAll(Harness t)
    {
        Folding(t);
        Escaping(t);
        BuildShape(t);
        AllDay(t);
        Recurring(t);
        Cancellation(t);
        ParseRealClients(t);
        ParseRefusals(t);
        NothingThrows(t);
    }

    // ==================================================================
    private static void Folding(Harness t)
    {
        t.Section("folding is counted in octets");

        var ascii = "SUMMARY:" + new string('x', 200);
        var folded = Imip.Fold(ascii);
        t.Ok("a long ASCII line is folded", folded.Contains("\r\n "));
        t.Ok("no physical line exceeds 75 octets",
            folded.Split("\r\n").All(l => Encoding.UTF8.GetByteCount(l) <= 75));

        // The one that matters for our customers.
        var hindi = "SUMMARY:" + string.Concat(Enumerable.Repeat("परियोजना समीक्षा ", 12));
        var foldedHindi = Imip.Fold(hindi);
        t.Ok("Devanagari folds by BYTES, not characters",
            foldedHindi.Split("\r\n").All(l => Encoding.UTF8.GetByteCount(l) <= 75));
        t.Ok("and no character is split across a fold",
            Imip.Unfold(foldedHindi)[0] == hindi);
        t.Note("a 60-character Hindi title is 180 octets — the trap this catches");

        var emoji = "SUMMARY:" + string.Concat(Enumerable.Repeat("🎯", 40));
        var foldedEmoji = Imip.Fold(emoji);
        t.Ok("4-byte characters survive folding",
            Imip.Unfold(foldedEmoji)[0] == emoji);

        t.Ok("a short line is left alone", Imip.Fold("UID:abc") == "UID:abc");
        t.Ok("exactly 75 octets is not folded",
            !Imip.Fold(new string('a', 75)).Contains("\r\n"));
        t.Ok("76 octets is", Imip.Fold(new string('a', 76)).Contains("\r\n"));

        t.Section("unfolding reverses it");
        t.Ok("space continuation", Imip.Unfold("A:1\r\n cont")[0] == "A:1cont");
        t.Ok("tab continuation", Imip.Unfold("A:1\r\n\tcont")[0] == "A:1cont");
        t.Ok("round-trips arbitrary text",
            Imip.Unfold(Imip.Fold("DESCRIPTION:" + new string('z', 500)))[0]
                == "DESCRIPTION:" + new string('z', 500));
    }

    // ==================================================================
    private static void Escaping(Harness t)
    {
        t.Section("TEXT escaping — the right characters, and only those");

        t.Ok("backslash first, so it does not double the others",
            Imip.Escape(@"a\b") == @"a\\b");
        t.Ok("semicolon", Imip.Escape("a;b") == "a\\;b");
        t.Ok("comma — unescaped it truncates a LOCATION",
            Imip.Escape("Pune, Maharashtra") == "Pune\\, Maharashtra");
        t.Ok("newline becomes \\n", Imip.Escape("a\nb") == "a\\nb");
        t.Ok("CRLF becomes one \\n, not two", Imip.Escape("a\r\nb") == "a\\nb");
        t.Ok("bare CR too", Imip.Escape("a\rb") == "a\\nb");
        t.Ok("COLON IS NOT ESCAPED — https:// must survive",
            Imip.Escape("https://connect.tatvaos.com/x") == "https://connect.tatvaos.com/x");
        t.Ok("nothing to escape is unchanged", Imip.Escape("plain") == "plain");
    }

    // ==================================================================
    private static void BuildShape(Harness t)
    {
        t.Section("a REQUEST, as Gmail and Outlook need it");

        var ics = Imip.Build(Event(), [Attendee("riya@gmail.com", "Riya")],
            "amit@tatvaos.com", "Amit Dadhich", Imip.MethodRequest);

        t.Ok("CRLF everywhere — bare LF is rejected by Exchange",
            !ics.Replace("\r\n", "").Contains('\n'));
        t.Ok("ends with CRLF", ics.EndsWith("\r\n", StringComparison.Ordinal));

        var lines = Imip.Unfold(ics);
        t.Ok("METHOD:REQUEST in the body, matching the content-type parameter",
            lines.Contains("METHOD:REQUEST"));
        t.Ok("VERSION:2.0", lines.Contains("VERSION:2.0"));
        t.Ok("UID is the event's, unchanged", lines.Contains("UID:" + Uid));
        t.Ok("SEQUENCE is carried", lines.Contains("SEQUENCE:2"));
        t.Ok("DTSTAMP present", lines.Any(l => l.StartsWith("DTSTAMP:", StringComparison.Ordinal)));
        t.Ok("ORGANIZER as mailto", lines.Any(l => l.Contains("ORGANIZER") && l.Contains("mailto:amit@tatvaos.com")));
        t.Ok("RSVP=TRUE — this is what renders the buttons",
            lines.Any(l => l.StartsWith("ATTENDEE", StringComparison.Ordinal) && l.Contains("RSVP=TRUE")));
        t.Ok("PARTSTAT carried from our row",
            lines.Any(l => l.StartsWith("ATTENDEE", StringComparison.Ordinal) && l.Contains("PARTSTAT=NEEDS-ACTION")));
        t.Ok("ROLE mapped to the RFC spelling",
            lines.Any(l => l.Contains("ROLE=REQ-PARTICIPANT")));
        t.Ok("STATUS:CONFIRMED", lines.Contains("STATUS:CONFIRMED"));
        t.Ok("one-off events use UTC, so no VTIMEZONE is needed",
            !ics.Contains("BEGIN:VTIMEZONE") && lines.Any(l => l.StartsWith("DTSTART:", StringComparison.Ordinal) && l.EndsWith('Z')));

        t.Section("the Connect link reaches the recipient");
        var withMeeting = Imip.Build(Event(meetingUrl: "https://connect.tatvaos.com/j/abc"),
            [Attendee("riya@gmail.com", "Riya")], "amit@tatvaos.com", "Amit", Imip.MethodRequest);
        t.Ok("in LOCATION when there is no physical place",
            withMeeting.Contains("LOCATION:https://connect.tatvaos.com/j/abc"));
        t.Ok("and in DESCRIPTION as a joinable line",
            Imip.Unfold(withMeeting).Any(l => l.Contains("Join: https://connect.tatvaos.com/j/abc")));

        var withBoth = Imip.Build(Event(location: "Board room", meetingUrl: "https://connect.tatvaos.com/j/abc"),
            [Attendee("riya@gmail.com", "Riya")], "amit@tatvaos.com", "Amit", Imip.MethodRequest);
        t.Ok("a physical location wins LOCATION, link stays in DESCRIPTION",
            withBoth.Contains("LOCATION:Board room")
            && Imip.Unfold(withBoth).Any(l => l.Contains("Join: ")));

        t.Section("hostile text in a title cannot break the object");
        var nasty = Imip.Build(Event(title: "Q3: costs, margins; \"review\"\nsecond line"),
            [Attendee("riya@gmail.com", null)], "amit@tatvaos.com", null, Imip.MethodRequest);
        t.Ok("commas and semicolons escaped in SUMMARY",
            Imip.Unfold(nasty).Any(l => l.StartsWith("SUMMARY:", StringComparison.Ordinal)
                                     && l.Contains("\\,") && l.Contains("\\;")));
        t.Ok("the newline did not become a real line break",
            Imip.Unfold(nasty).Count(l => l.StartsWith("SUMMARY", StringComparison.Ordinal)) == 1);
        t.Ok("no CN parameter when there is no name",
            !Imip.Unfold(nasty).Any(l => l.Contains("CN=\"\"")));
    }

    // ==================================================================
    private static void AllDay(Harness t)
    {
        t.Section("all-day events");
        var ics = Imip.Build(Event(allDay: true), [Attendee("riya@gmail.com", "Riya")],
            "amit@tatvaos.com", "Amit", Imip.MethodRequest);
        var lines = Imip.Unfold(ics);

        t.Ok("DTSTART carries VALUE=DATE",
            lines.Any(l => l.StartsWith("DTSTART;VALUE=DATE:", StringComparison.Ordinal)));
        // Check the VALUE, not the line: "DTSTART;VALUE=DATE:" carries a T in
        // the property name and another in DATE, so asking whether the line
        // contains one always says yes. The first version of this assertion
        // did exactly that and failed against correct output.
        t.Ok("no time component in the value",
            lines.Where(l => l.StartsWith("DTSTART", StringComparison.Ordinal)
                          || l.StartsWith("DTEND", StringComparison.Ordinal))
                 .All(l => !l[(l.IndexOf(':') + 1)..].Contains('T')));
        t.Ok("DTEND also carries VALUE=DATE",
            lines.Any(l => l.StartsWith("DTEND;VALUE=DATE:", StringComparison.Ordinal)));
        t.Ok("no VTIMEZONE — a date has no zone", !ics.Contains("BEGIN:VTIMEZONE"));
    }

    // ==================================================================
    private static void Recurring(Harness t)
    {
        t.Section("recurring events carry TZID and a VTIMEZONE");
        var ics = Imip.Build(Event(rrule: "FREQ=WEEKLY;BYDAY=TU"),
            [Attendee("riya@gmail.com", "Riya")], "amit@tatvaos.com", "Amit", Imip.MethodRequest);
        var lines = Imip.Unfold(ics);

        t.Ok("RRULE passed through verbatim", lines.Contains("RRULE:FREQ=WEEKLY;BYDAY=TU"));
        t.Ok("VTIMEZONE emitted", ics.Contains("BEGIN:VTIMEZONE") && ics.Contains("END:VTIMEZONE"));
        t.Ok("TZID names the event's zone", lines.Any(l => l.Contains("TZID=Asia/Kolkata")));
        t.Ok("DTSTART is local wall time, not UTC — a weekly 10:00 stays 10:00",
            lines.Any(l => l.StartsWith("DTSTART;TZID=", StringComparison.Ordinal) && !l.EndsWith('Z')));
        t.Ok("a STANDARD component exists", ics.Contains("BEGIN:STANDARD"));
        t.Note("Asia/Kolkata has no DST, so one STANDARD block is the whole VTIMEZONE");

        t.Ok("an unknown zone falls back rather than throwing",
            Imip.Build(Event(rrule: "FREQ=DAILY", timezone: "Mars/Olympus"),
                [Attendee("a@b.c", null)], "amit@tatvaos.com", null, Imip.MethodRequest).Length > 0);
    }

    // ==================================================================
    private static void Cancellation(Harness t)
    {
        t.Section("CANCEL says so twice");
        var ics = Imip.Build(Event(), [Attendee("riya@gmail.com", "Riya")],
            "amit@tatvaos.com", "Amit", Imip.MethodCancel);
        var lines = Imip.Unfold(ics);

        t.Ok("METHOD:CANCEL", lines.Contains("METHOD:CANCEL"));
        t.Ok("STATUS:CANCELLED — clients that ignore the envelope still get it",
            lines.Contains("STATUS:CANCELLED"));
        t.Ok("same UID, so it cancels the right event", lines.Contains("UID:" + Uid));
    }

    // ==================================================================
    private static void ParseRealClients(Harness t)
    {
        t.Section("replies from clients people actually use");

        var gmail = Imip.ParseReply(Fixtures.GmailAccept);
        t.Ok("Gmail accept is read", gmail is not null);
        t.Ok("  UID", gmail?.Uid == Uid);
        t.Ok("  PARTSTAT normalised to our spelling", gmail?.PartStat == "accepted");
        t.Ok("  address survives a fold INSIDE the mailto", gmail?.AttendeeEmail == "riya.sharma@gmail.com");
        t.Ok("  SEQUENCE 0", gmail?.Sequence == 0);
        t.Note("Gmail folds at 75 octets wherever it lands — mid-address included");

        var outlook = Imip.ParseReply(Fixtures.OutlookDeclineEchoesEveryone);
        t.Ok("Outlook decline is read", outlook is not null);
        t.Ok("  THE REPLIER is taken, not the echoed list",
            outlook?.AttendeeEmail == "vikram@contoso.com");
        t.Ok("  and their answer, not a stale NEEDS-ACTION", outlook?.PartStat == "declined");
        t.Ok("  SEQUENCE 3 is carried for the staleness check", outlook?.Sequence == 3);
        t.Note("reading the wrong ATTENDEE here overwrites a third party's answer");

        var apple = Imip.ParseReply(Fixtures.AppleTentativeNoSequence);
        t.Ok("Apple tentative is read", apple is not null);
        t.Ok("  absent SEQUENCE means 0, per RFC 5545", apple?.Sequence == 0);
        t.Ok("  tentative", apple?.PartStat == "tentative");

        var occurrence = Imip.ParseReply(Fixtures.ReplyForOneOccurrence);
        t.Ok("a per-occurrence reply is parsed", occurrence is not null);
        t.Ok("  and RECURRENCE-ID is surfaced so the sink can refuse it",
            occurrence?.RecurrenceId is not null);
    }

    // ==================================================================
    private static void ParseRefusals(Harness t)
    {
        t.Section("what must NOT be read as an answer");

        t.Ok("a REQUEST is not a reply",
            Imip.ParseReply(Fixtures.NotAReplyItIsARequest) is null);
        t.Ok("a payload with no ATTENDEE",
            Imip.ParseReply(Fixtures.NoAttendee) is null);

        var delegated = Imip.ParseReply(Fixtures.Delegated);
        t.Ok("DELEGATED parses", delegated is not null);
        t.Ok("  but is NOT recorded as acceptance", delegated?.PartStat == "needs-action");
        t.Note("saying someone is coming when they handed it on is the worst possible answer");
    }

    // ==================================================================
    private static void NothingThrows(Harness t)
    {
        t.Section("nothing in real mail can throw");
        foreach (var (name, payload) in Fixtures.Hostile)
        {
            var threw = false;
            try { Imip.ParseReply(payload); }
            catch { threw = true; }
            t.Ok($"survives: {name}", !threw);
        }
        t.Note($"{Fixtures.Hostile.Length} malformed payloads, no exception from any");
    }

    // ==================================================================
    private static CalendarEvent Event(
        string title = "Project review",
        string? location = null,
        string? meetingUrl = null,
        string? rrule = null,
        bool allDay = false,
        string timezone = "Asia/Kolkata") => new()
        {
            Uid = Uid,
            Sequence = 2,
            Title = title,
            Location = location,
            MeetingUrl = meetingUrl,
            RecurrenceRule = rrule,
            IsAllDay = allDay,
            Timezone = timezone,
            StartsAt = new DateTimeOffset(2026, 8, 25, 4, 30, 0, TimeSpan.Zero),
            EndsAt = new DateTimeOffset(2026, 8, 25, 5, 30, 0, TimeSpan.Zero),
        };

    private static CalendarAttendee Attendee(string email, string? name) => new()
    {
        Email = email,
        DisplayName = name,
    };
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
}

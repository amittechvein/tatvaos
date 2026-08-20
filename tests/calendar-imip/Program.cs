using System.Globalization;
using System.Text;
using MimeKit;
using TatvaOS.Api.Modules.Calendar;
#if HAS_MAIL_CARRIAGE
using TatvaOS.Api.Modules.Mail;
#endif
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
        RealCarriage(t);
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
    //  THE REAL CARRIAGE — Mail's assembly, not one built here
    // ==================================================================
    //
    //  Everything above tests the payload. This tests the MESSAGE, and it
    //  calls MAIL'S InvitationBody.TryBuild to build it — the same method
    //  SubmitAsync calls in production. Assembling one here instead would
    //  prove this test correct and the shipping code untested, which is the
    //  two-implementations problem that put a duplicate endpoint client on
    //  main earlier the same day.
    // ==================================================================
    private static void RealCarriage(Harness t)
    {
#if !HAS_MAIL_CARRIAGE
        // Skipped LOUDLY. Mail's InvitationBody.cs is not in this checkout —
        // it is on Mail's branch and has not merged yet. Printing this beats
        // a suite that silently drops a section and still says "all ok".
        t.Section("the carriage Mail actually ships — SKIPPED");
        t.Note("apps/api/Modules/Mail/InvitationBody.cs is not in this checkout");
        t.Note("it lives on Mail's branch; after the merge this section runs by itself");
#else
        t.Section("the carriage Mail actually ships");

        var ical = Imip.Build(Event(), [Attendee("riya@gmail.com", "Riya")],
            "amit@tatvaos.com", "Amit Dadhich", Imip.MethodRequest);

        var (body, refusal) = InvitationBody.TryBuild(
            "Project review, Tuesday.", "<p>Project review, Tuesday.</p>", ical, Imip.MethodRequest);

        t.Ok("a good submission assembles", body is not null);
        t.Ok("  and is not refused", refusal is null);

        if (body is null)
        {
            t.Ok($"  [refused: {refusal}]", false);
            return;
        }

        var message = new MimeMessage { Body = body };
        var problems = ImipStructure.Check(message, Imip.MethodRequest);

        t.Ok("ImipStructure finds no fault in it", problems.Count == 0);
        foreach (var problem in problems) t.Ok($"  PROBLEM: {problem}", false);

        // The thing Mail asked to have measured rather than assumed: MimeKit
        // chooses the alternative part's encoding, and "it picks something
        // that survives" was the last unverified assertion in that half.
        var alternative = message.BodyParts.OfType<TextPart>()
            .FirstOrDefault(p => p.ContentType.IsMimeType("text", "calendar"));
        if (alternative is not null)
            t.Note($"MimeKit chose {alternative.ContentTransferEncoding} for the alternative part");

        // ── AND AGAIN, THROUGH THE WIRE ────────────────────────────────
        //
        //  Everything above inspects the object graph Mail built. Gmail never
        //  sees that graph; it sees BYTES. MimeKit chooses transfer encodings
        //  at WRITE time, so the encoding question cannot be answered by
        //  looking at the object at all — and a payload that survives in
        //  memory but is mangled on serialisation would pass every assertion
        //  above and still fail at the customer.
        //
        //  So: write it out, parse it back, check the parsed result. This is
        //  the closest this suite gets to a real send.
        // ────────────────────────────────────────────────────────────────
        t.Section("and again after a round trip through the wire format");

        using var wire = new MemoryStream();
        message.WriteTo(wire);
        wire.Position = 0;
        var delivered = MimeMessage.Load(wire);

        var afterWire = ImipStructure.Check(delivered, Imip.MethodRequest);
        t.Ok("the serialised-and-reparsed message is still correct", afterWire.Count == 0);
        foreach (var problem in afterWire) t.Ok($"  PROBLEM: {problem}", false);

        var wireText = Encoding.UTF8.GetString(wire.ToArray());
        t.Ok("the message on the wire has no bare LF",
            !wireText.Replace("\r\n", "").Contains('\n'));

        var deliveredCalendar = delivered.BodyParts.OfType<TextPart>()
            .FirstOrDefault(p => p.ContentType.IsMimeType("text", "calendar"));
        if (deliveredCalendar is not null)
        {
            t.Note($"ON THE WIRE the alternative part is {deliveredCalendar.ContentTransferEncoding}");

            // MimePart.Content is nullable. This is the SAME dereference I had
            // just fixed in ImipStructure.cs and then wrote again here within
            // the hour — which is the argument for compiling, not for being
            // more careful. Being more careful is what I was already doing.
            t.Ok("the alternative part has a body at all", deliveredCalendar.Content is not null);
            if (deliveredCalendar.Content is { } content)
            {
                using var payload = new MemoryStream();
                content.DecodeTo(payload);
                t.Ok("and the payload comes back BYTE FOR BYTE what Calendar produced",
                    Encoding.UTF8.GetString(payload.ToArray()) == InvitationBody.Crlf(ical));
            }
        }

        var attachment = delivered.BodyParts.OfType<MimePart>()
            .FirstOrDefault(p => (p.FileName ?? "").EndsWith(".ics", StringComparison.Ordinal));
        if (attachment is not null)
            t.Note($"the attachment is {attachment.ContentTransferEncoding}, {attachment.ContentType.MimeType}");

        // A header that disagrees with the body renders as an invitation and
        // cancels the meeting — the worst of both. It cannot happen today
        // because Calendar writes both from one argument, which is exactly
        // why the guard is worth having: it notices when that stops being true.
        t.Section("a header that disagrees with the body is refused");
        var (mismatched, why) = InvitationBody.TryBuild(
            "x", "<p>x</p>", ical, Imip.MethodCancel);
        t.Ok("no body is returned", mismatched is null);
        t.Ok("a reason is", why is not null);
        t.Note("asserting a reason EXISTS, never its wording - Mail should be able to improve the sentence");

        // ── THE PUNE TEST, APPLIED ─────────────────────────────────────
        //
        //  Everything above used an English title, so it measured the
        //  encoding without proving anything survives it. That gap is the
        //  one that matters here: a Devanagari title is 8-bit UTF-8, three
        //  bytes a character, and it is the live case for our customers
        //  while ASCII is the case we happen to type.
        //
        //  Mail set QuotedPrintable explicitly on the calendar part after
        //  this argument. This is the assertion that the choice was right,
        //  rather than the note that a choice was made.
        // ────────────────────────────────────────────────────────────────
        t.Section("a Hindi meeting title survives the whole carriage");

        const string hindi = "परियोजना समीक्षा — तिमाही बैठक, पुणे";
        var hindiIcal = Imip.Build(Event(title: hindi),
            [Attendee("riya@gmail.com", "रिया")],
            "amit@tatvaos.com", "अमित", Imip.MethodRequest);

        var (hindiBody, hindiRefusal) = InvitationBody.TryBuild(
            "परियोजना समीक्षा", "<p>परियोजना समीक्षा</p>", hindiIcal, Imip.MethodRequest);

        t.Ok("it assembles", hindiBody is not null && hindiRefusal is null);
        if (hindiBody is not null)
        {
            var hindiMessage = new MimeMessage { Body = hindiBody };
            using var hindiWire = new MemoryStream();
            hindiMessage.WriteTo(hindiWire);
            hindiWire.Position = 0;
            var hindiDelivered = MimeMessage.Load(hindiWire);

            var hindiProblems = ImipStructure.Check(hindiDelivered, Imip.MethodRequest);
            t.Ok("and is structurally correct after the wire round trip", hindiProblems.Count == 0);
            foreach (var problem in hindiProblems) t.Ok($"  PROBLEM: {problem}", false);

            var part = hindiDelivered.BodyParts.OfType<TextPart>()
                .FirstOrDefault(p => p.ContentType.IsMimeType("text", "calendar"));
            t.Ok("the calendar part came back", part is not null);

            if (part?.Content is { } hindiContent)
            {
                t.Note($"encoded as {part.ContentTransferEncoding}");

                using var decoded = new MemoryStream();
                hindiContent.DecodeTo(decoded);
                var text = Encoding.UTF8.GetString(decoded.ToArray());

                t.Ok("BYTE FOR BYTE what Calendar produced",
                    text == InvitationBody.Crlf(hindiIcal));
                t.Ok("the Devanagari title is still readable in the payload",
                    text.Contains("परियोजना", StringComparison.Ordinal));
                t.Ok("no line exceeds 75 OCTETS after assembly",
                    text.Split("\r\n").All(l => Encoding.UTF8.GetByteCount(l) <= 75));
                // Compared against the ESCAPED title, not the raw one. The
                // title contains a comma, and RFC 5545 escapes commas inside
                // a TEXT value - so the payload correctly contains
                // "बैठक\, पुणे" and never the raw string. The first version of
                // this line asserted the raw form and failed against correct
                // output: my assertion, not Mail's code, and the third time
                // this week a test of mine was wrong rather than the thing it
                // tested. Worth the comment: an assertion that is wrong in the
                // strict direction wastes an afternoon, and one that is wrong
                // in the lax direction is never noticed at all.
                t.Ok("and no character was split across a fold",
                    string.Join("", Imip.Unfold(text)).Contains(Imip.Escape(hindi),
                        StringComparison.Ordinal));
            }
        }
#endif
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

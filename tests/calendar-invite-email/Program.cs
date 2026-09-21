using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Tests.CalendarInviteEmail;

/// <summary>
/// The designed HTML body of a calendar invitation and a cancellation
/// (Modules/Calendar/CalendarInviteEmail.cs).
///
/// Amit, 21 Sept 2026, on a Gmail invitation whose body was four bare lines:
/// "need good design of invitation".
///
/// Usage:   dotnet run --project tests/calendar-invite-email
///          CAL_PREVIEW_DIR=<dir> dotnet run --project tests/calendar-invite-email
///            also writes the emails as .html so a person can LOOK at them.
/// Exit:    0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    private static int passed, failed;

    private static void Ok(string what, bool ok)
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}"); }
    }

    private const string Base = "https://core.tatvaos.com";

    private static CalendarEvent Event(string title, string? location, string? url, string? description) => new()
    {
        Uid = "u-1",
        Title = title,
        Location = location,
        MeetingUrl = url,
        Description = description,
        Timezone = "Asia/Kolkata",
        StartsAt = new DateTimeOffset(2026, 9, 21, 9, 30, 0, TimeSpan.Zero),
        EndsAt = new DateTimeOffset(2026, 9, 21, 10, 30, 0, TimeSpan.Zero),
    };

    private static List<CalendarAttendee> Guests(int n) => Enumerable.Range(1, n)
        .Select(i => new CalendarAttendee { Email = $"guest{i}@example.com", DisplayName = i == 1 ? "Ravi Kumar" : null })
        .ToList();

    private static int Main()
    {
        var ist = TimeSpan.FromHours(5.5);
        var s = new DateTimeOffset(2026, 9, 21, 15, 0, 0, ist);
        var e = new DateTimeOffset(2026, 9, 21, 16, 0, 0, ist);

        var ev = Event("Quarterly review <b>& plans</b>", "Board room, 3rd floor", "https://connect.tatvaos.com/m/abc-def",
                       "Agenda:\nNumbers\nHiring");
        var invite = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(ev, s, e, "Amit Dadhich", Guests(3), cancelled: false, Base);
        var cancel = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(ev, s, e, "Amit Dadhich", Guests(3), cancelled: true, Base);
        var many = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(Event("Town hall", "https://meet.example.com/x", null, null),
                                            s, e, "Amit", Guests(12), cancelled: false, Base);
        var nameless = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(Event("n", null, null, null), s, e, "Amit",
            Enumerable.Range(1, 3).Select(i => new CalendarAttendee { Email = $"p{i}@example.com" }).ToList(), cancelled: false, Base);
        var tenNamed = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(Event("t", null, null, null), s, e, "Amit",
            Enumerable.Range(1, 10).Select(i => new CalendarAttendee { Email = $"p{i}@example.com", DisplayName = $"Person {i}" }).ToList(), cancelled: false, Base);
        var lookalike = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(Event("l", null, "https://гoogle.com/meet", null), s, e, "Amit", Guests(1), cancelled: false, Base);
        var hostile = TatvaOS.Api.Modules.Calendar.CalendarInviteEmail.Html(Event("x", "javascript:alert(1)", "javascript:alert(2)", null),
                                               s, e, "Amit", Guests(1), cancelled: false, Base);

        Console.WriteLine();
        Console.WriteLine("  Calendar invitation email");
        Console.WriteLine("  ==========================");

        Console.WriteLine();
        Console.WriteLine("  The invitation");
        Ok("brand header with the Calendar logo", invite.Contains($"src=\"{Base}/brand/calendar-logo.png\"") && invite.Contains("TatvaOS Calendar"));
        Ok("chip says Invitation", invite.Contains(">Invitation</span>"));
        Ok("the title, HTML-ENCODED (a typed <b> is text, not markup)", invite.Contains("Quarterly review &lt;b&gt;&amp; plans&lt;/b&gt;") && !invite.Contains("<b>& plans"));
        Ok("who invited you", invite.Contains("Amit Dadhich has invited you to this event."));
        Ok("date tile: SEP / 21 / MON", invite.Contains(">SEP</td>") && invite.Contains(">21</td>") && invite.Contains(">MON</td>"));
        Ok("time printed in the EVENT's zone (15:00, not the UTC 09:30)", invite.Contains("15:00 – 16:00") && !invite.Contains("09:30"));
        Ok("the full date in words", invite.Contains("Monday, 21 September 2026"));
        Ok("where", invite.Contains("Board room, 3rd floor"));
        Ok("a Join button to the meeting link", invite.Contains("href=\"https://connect.tatvaos.com/m/abc-def\"") && invite.Contains("Join the meeting"));
        Ok("description kept, line breaks kept", invite.Contains("Agenda:<br>Numbers<br>Hiring"));
        Ok("guests: names only, unnamed guests COUNTED (Mr. Singh, 22 Sept)", invite.Contains("Ravi Kumar and 2 others"));
        Ok("NO guest address anywhere in the body", !invite.Contains("@example.com") && !cancel.Contains("@example.com"));
        Ok("the Join destination is shown as a host", invite.Contains("Opens <strong") && invite.Contains(">connect.tatvaos.com</strong>"));
        Ok("says how to answer, and that no link here answers", invite.Contains("Yes, No or Maybe buttons"));
        Ok("no unfilled template hole", !invite.Contains("{") && !cancel.Contains("{"));

        Console.WriteLine();
        Console.WriteLine("  The cancellation");
        Ok("chip says Cancelled", cancel.Contains(">Cancelled</span>"));
        Ok("title struck through", cancel.Contains("text-decoration:line-through"));
        Ok("says it is cancelled, by whom", cancel.Contains("Amit Dadhich has cancelled this event."));
        Ok("NO join button on a cancelled event", !cancel.Contains("Join the meeting"));
        Ok("no agenda on a cancelled event", !cancel.Contains("Agenda:"));

        Console.WriteLine();
        Console.WriteLine("  Edges");
        Ok("twelve guests, one named: 'Ravi Kumar and 11 others', no addresses", many.Contains("Ravi Kumar and 11 others") && !many.Contains("@example.com"));
        Ok("no named guests at all: just a count", nameless.Contains(">3 guests</td>"));
        Ok("eight names shown, the rest counted", tenNamed.Contains("Person 8 and 2 others") && !tenNamed.Contains("Person 9"));
        Ok("a look-alike Unicode host is shown in its xn-- form", lookalike.Contains(">xn--"));
        Ok("a web address in Where becomes a link", many.Contains("href=\"https://meet.example.com/x\""));
        Ok("no meeting link, no Join button", !many.Contains("Join the meeting"));
        Ok("a javascript: Where or link NEVER becomes a link", !hostile.Contains("href=\"javascript") && !hostile.Contains("Join the meeting"));

        Console.WriteLine();
        Console.WriteLine("  One message per guest (Amit, 22 Sept): each copy names only its guest");
        var all = new List<CalendarAttendee>
        {
            new() { Email = "Amit@Techvein.com", DisplayName = "Amit" },          // the organiser's own row
            new() { Email = "parent1@example.com", DisplayName = "Parent One" },
            new() { Email = "parent2@example.com", DisplayName = "Parent Two" },
            new() { Email = "parent3@example.com" },
        };
        var copy = Imip.AttendeesForCopy(all, "amit@techvein.com", "PARENT2@example.com");
        Ok("copy names exactly two: the organiser and that guest", copy.Count == 2
            && copy.Any(a => a.Email == "parent2@example.com") && copy.Any(a => a.Email == "Amit@Techvein.com"));
        var ics = Imip.Build(ev, copy, "amit@techvein.com", "Amit", Imip.MethodRequest);
        Ok("its calendar part: parent2 is an ATTENDEE", ics.Contains("mailto:parent2@example.com"));
        Ok("its calendar part: NO other parent's address", !ics.Contains("parent1@") && !ics.Contains("parent3@"));
        Ok("its calendar part: the organiser is still ORGANIZER", ics.Contains("ORGANIZER") && ics.Contains("mailto:amit@techvein.com"));
        Ok("same UID as everyone else's copy, so one event in every calendar", ics.Contains("UID:u-1"));
        var copy1 = Imip.AttendeesForCopy(all, "amit@techvein.com", "parent1@example.com");
        Ok("a different guest's copy does not name parent2", !Imip.Build(ev, copy1, "amit@techvein.com", "Amit", Imip.MethodRequest).Contains("parent2@"));

        if (Environment.GetEnvironmentVariable("CAL_PREVIEW_DIR") is { Length: > 0 } dir)
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "3-calendar-invitation.html"), invite);
            File.WriteAllText(Path.Combine(dir, "4-calendar-cancelled.html"), cancel);
            Console.WriteLine();
            Console.WriteLine($"  preview written to {dir}");
        }

        Console.WriteLine();
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed} assertions");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;
    }
}

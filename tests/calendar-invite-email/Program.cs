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
        Ok("guests named, display name first", invite.Contains("Ravi Kumar, guest2@example.com, guest3@example.com"));
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
        Ok("twelve guests: eight named, then 'and 4 more'", many.Contains("guest8@example.com and 4 more") && !many.Contains("guest9@"));
        Ok("a web address in Where becomes a link", many.Contains("href=\"https://meet.example.com/x\""));
        Ok("no meeting link, no Join button", !many.Contains("Join the meeting"));
        Ok("a javascript: Where or link NEVER becomes a link", !hostile.Contains("href=\"javascript") && !hostile.Contains("Join the meeting"));

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

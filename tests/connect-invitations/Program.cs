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
        TheDesignedEmail(t);
        TheUpdateSaysWhatChanged(t);
        TheCapsPerOrganisation(t);

        // A look, not a test: INVITE_PREVIEW_DIR=<dir> writes the three emails
        // as .html so a person can see them before anyone receives one. Asserts
        // prove the parts are there; only eyes prove it looks right.
        if (Environment.GetEnvironmentVariable("INVITE_PREVIEW_DIR") is { Length: > 0 } dir)
        {
            Directory.CreateDirectory(dir);
            var m = Meeting(); m.Title = "Curriculum discussion for B2C";
            var prev = new ConnectInvitations.Previous(m.Title, m.ScheduledStart, m.ScheduledEnd);
            var moved = Meeting(); moved.Title = m.Title;
            moved.ScheduledStart = m.ScheduledStart!.Value.AddHours(2); moved.ScheduledEnd = m.ScheduledEnd!.Value.AddHours(2);
            File.WriteAllText(Path.Combine(dir, "1-invitation.html"),
                ConnectInvitations.BodyHtml(m, Join, "Amit Dadhich", "amit@tatvaos.com", Imip.MethodRequest, true));
            File.WriteAllText(Path.Combine(dir, "2-time-changed.html"),
                ConnectInvitations.BodyHtml(moved, Join, "Amit Dadhich", "amit@tatvaos.com", Imip.MethodRequest, true, prev));
            File.WriteAllText(Path.Combine(dir, "3-cancelled.html"),
                ConnectInvitations.BodyHtml(m, Join, "Amit Dadhich", "amit@tatvaos.com", Imip.MethodCancel, true));
            Console.WriteLine($"  preview written to {dir}");
        }

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

    /// <summary>
    /// 19 Sept 2026: the caps differ by organisation, set by the operator. What is
    /// proved here is what the stored numbers MEAN and which ones are refused;
    /// that the endpoint reads them is proved by running it, not here.
    /// </summary>
    private static void TheCapsPerOrganisation(Harness t)
    {
        Console.WriteLine();
        Console.WriteLine("  The caps, per organisation");

        var none = ConnectInvitations.EffectiveCaps(null, null);
        t.Ok("an organisation given no numbers gets the defaults",
            none.PerRequest == ConnectInvitations.MaxPerRequest && none.PerMeeting == ConnectInvitations.MaxPerMeeting);

        var own = ConnectInvitations.EffectiveCaps(20, 1000);
        t.Ok("its own numbers win, below the default and above it", own.PerRequest == 20 && own.PerMeeting == 1000);

        var onlyMeeting = ConnectInvitations.EffectiveCaps(null, 100);
        t.Ok("only 'per meeting' set low: one send is brought down to it, not left at the default",
            onlyMeeting.PerRequest == 100 && onlyMeeting.PerMeeting == 100);

        var onlyRequest = ConnectInvitations.EffectiveCaps(50, null);
        t.Ok("only 'per send' set: per meeting stays the default",
            onlyRequest.PerRequest == 50 && onlyRequest.PerMeeting == ConnectInvitations.MaxPerMeeting);

        t.Ok("two empties are storable", ConnectInvitations.CapProblem(null, null) is null);
        t.Ok("the ceiling itself is storable",
            ConnectInvitations.CapProblem(ConnectInvitations.CapCeiling, ConnectInvitations.CapCeiling) is null);
        t.Ok("zero per send is refused", ConnectInvitations.CapProblem(0, null) is not null);
        t.Ok("a negative per meeting is refused", ConnectInvitations.CapProblem(null, -5) is not null);
        t.Ok("one over the ceiling is refused, either number",
            ConnectInvitations.CapProblem(ConnectInvitations.CapCeiling + 1, null) is not null
            && ConnectInvitations.CapProblem(null, ConnectInvitations.CapCeiling + 1) is not null);
        t.Ok("per send above per meeting is refused, and says both numbers",
            ConnectInvitations.CapProblem(300, 200) is string both && both.Contains("300") && both.Contains("200"));
        t.Ok("per send above the DEFAULT per meeting is refused when per meeting is empty",
            ConnectInvitations.CapProblem(ConnectInvitations.MaxPerMeeting + 1, null) is not null);
        t.Ok("the ceiling is not below the defaults",
            ConnectInvitations.CapCeiling >= ConnectInvitations.MaxPerMeeting
            && ConnectInvitations.MaxPerMeeting >= ConnectInvitations.MaxPerRequest);
    }

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
        var ics = ConnectInvitations.BuildCalendar(m, Join, "ravi@example.com", "amit@techvein.com", "Amit Dadhich", Imip.MethodRequest, 0)
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
        string Build(int seq, string method) =>
            ConnectInvitations.BuildCalendar(m, Join, "ravi@example.com", "amit@techvein.com", null, method, seq);
        string Uid(string s) => s.Split("\r\n").First(l => l.StartsWith("UID:"));

        var first = Build(ConnectInvitations.SequenceFor(m, null), Imip.MethodRequest);
        t.Ok("first message to a person: SEQUENCE 0", first.Contains("SEQUENCE:0"));

        m.InviteSequence = 1;
        m.ScheduledStart = m.ScheduledStart!.Value.AddHours(2);
        m.ScheduledEnd = m.ScheduledEnd!.Value.AddHours(2);
        var moved = Build(ConnectInvitations.SequenceFor(m, 0), Imip.MethodRequest);
        t.Ok("same UID after a move (so it REPLACES)", Uid(first) == Uid(moved));
        t.Ok("higher SEQUENCE after a move (so it is not ignored)", moved.Contains("SEQUENCE:1"));
        t.Ok("the new time", moved.Contains("DTSTART:20260918T113000Z"));

        m.InviteSequence = 2;
        var cancel = Build(ConnectInvitations.SequenceFor(m, 1), Imip.MethodCancel);
        t.Ok("METHOD:CANCEL", cancel.Contains("METHOD:CANCEL"));
        t.Ok("STATUS:CANCELLED in the event too", cancel.Contains("STATUS:CANCELLED"));
        t.Ok("same UID on cancel", Uid(cancel) == Uid(first));
        t.Ok("subject says Cancelled", ConnectInvitations.Subject(m, Imip.MethodCancel) == "Cancelled: Quarterly review");
        t.Ok("subject says Invitation", ConnectInvitations.Subject(m, Imip.MethodRequest) == "Invitation: Quarterly review");

        t.Section("SequenceFor — withdraw, then invite the same person again (CTO condition 3)");
        var w = Meeting();                         // meeting never changed: InviteSequence 0
        var invited = ConnectInvitations.SequenceFor(w, null);        // REQUEST
        var withdrawn = ConnectInvitations.SequenceFor(w, invited);   // CANCEL to that person only
        var reinvited = ConnectInvitations.SequenceFor(w, withdrawn); // REQUEST again
        t.Note($"invite {invited}, withdraw {withdrawn}, re-invite {reinvited}; meeting stays at {w.InviteSequence}");
        t.Ok("the CANCEL is above the REQUEST it cancels", withdrawn > invited);
        t.Ok("the re-invite is above the CANCEL they hold (else their calendar ignores it)", reinvited > withdrawn);
        t.Ok("withdrawing one person does not move the meeting's SEQUENCE for everyone else", w.InviteSequence == 0);

        var ahead = Meeting(); ahead.InviteSequence = 5;
        t.Ok("never below the meeting's SEQUENCE (someone invited after two moves)", ConnectInvitations.SequenceFor(ahead, null) == 5);
        t.Ok("a person ahead of the meeting still goes up", ConnectInvitations.SequenceFor(ahead, 7) == 8);
    }

    private static void TheEmailText(Harness t)
    {
        t.Section("the email text — local time, and how to get in");
        var m = Meeting();
        var body = ConnectInvitations.BodyText(m, Join, "Amit Dadhich", "amit@techvein.com", Imip.MethodRequest, guestsAllowed: true);
        t.Note(ConnectInvitations.When(m) ?? "(no time)");
        t.Ok("time printed in IST, not the UTC clock (15:00, not 09:30)",
            body.Contains("18 Sep 2026, 15:00–16:00 (IST)") && !body.Contains("09:30"));
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

    private static void TheDesignedEmail(Harness t)
    {
        t.Section("the designed email (Amit: \"give some modern UI design, not simple text\")");
        var m = Meeting();
        var html = ConnectInvitations.BodyHtml(m, Join, "Amit Dadhich", "amit@techvein.com", Imip.MethodRequest, guestsAllowed: true);
        t.Ok("a Join button that links to the meeting", html.Contains($"href=\"{Join}\"") && html.Contains(">Join meeting</a>"));
        t.Ok("the date as a person reads it", html.Contains("Friday, 18 September 2026"));
        t.Ok("the time in IST", html.Contains("3:00 PM – 4:00 PM IST"));
        t.Ok("IST, not the database name of the zone", !html.Contains("Asia/Kolkata") && !html.Contains("Asia/Calcutta"));
        t.Ok("who invited them", html.Contains("Amit Dadhich invited you to a meeting"));
        t.Ok("inline styles only: no <style> block Gmail would strip", !html.Contains("<style"));
        t.Ok("the logo has a size and empty alt, so a blocked image leaves no broken box",
            html.Contains("connect-logo.png\" width=\"28\" height=\"28\" alt=\"\""));

        var nasty = Meeting(); nasty.Title = "<script>alert(1)</script> & \"Q3\"";
        var hn = ConnectInvitations.BodyHtml(nasty, Join, "<b>Eve</b>", "eve@example.com", Imip.MethodRequest, true);
        t.Ok("a title with markup arrives as text, not markup", !hn.Contains("<script>") && hn.Contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Q3&quot;"));
        t.Ok("a name with markup arrives as text", !hn.Contains("<b>Eve</b>") && hn.Contains("&lt;b&gt;Eve&lt;/b&gt;"));

        var closed = ConnectInvitations.BodyHtml(m, Join, "Amit", "amit@techvein.com", Imip.MethodRequest, guestsAllowed: false);
        t.Ok("guests not allowed: told to sign in", closed.Contains("sign in to TatvaOS"));

        var cancel = ConnectInvitations.BodyHtml(m, Join, "Amit", "amit@techvein.com", Imip.MethodCancel, true);
        t.Ok("cancelled: says so, and offers no Join button", cancel.Contains(">Cancelled</div>") && !cancel.Contains("Join meeting"));

        var instant = Meeting(); instant.ScheduledStart = null;
        var hi = ConnectInvitations.BodyHtml(instant, Join, "Amit", "amit@techvein.com", Imip.MethodRequest, true);
        t.Ok("instant meeting: no date block, still the button", !hi.Contains("September") && hi.Contains("Join meeting"));
    }

    private static void TheUpdateSaysWhatChanged(Harness t)
    {
        t.Section("an update says what changed (Amit: \"time change mail but there is no written that time is change\")");
        var before = Meeting();
        var prev = new ConnectInvitations.Previous(before.Title, before.ScheduledStart, before.ScheduledEnd);
        var m = Meeting();
        m.ScheduledStart = m.ScheduledStart!.Value.AddHours(2);
        m.ScheduledEnd = m.ScheduledEnd!.Value.AddHours(2);

        t.Ok("a first invitation has nothing changed", ConnectInvitations.Changes(m, null).Count == 0);
        t.Ok("subject: Updated", ConnectInvitations.Subject(m, Imip.MethodRequest, prev) == "Updated: Quarterly review");
        t.Ok("subject stays Invitation when nothing a recipient sees changed",
            ConnectInvitations.Subject(before, Imip.MethodRequest, prev) == "Invitation: Quarterly review");

        var text = ConnectInvitations.BodyText(m, Join, "Amit", "amit@techvein.com", Imip.MethodRequest, true, prev);
        t.Ok("text: says the time changed", text.StartsWith("Amit changed this meeting's time."));
        t.Ok("text: the new time", text.Contains("New time: 18 Sep 2026, 17:00–18:00 (IST)"));
        t.Ok("text: the old time", text.Contains("Was: 18 Sep 2026, 15:00–16:00 (IST)"));

        var html = ConnectInvitations.BodyHtml(m, Join, "Amit", "amit@techvein.com", Imip.MethodRequest, true, prev);
        t.Ok("html: a Time changed badge", html.Contains(">Time changed</div>"));
        t.Ok("html: the new time labelled", html.Contains(">New time</div>") && html.Contains("5:00 PM – 6:00 PM IST"));
        t.Ok("html: the old time, struck through", html.Contains("line-through;\">Friday, 18 September 2026, 3:00 PM – 4:00 PM IST</span>"));
        t.Ok("html: still a Join button", html.Contains("Join meeting"));

        var renamed = Meeting(); renamed.Title = "Q3 review";
        var hr = ConnectInvitations.BodyHtml(renamed, Join, "Amit", "amit@techvein.com", Imip.MethodRequest, true, prev);
        t.Ok("a rename says what it was called", hr.Contains(">Updated</div>") && hr.Contains(">Quarterly review</span>"));
        t.Ok("…and does not claim the time changed", !hr.Contains("Time changed") && !hr.Contains("New time"));

        // Only the START moved — what Amit's first live reschedule did (14:00–23:30).
        var startOnly = Meeting(); startOnly.ScheduledStart = startOnly.ScheduledStart!.Value.AddHours(-1);
        t.Ok("moving only the start is still a time change", ConnectInvitations.Changes(startOnly, prev).SequenceEqual(["time"]));
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

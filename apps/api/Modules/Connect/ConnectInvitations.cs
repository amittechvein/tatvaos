using System.Net.Mail;
using TatvaOS.Api.Modules.Calendar;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// The PURE half of meeting invitations: which addresses are acceptable, what
/// the calendar invitation says, and what the email text says. No database, no
/// network: tests/connect-invitations links this file and runs every rule.
///
/// Amit, 17 Sept 2026: "Invite on the meeting". The host types addresses on a
/// Connect meeting; each gets the join link, and a scheduled meeting also
/// carries an iMIP calendar invitation built by Calendar's own Imip.Build, so
/// there is one VCALENDAR writer on the platform rather than two that drift.
/// </summary>
public static class ConnectInvitations
{
    public const string StatusPending = "pending";
    public const string StatusSent = "sent";
    public const string StatusFailed = "failed";
    public const string StatusNotSent = "not_sent";

    /// <summary>Per request. A host inviting a whole department pastes a list;
    /// a script pasting ten thousand addresses is refused before any mail moves.</summary>
    public const int MaxPerRequest = 50;

    /// <summary>Per meeting, over its life. Outbound mail has no quota anywhere
    /// else on this platform (MailSendApiEndpoints says so), so this is the cap.</summary>
    public const int MaxPerMeeting = 200;

    public sealed record Parsed(IReadOnlyList<string> Valid, IReadOnlyList<string> Invalid);

    /// <summary>
    /// Addresses from whatever the host typed: separated by commas, semicolons,
    /// spaces or new lines, possibly pasted as "Ravi Kumar &lt;ravi@x.com&gt;".
    /// Returned trimmed, lower-cased and de-duplicated, in the order given.
    /// Anything that is not a single plain address is returned as Invalid,
    /// verbatim, so the host can be told which one to fix.
    /// </summary>
    public static Parsed Parse(IEnumerable<string>? raw)
    {
        var valid = new List<string>();
        var invalid = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (raw is null) return new Parsed(valid, invalid);

        foreach (var chunk in raw)
        {
            if (string.IsNullOrWhiteSpace(chunk)) continue;
            // Entries are separated by commas, semicolons or new lines. Inside
            // one entry, "Name <addr>" means addr; otherwise spaces separate
            // several bare addresses pasted on one line.
            foreach (var entry in chunk.Split([',', ';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var lt = entry.LastIndexOf('<');
                var gt = entry.LastIndexOf('>');
                // Only the angle-bracket form; anything cleverer is how a
                // display name smuggles in a second address.
                string[] pieces = lt >= 0 && gt > lt
                    ? [entry[(lt + 1)..gt]]
                    : entry.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);

                foreach (var piece in pieces)
                {
                    var candidate = piece.Trim().ToLowerInvariant();
                    if (IsPlainAddress(candidate))
                    {
                        if (seen.Add(candidate)) valid.Add(candidate);
                    }
                    else
                    {
                        // Reported verbatim, so "ravi" or "ravi@gmail" is named
                        // back to the host instead of quietly skipped.
                        invalid.Add(pieces.Length == 1 ? entry : piece.Trim());
                    }
                }
            }
        }
        return new Parsed(valid, invalid);
    }

    /// <summary>
    /// One address, nothing else: MailAddress must parse it WITHOUT a display
    /// name and give back exactly the same string, the domain must have a dot,
    /// and there must be no whitespace or control characters. Deliberately
    /// stricter than RFC 5322, which allows things no invitation needs.
    /// </summary>
    public static bool IsPlainAddress(string s)
    {
        if (s.Length is < 3 or > 320) return false;
        if (s.Any(c => char.IsWhiteSpace(c) || char.IsControl(c) || c is '<' or '>' or '"' or ',' or ';')) return false;
        var at = s.IndexOf('@');
        if (at <= 0 || at != s.LastIndexOf('@') || at == s.Length - 1) return false;
        var domain = s[(at + 1)..];
        if (!domain.Contains('.') || domain.StartsWith('.') || domain.EndsWith('.') || domain.Contains("..")) return false;
        return MailAddress.TryCreate(s, out var parsed)
               && string.IsNullOrEmpty(parsed.DisplayName)
               && string.Equals(parsed.Address, s, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Stable for the meeting's life: every resend, update and cancel
    /// must quote the same UID or the receiving calendar makes a second event.</summary>
    public static string Uid(Guid meetingId) => $"connect-{meetingId:D}@tatvaos.com";

    /// <summary>A meeting with a time can go in a calendar; an instant one cannot.</summary>
    public static bool HasCalendarTime(ConnectMeeting m) => m.ScheduledStart is not null;

    /// <summary>The end a calendar is given: the scheduled end, or an hour —
    /// the length the web form offers first — when none was set.</summary>
    public static DateTimeOffset EndOf(ConnectMeeting m) =>
        m.ScheduledEnd is DateTimeOffset e && e > m.ScheduledStart!.Value ? e : m.ScheduledStart!.Value.AddHours(1);

    /// <summary>The in-memory event Imip.Build needs. Nothing here is saved:
    /// Connect has no calendar row, only the meeting.</summary>
    public static CalendarEvent ToCalendarEvent(ConnectMeeting m, string joinUrl) => new()
    {
        Id = m.Id,
        TenantId = m.TenantId,
        Uid = Uid(m.Id),
        Sequence = m.InviteSequence,
        Title = string.IsNullOrWhiteSpace(m.Title) ? "Meeting" : m.Title,
        Description = "A TatvaOS Connect meeting. Open the link at the time of the meeting to join.",
        MeetingUrl = joinUrl,
        StartsAt = m.ScheduledStart!.Value,
        EndsAt = EndOf(m),
        Timezone = string.IsNullOrWhiteSpace(m.Timezone) ? "Asia/Kolkata" : m.Timezone,
        Status = "confirmed",
        Transparency = "opaque",
    };

    /// <summary>The VCALENDAR for ONE invitee. One email per person, so nobody's
    /// address is shown to a stranger in another company; the calendar file
    /// names only that person as attendee, for the same reason.</summary>
    public static string BuildCalendar(ConnectMeeting m, string joinUrl, string inviteeEmail,
        string organiserEmail, string? organiserName, string method) =>
        Imip.Build(
            ToCalendarEvent(m, joinUrl),
            [new CalendarAttendee { Email = inviteeEmail }],
            organiserEmail, organiserName, method);

    /// <summary>
    /// "17 Sep 2026, 15:00–16:00 (Asia/Kolkata)", CONVERTED to the meeting's
    /// zone first. ScheduledStart is stored in UTC; printing it raw is the bug
    /// CalendarInvitationMailer records from its first live send (a UTC clock
    /// wearing an IST label). Null for a meeting without a time.
    /// </summary>
    public static string? When(ConnectMeeting m)
    {
        if (m.ScheduledStart is not DateTimeOffset start) return null;
        TimeZoneInfo tzi;
        try { tzi = TimeZoneInfo.FindSystemTimeZoneById(m.Timezone); }
        catch (TimeZoneNotFoundException) { tzi = TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { tzi = TimeZoneInfo.Utc; }
        var s = TimeZoneInfo.ConvertTime(start, tzi);
        var e = TimeZoneInfo.ConvertTime(EndOf(m), tzi);
        var zone = tzi == TimeZoneInfo.Utc ? "UTC" : m.Timezone;
        // InvariantCulture, explicitly: the month name is culture data. This
        // laptop's culture printed "Sept" where the server container prints
        // "Sep" — the same email differing by which machine sent it (found by
        // tests/connect-invitations, 17 Sept 2026).
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        return s.Date == e.Date
            ? string.Format(inv, "{0:dd MMM yyyy, HH:mm}–{1:HH:mm} ({2})", s, e, zone)
            : string.Format(inv, "{0:dd MMM yyyy, HH:mm} – {1:dd MMM yyyy, HH:mm} ({2})", s, e, zone);
    }

    public static string Subject(ConnectMeeting m, string method) =>
        (method == Imip.MethodCancel ? "Cancelled: " : "Invitation: ")
        + (string.IsNullOrWhiteSpace(m.Title) ? "Meeting" : m.Title);

    /// <summary>
    /// The human half. Plain text, the facts in the order a person scans them.
    /// Calendar-aware clients render the invitation instead; everyone else
    /// gets something honest, including how to join without an account.
    /// </summary>
    public static string BodyText(ConnectMeeting m, string joinUrl, string? organiserName,
        string organiserEmail, string method, bool guestsAllowed)
    {
        var title = string.IsNullOrWhiteSpace(m.Title) ? "Meeting" : m.Title;
        var who = string.IsNullOrWhiteSpace(organiserName) ? organiserEmail : organiserName;
        var when = When(m);

        if (method == Imip.MethodCancel)
            return $"Cancelled: {title}\n"
                   + (when is null ? "" : $"Was: {when}\n")
                   + $"\n{who} cancelled this meeting. The link will no longer work.\n";

        return $"{who} invited you to a meeting.\n\n"
               + $"{title}\n"
               + (when is null ? "" : $"When: {when}\n")
               + $"Join: {joinUrl}\n\n"
               + (guestsAllowed
                   ? "Open the link at the time of the meeting. You do not need a TatvaOS account; you may wait a moment for the host to let you in.\n"
                   : "This meeting is for people signed in to TatvaOS. Open the link and sign in to join.\n")
               + $"\nOrganised by {who} <{organiserEmail}>\n";
    }
}

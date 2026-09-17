using System.Globalization;
using System.Net;
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
    public const string StatusWithdrawn = "withdrawn";

    /// <summary>Per request. A host inviting a whole department pastes a list;
    /// a script pasting ten thousand addresses is refused before any mail moves.</summary>
    public const int MaxPerRequest = 50;

    /// <summary>Per meeting, over its life. Outbound mail has no quota anywhere
    /// else on this platform (MailSendApiEndpoints says so), so this is the cap.</summary>
    public const int MaxPerMeeting = 200;

    public sealed record Parsed(IReadOnlyList<string> Valid, IReadOnlyList<string> Invalid);

    /// <summary>
    /// What an invitation said BEFORE a change, so the update can say what
    /// changed. Amit, 17 Sept 2026, on the first reschedule: "time change mail
    /// but there is no written that time is change" — the update arrived word
    /// for word like the original invitation, and Gmail folded it into the
    /// thread as if nothing had happened. Null for a first invitation.
    /// </summary>
    public sealed record Previous(string Title, DateTimeOffset? Start, DateTimeOffset? End);

    private static ConnectMeeting AsItWas(ConnectMeeting m, Previous p) => new()
    {
        Id = m.Id, Title = p.Title, ScheduledStart = p.Start, ScheduledEnd = p.End, Timezone = m.Timezone,
    };

    /// <summary>What a person should be told changed, in words; empty when nothing
    /// a recipient can see did.</summary>
    public static IReadOnlyList<string> Changes(ConnectMeeting m, Previous? p)
    {
        if (p is null) return [];
        var out_ = new List<string>();
        if (p.Start != m.ScheduledStart || EndOrNull(p) != EndOrNull(m)) out_.Add("time");
        if (!string.Equals(p.Title, m.Title, StringComparison.Ordinal)) out_.Add("title");
        return out_;
    }

    private static DateTimeOffset? EndOrNull(ConnectMeeting m) => m.ScheduledStart is null ? null : EndOf(m);
    private static DateTimeOffset? EndOrNull(Previous p) =>
        p.Start is DateTimeOffset st ? (p.End is DateTimeOffset e && e > st ? e : st.AddHours(1)) : null;

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

    /// <summary>
    /// The SEQUENCE for the next message to ONE person: strictly above the last
    /// one they received, and never below the meeting's.
    ///
    /// Why per person (CTO review, 17 Sept 2026, "withdraw then re-invite"): a
    /// calendar ignores a message for a UID whose SEQUENCE is not newer than
    /// what it holds. Withdrawing sends that person a CANCEL; re-inviting them
    /// with the meeting's unchanged SEQUENCE would be ignored, and they would
    /// have an invitation email and no event. Each person only ever sees their
    /// own messages, so monotonic per person is exactly what is needed.
    ///
    /// ── THIS DEVIATES FROM THE PLAIN READING OF RFC 5545. DO NOT "TIDY" IT. ──
    /// SEQUENCE belongs to the EVENT in the spec, and a single event-wide
    /// counter looks like the obvious simplification. It is safe to depart
    /// from here only because every recipient is addressed individually (one
    /// message per person, only that person as ATTENDEE — ConnectInvitationMailer),
    /// so nobody ever sees another person's stream for this UID and nothing can
    /// compare them. Collapse it to one event-wide number and either a re-invite
    /// after a withdrawal is silently discarded by the recipient's calendar (the
    /// bug this replaced: an email arrives, "add to calendar", nothing appears),
    /// or withdrawing one person churns every other attendee's calendar entry.
    /// If invitations ever go out as ONE message to many people, this must change
    /// with it. CTO review, 17 Sept 2026.
    /// </summary>
    public static int SequenceFor(ConnectMeeting m, int? lastSentToThem) =>
        Math.Max(m.InviteSequence, (lastSentToThem ?? -1) + 1);

    /// <summary>The in-memory event Imip.Build needs. Nothing here is saved:
    /// Connect has no calendar row, only the meeting.</summary>
    public static CalendarEvent ToCalendarEvent(ConnectMeeting m, string joinUrl, int sequence) => new()
    {
        Id = m.Id,
        TenantId = m.TenantId,
        Uid = Uid(m.Id),
        Sequence = sequence,
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
        string organiserEmail, string? organiserName, string method, int sequence) =>
        Imip.Build(
            ToCalendarEvent(m, joinUrl, sequence),
            [new CalendarAttendee { Email = inviteeEmail }],
            organiserEmail, organiserName, method);

    /// <summary>
    /// What a person calls the zone. "Asia/Calcutta" is what Amit's own
    /// browser sent on the first live invitation (17 Sept 2026) and it read like
    /// a database value; India is one zone and everybody calls it IST. Any other
    /// zone keeps its IANA name, which is at least unambiguous.
    /// </summary>
    public static string ZoneLabel(string? zone) => zone switch
    {
        "Asia/Kolkata" or "Asia/Calcutta" => "IST",
        null or "" => "UTC",
        _ => zone,
    };

    /// <summary>The meeting's start and end in its own zone, or null without a time.
    /// Stored in UTC; converting FIRST is the bug CalendarInvitationMailer
    /// records from its first live send (a UTC clock wearing an IST label).</summary>
    private static (DateTimeOffset Start, DateTimeOffset End, string Zone)? Local(ConnectMeeting m)
    {
        if (m.ScheduledStart is not DateTimeOffset start) return null;
        TimeZoneInfo tzi;
        try { tzi = TimeZoneInfo.FindSystemTimeZoneById(m.Timezone); }
        catch (TimeZoneNotFoundException) { tzi = TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { tzi = TimeZoneInfo.Utc; }
        var zone = tzi == TimeZoneInfo.Utc ? "UTC" : ZoneLabel(m.Timezone);
        return (TimeZoneInfo.ConvertTime(start, tzi), TimeZoneInfo.ConvertTime(EndOf(m), tzi), zone);
    }

    // InvariantCulture, explicitly: the month name is culture data. This
    // laptop's culture printed "Sept" where the server container prints "Sep" —
    // the same email differing by which machine sent it (found by
    // tests/connect-invitations, 17 Sept 2026).
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>"17 Sep 2026, 15:00–16:00 (IST)". Null for a meeting without a time.</summary>
    public static string? When(ConnectMeeting m)
    {
        if (Local(m) is not var (s, e, zone)) return null;
        return s.Date == e.Date
            ? string.Format(Inv, "{0:dd MMM yyyy, HH:mm}–{1:HH:mm} ({2})", s, e, zone)
            : string.Format(Inv, "{0:dd MMM yyyy, HH:mm} – {1:dd MMM yyyy, HH:mm} ({2})", s, e, zone);
    }

    /// <summary>The two lines the designed email shows: "Thursday, 17 September 2026"
    /// and "3:00 PM – 4:00 PM IST". Null for a meeting without a time.</summary>
    public static (string Date, string Time)? WhenLines(ConnectMeeting m)
    {
        if (Local(m) is not var (s, e, zone)) return null;
        var date = s.Date == e.Date
            ? s.ToString("dddd, d MMMM yyyy", Inv)
            : $"{s.ToString("dddd, d MMMM yyyy", Inv)} – {e.ToString("dddd, d MMMM yyyy", Inv)}";
        var time = $"{s.ToString("h:mm tt", Inv)} – {e.ToString("h:mm tt", Inv)} {zone}";
        return (date, time);
    }

    /// <summary>
    /// The designed half (Amit, 17 Sept 2026, on the first real invitation:
    /// "give some modern UI design, not simple text").
    ///
    /// EMAIL HTML IS NOT WEB HTML, and every choice below is about the worst
    /// client that will open it:
    ///  • tables and INLINE styles only — Gmail strips &lt;style&gt; blocks in
    ///    several of its clients and Outlook renders with Word's engine;
    ///  • the Join button is a padded link inside a coloured table cell (a
    ///    "bulletproof button"), not a styled &lt;a&gt; alone, so Outlook draws it;
    ///  • the logo is decoration with alt text: most clients block remote images
    ///    until asked, and the email must read completely without it;
    ///  • everything a person typed (title, names) is HTML-encoded. A meeting
    ///    titled "&lt;script&gt;" must arrive as those characters.
    /// The plain-text part (BodyText) stays, for clients that do not render HTML.
    /// </summary>
    public static string BodyHtml(ConnectMeeting m, string joinUrl, string? organiserName,
        string organiserEmail, string method, bool guestsAllowed, Previous? previous = null)
    {
        static string H(string? v) => WebUtility.HtmlEncode(v ?? "");

        var cancel = method == Imip.MethodCancel;
        var title = H(string.IsNullOrWhiteSpace(m.Title) ? "Meeting" : m.Title);
        var who = H(string.IsNullOrWhiteSpace(organiserName) ? organiserEmail : organiserName);
        var email = H(organiserEmail);
        var link = H(joinUrl);
        var origin = Uri.TryCreate(joinUrl, UriKind.Absolute, out var u) ? u.GetLeftPart(UriPartial.Authority) : "https://connect.tatvaos.com";
        var logo = H(origin + "/brand/connect-logo.png");
        var when = WhenLines(m);
        var changed = cancel ? [] : Changes(m, previous);
        var was = previous is not null && changed.Contains("time") ? WhenLines(AsItWas(m, previous)) : null;

        const string Font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
        const string Accent = "#6C3CE9";

        var sb = new System.Text.StringBuilder();
        sb.Append("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">")
          .Append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
          .Append("<meta name=\"color-scheme\" content=\"light only\">")
          .Append("<title>").Append(cancel ? "Cancelled: " : changed.Count > 0 ? "Updated: " : "Invitation: ").Append(title).Append("</title></head>");

        sb.Append("<body style=\"margin:0;padding:0;background:#F3F1FA;").Append(Font).Append("\">");
        // Preheader: the grey line inbox lists show beside the subject.
        sb.Append("<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:#F3F1FA;\">")
          .Append(cancel ? $"{who} cancelled this meeting."
              : changed.Count > 0 ? $"{who} changed the {string.Join(" and ", changed)}{(when is { } wu ? " · now " + H(wu.Date) + ", " + H(wu.Time) : "")}"
              : $"{who} invited you{(when is { } w0 ? " · " + H(w0.Date) + ", " + H(w0.Time) : "")}")
          .Append("</div>");

        sb.Append("<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" style=\"background:#F3F1FA;\"><tr><td align=\"center\" style=\"padding:32px 12px;\">");
        sb.Append("<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" style=\"max-width:560px;background:#FFFFFF;border-radius:16px;border:1px solid #E6E1F5;overflow:hidden;\">");

        // Header band
        sb.Append("<tr><td style=\"padding:20px 28px;border-bottom:1px solid #EFEBFA;\">")
          .Append("<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\"><tr>")
          .Append($"<td style=\"vertical-align:middle;padding-right:10px;\"><img src=\"{logo}\" width=\"28\" height=\"28\" alt=\"\" style=\"display:block;border:0;border-radius:6px;\"></td>")
          .Append("<td style=\"vertical-align:middle;").Append(Font).Append("font-size:15px;font-weight:600;color:#1F1B2E;\">TatvaOS <span style=\"color:").Append(Accent).Append(";\">Connect</span></td>")
          .Append("</tr></table></td></tr>");

        // Body
        sb.Append("<tr><td style=\"padding:28px 28px 8px 28px;").Append(Font).Append("\">");
        if (cancel)
        {
            sb.Append("<div style=\"display:inline-block;background:#FDECEC;color:#B3261E;font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:4px 10px;border-radius:999px;\">Cancelled</div>")
              .Append($"<p style=\"margin:14px 0 4px 0;font-size:14px;color:#6B6780;\">{who} cancelled this meeting</p>")
              .Append($"<h1 style=\"margin:0 0 20px 0;font-size:24px;line-height:1.3;font-weight:700;color:#1F1B2E;text-decoration:line-through;\">{title}</h1>");
        }
        else if (changed.Count > 0)
        {
            // SAID, not implied: an update that looks like the invitation is
            // an update nobody notices (the first live reschedule, 17 Sept).
            sb.Append("<div style=\"display:inline-block;background:#FFF4E0;color:#9A5B00;font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:4px 10px;border-radius:999px;\">")
              .Append(changed.Contains("time") ? "Time changed" : "Updated").Append("</div>")
              .Append($"<p style=\"margin:14px 0 4px 0;font-size:14px;color:#6B6780;\">{who} changed the {string.Join(" and ", changed)} of this meeting</p>")
              .Append($"<h1 style=\"margin:0 0 {(changed.Contains("title") ? "4" : "20")}px 0;font-size:24px;line-height:1.3;font-weight:700;color:#1F1B2E;\">{title}</h1>");
            if (changed.Contains("title"))
                sb.Append($"<p style=\"margin:0 0 20px 0;font-size:13px;color:#8A869B;\">Was called <span style=\"text-decoration:line-through;\">{H(previous!.Title)}</span></p>");
        }
        else
        {
            sb.Append($"<p style=\"margin:0 0 6px 0;font-size:14px;color:#6B6780;\">{who} invited you to a meeting</p>")
              .Append($"<h1 style=\"margin:0 0 20px 0;font-size:24px;line-height:1.3;font-weight:700;color:#1F1B2E;\">{title}</h1>");
        }

        if (when is { } w)
        {
            sb.Append("<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" style=\"background:#F7F5FD;border-radius:12px;\"><tr>")
              .Append("<td width=\"52\" style=\"padding:16px 0 16px 16px;vertical-align:top;\">")
              .Append($"<div style=\"width:40px;height:40px;border-radius:10px;background:{Accent};color:#FFFFFF;text-align:center;line-height:40px;font-size:18px;font-weight:700;\">&#128197;</div></td>")
              .Append("<td style=\"padding:16px;vertical-align:top;").Append(Font).Append("\">")
              .Append(was is not null ? "<div style=\"font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#9A5B00;margin-bottom:2px;\">New time</div>" : "")
              .Append($"<div style=\"font-size:15px;font-weight:600;color:#1F1B2E;\">{H(w.Date)}</div>")
              .Append($"<div style=\"font-size:14px;color:#4A4660;margin-top:2px;\">{H(w.Time)}</div>")
              .Append(was is { } old
                  ? $"<div style=\"font-size:13px;color:#8A869B;margin-top:10px;\">Was <span style=\"text-decoration:line-through;\">{H(old.Date)}, {H(old.Time)}</span></div>"
                  : "")
              .Append("</td></tr></table>");
        }

        if (!cancel)
        {
            // Bulletproof button.
            sb.Append("<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" style=\"margin:24px 0 12px 0;\"><tr>")
              .Append($"<td align=\"center\" bgcolor=\"{Accent}\" style=\"border-radius:10px;background:{Accent};\">")
              .Append($"<a href=\"{link}\" target=\"_blank\" style=\"display:inline-block;padding:14px 28px;").Append(Font)
              .Append("font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;\">Join meeting</a>")
              .Append("</td></tr></table>")
              .Append("<p style=\"margin:0 0 20px 0;font-size:12px;line-height:1.5;color:#8A869B;word-break:break-all;\">Or open this link: ")
              .Append($"<a href=\"{link}\" target=\"_blank\" style=\"color:{Accent};text-decoration:underline;\">{link}</a></p>");

            sb.Append("<div style=\"border-top:1px solid #EFEBFA;padding-top:16px;margin-bottom:20px;font-size:13px;line-height:1.6;color:#6B6780;\">")
              .Append(guestsAllowed
                  ? "Open the link at the time of the meeting. You don&#8217;t need a TatvaOS account &#8212; the host may let you in after a moment."
                  : "This meeting is for people in the organisation. Open the link and sign in to TatvaOS to join.")
              .Append("</div>");
        }
        else
        {
            sb.Append("<p style=\"margin:20px 0 24px 0;font-size:14px;line-height:1.6;color:#4A4660;\">The meeting link will no longer work. It has been removed from your calendar if you had added it.</p>");
        }
        sb.Append("</td></tr>");

        // Footer
        sb.Append("<tr><td style=\"padding:16px 28px 22px 28px;background:#FBFAFE;border-top:1px solid #EFEBFA;").Append(Font).Append("font-size:12px;line-height:1.6;color:#8A869B;\">")
          .Append($"Organised by <strong style=\"color:#4A4660;\">{who}</strong> &lt;<a href=\"mailto:{email}\" style=\"color:#8A869B;\">{email}</a>&gt;.<br>")
          .Append("Reply to this email to reach the organiser. Sent with TatvaOS Connect.")
          .Append("</td></tr>");

        sb.Append("</table></td></tr></table></body></html>");
        return sb.ToString();
    }

    public static string Subject(ConnectMeeting m, string method, Previous? previous = null) =>
        (method == Imip.MethodCancel ? "Cancelled: "
            : Changes(m, previous).Count > 0 ? "Updated: "
            : "Invitation: ")
        + (string.IsNullOrWhiteSpace(m.Title) ? "Meeting" : m.Title);

    /// <summary>
    /// The human half. Plain text, the facts in the order a person scans them.
    /// Calendar-aware clients render the invitation instead; everyone else
    /// gets something honest, including how to join without an account.
    /// </summary>
    public static string BodyText(ConnectMeeting m, string joinUrl, string? organiserName,
        string organiserEmail, string method, bool guestsAllowed, Previous? previous = null)
    {
        var title = string.IsNullOrWhiteSpace(m.Title) ? "Meeting" : m.Title;
        var who = string.IsNullOrWhiteSpace(organiserName) ? organiserEmail : organiserName;
        var when = When(m);

        if (method == Imip.MethodCancel)
            return $"Cancelled: {title}\n"
                   + (when is null ? "" : $"Was: {when}\n")
                   + $"\n{who} cancelled this meeting. The link will no longer work.\n";

        var changed = Changes(m, previous);
        var wasWhen = previous is null ? null : When(AsItWas(m, previous));
        var head = changed.Count == 0
            ? $"{who} invited you to a meeting.\n\n"
            : $"{who} changed this meeting's {string.Join(" and ", changed)}.\n\n";

        return head
               + $"{title}\n"
               + (changed.Contains("title") ? $"Was called: {previous!.Title}\n" : "")
               + (when is null ? "" : $"{(changed.Contains("time") ? "New time" : "When")}: {when}\n")
               + (changed.Contains("time") && wasWhen is not null ? $"Was: {wasWhen}\n" : "")
               + $"Join: {joinUrl}\n\n"
               + (guestsAllowed
                   ? "Open the link at the time of the meeting. You do not need a TatvaOS account; you may wait a moment for the host to let you in.\n"
                   : "This meeting is for people signed in to TatvaOS. Open the link and sign in to join.\n")
               + $"\nOrganised by {who} <{organiserEmail}>\n";
    }
}

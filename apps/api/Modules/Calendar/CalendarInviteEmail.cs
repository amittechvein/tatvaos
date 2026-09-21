using System.Net;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// The HTML half of a calendar invitation or cancellation: what a person SEES
/// under the Yes / No / Maybe card their mail client draws.
///
/// Amit, 21 Sept 2026, with a screenshot of a Gmail invitation whose body was
/// four bare lines of text: "need good design of invitation". Until then the
/// mailer sent text/plain only (BodyHtml was the empty string).
///
/// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
///
///  It is NOT the invitation. The text/calendar part is, and it stays the LAST
///  alternative (InvitationBody.Build puts text, then this, then the calendar)
///  so Gmail and Outlook still draw their answer buttons. This page is for the
///  person; the calendar part is for the client. Nothing here is parsed, and
///  so no button here pretends to answer the invitation: a Yes link that did
///  not reach the organiser would be worse than none.
///
///  The plain-text body is kept beside it, unchanged, for clients that do not
///  render HTML.
///
/// Same construction rules as InviteEmail: nested tables, inline styles,
/// absolute image URLs, every value HTML-encoded (a title is typed by a user
/// and goes into someone else's inbox).
/// </summary>
public static class CalendarInviteEmail
{
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Red = "#d93636";
    private const string Ink = "#0a0a0a";
    private const string Body = "#4d5875";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";

    /// <summary>At most this many guests are named; the rest are counted.</summary>
    private const int GuestsShown = 8;

    /// <summary>One way of writing a date, whatever the server's culture is.</summary>
    private static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;

    /// <param name="localStart">The start in the EVENT's zone, already converted.</param>
    /// <param name="localEnd">The end in the event's zone.</param>
    /// <param name="baseUrl">Where /brand images are served, e.g. https://core.tatvaos.com.</param>
    public static string Html(
        CalendarEvent ev, DateTimeOffset localStart, DateTimeOffset localEnd,
        string organiserName, IReadOnlyList<CalendarAttendee> attendees,
        bool cancelled, string baseUrl)
    {
        var b = baseUrl.TrimEnd('/');
        var title = Enc(ev.Title);
        var organiser = Enc(organiserName);

        var accent = cancelled ? Red : Green;
        var chip = cancelled ? "Cancelled" : "Invitation";
        var lead = cancelled
            ? $"{organiser} has cancelled this event. It is no longer taking place."
            : $"{organiser} has invited you to this event.";
        var titleStyle = cancelled ? $"color:{Muted};text-decoration:line-through;" : $"color:{Ink};";

        // The date tile: what a person finds first when scanning an inbox.
        var month = localStart.ToString("MMM", Inv).ToUpperInvariant();
        var day = localStart.ToString("%d", Inv);
        var weekday = localStart.ToString("ddd", Inv).ToUpperInvariant();

        var date = localStart.ToString("dddd, d MMMM yyyy", Inv);
        var sameDay = localStart.Date == localEnd.Date;
        var time = ev.IsAllDay
            ? "All day"
            : sameDay
                ? string.Format(Inv, "{0:HH:mm} – {1:HH:mm}", localStart, localEnd)
                : string.Format(Inv, "{0:HH:mm} – {1:d MMM, HH:mm}", localStart, localEnd);
        var zone = ev.IsAllDay ? "" : $@" <span style=""color:{Muted};"">({Enc(ev.Timezone)})</span>";

        var rows = Row("When", $"{Enc(date)}<br>{time}{zone}");
        if (!string.IsNullOrWhiteSpace(ev.Location))
            rows += Row("Where", LinkOrText(ev.Location!));
        rows += Row("Organiser", organiser);
        var guests = attendees
            .Select(a => string.IsNullOrWhiteSpace(a.DisplayName) ? a.Email : a.DisplayName!)
            .ToList();
        if (guests.Count > 0)
        {
            var named = string.Join(", ", guests.Take(GuestsShown).Select(Enc));
            var more = guests.Count > GuestsShown ? $" and {guests.Count - GuestsShown} more" : "";
            rows += Row("Guests", named + more);
        }

        // Join button: only while the event is on, and only for a real link.
        var join = !cancelled && IsWebLink(ev.MeetingUrl)
            ? $@"
          <tr>
            <td align=""center"" style=""padding:8px 32px 8px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""border-radius:10px;background:{Green};"">
                  <a href=""{Enc(ev.MeetingUrl!)}"" style=""display:inline-block;padding:13px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                    Join the meeting
                  </a>
                </td>
              </tr></table>
              <p style=""margin:10px 0 0;font-size:12px;color:{Muted};word-break:break-all;"">{Enc(ev.MeetingUrl!)}</p>
            </td>
          </tr>"
            : "";

        var details = Enc((ev.Description ?? "").Trim()).Replace("\r\n", "\n").Replace("\n", "<br>");
        var description = string.IsNullOrWhiteSpace(ev.Description) || cancelled
            ? ""
            : $@"
          <tr>
            <td style=""padding:16px 32px 4px;"">
              <div style=""font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">Details</div>
              <div style=""margin-top:6px;font-size:14px;line-height:1.6;color:{Body};"">{details}</div>
            </td>
          </tr>";

        var answer = cancelled
            ? "Calendars that read this message remove the event on their own. Nothing else needs doing."
            : "Answer with the Yes, No or Maybe buttons your mail or calendar shows for this message, or open the attached invite.ics. Your answer goes to the organiser.";

        return $@"<!DOCTYPE html>
<html lang=""en"">
<head>
  <meta charset=""utf-8"">
  <meta name=""viewport"" content=""width=device-width, initial-scale=1"">
  <meta name=""color-scheme"" content=""light"">
  <title>{chip}: {title}</title>
</head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr>
      <td align=""center"" style=""padding:28px 16px;"">
        <table role=""presentation"" width=""600"" cellpadding=""0"" cellspacing=""0""
               style=""width:600px;max-width:600px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">

          <!-- Header band -->
          <tr>
            <td style=""background:{GreenDark};background-image:linear-gradient(120deg,{GreenDark} 0%,{Green} 100%);padding:20px 32px;"">
              <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
                <td style=""vertical-align:middle;"">
                  <img src=""{b}/brand/calendar-logo.png"" width=""30"" height=""30"" alt=""""
                       style=""display:block;border:0;border-radius:7px;background:#ffffff;"">
                </td>
                <td style=""vertical-align:middle;padding-left:10px;"">
                  <span style=""font-size:17px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;"">TatvaOS Calendar</span>
                </td>
              </tr></table>
            </td>
          </tr>

          <!-- Date tile and title -->
          <tr>
            <td style=""padding:28px 32px 8px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""><tr>
                <td width=""72"" valign=""top"" style=""width:72px;"">
                  <table role=""presentation"" width=""64"" cellpadding=""0"" cellspacing=""0""
                         style=""width:64px;border:1px solid {Border};border-radius:10px;overflow:hidden;text-align:center;"">
                    <tr><td style=""background:{accent};color:#ffffff;font-size:11px;font-weight:800;letter-spacing:0.08em;padding:4px 0;"">{month}</td></tr>
                    <tr><td style=""font-size:26px;font-weight:800;color:{Ink};padding:4px 0 0;line-height:1.1;"">{day}</td></tr>
                    <tr><td style=""font-size:10px;font-weight:700;color:{Muted};letter-spacing:0.08em;padding:0 0 6px;"">{weekday}</td></tr>
                  </table>
                </td>
                <td valign=""top"" style=""padding-left:8px;"">
                  <span style=""display:inline-block;padding:2px 10px;border-radius:999px;background:{accent};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.04em;"">{chip}</span>
                  <h1 style=""margin:8px 0 6px;font-size:22px;line-height:1.3;font-weight:800;{titleStyle}"">{title}</h1>
                  <p style=""margin:0;font-size:14px;line-height:1.5;color:{Body};"">{lead}</p>
                </td>
              </tr></table>
            </td>
          </tr>

          <!-- The facts -->
          <tr>
            <td style=""padding:16px 32px 8px;"">
              <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                     style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
                {rows}
              </table>
            </td>
          </tr>
{join}{description}

          <!-- How to answer -->
          <tr>
            <td style=""padding:20px 32px 26px;"">
              <p style=""margin:0;font-size:13px;line-height:1.6;color:{Body};"">{answer}</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style=""padding:18px 32px 22px;border-top:1px solid {Border};"">
              <p style=""margin:0;font-size:12px;line-height:1.6;color:{Muted};"">
                Sent by TatvaOS Calendar on behalf of {organiser}. Replying to this email reaches the organiser.
              </p>
            </td>
          </tr>
        </table>

        <p style=""margin:16px 0 0;font-size:11px;color:{Muted};font-family:'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif;"">
          © TatvaOS by Techvein
        </p>
      </td>
    </tr>
  </table>
</body>
</html>";
    }

    /// <summary>One labelled line of the facts box.</summary>
    private static string Row(string label, string valueHtml) =>
        $@"<tr>
                  <td width=""96"" valign=""top"" style=""width:96px;padding:12px 0 12px 18px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:{Muted};"">{label}</td>
                  <td valign=""top"" style=""padding:11px 18px 11px 8px;font-size:14px;line-height:1.5;color:{Ink};"">{valueHtml}</td>
                </tr>";

    /// <summary>A location that is a web address becomes a link; anything else stays text.</summary>
    private static string LinkOrText(string value) =>
        IsWebLink(value)
            ? $@"<a href=""{Enc(value.Trim())}"" style=""color:{GreenDark};text-decoration:none;word-break:break-all;"">{Enc(value.Trim())}</a>"
            : Enc(value);

    /// <summary>
    /// http(s) only. A javascript: or data: URL typed into Location must never
    /// become a link in someone else's inbox.
    /// </summary>
    private static bool IsWebLink(string? value) =>
        Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var u)
        && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp);

    private static string Enc(string value) => WebUtility.HtmlEncode(value);
}

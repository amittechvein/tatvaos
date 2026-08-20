using System.Globalization;
using System.Net;
using System.Text;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// The Minutes of Meeting document.
///
/// ─────────────────────────────────────────────────────────────────────────
///  ONE RENDERER, AND THAT IS THE WHOLE POINT.
///
///  There are three places this document has to appear: on screen, as a file
///  somebody downloads, and in an email. The obvious build is three renderers
///  — a React component, a print stylesheet, and an email template — and this
///  module has already paid for what happens when the same knowledge lives in
///  two places and only one of them is right. So there is one function, it
///  emits email-safe HTML, and everything else uses that.
///
///  EMAIL-SAFE MEANS NESTED TABLES AND INLINE STYLES. Not a preference:
///  Outlook renders through Word, Gmail strips <style> blocks, and a flexbox
///  layout arrives as a column of unstyled text. The same markup opens
///  perfectly well in a browser and prints acceptably, which is why it can be
///  the download too. A prettier document that only works in Chrome would be
///  a worse product for a school secretary who forwards it.
///
///  THIS DOCUMENT IS A RECORD, SO IT SAYS WHAT IT DOES NOT KNOW.
///
///  It never implies more than it has. If the meeting was not recorded it says
///  so, and the notes are labelled as built from attendance. If a model wrote
///  the summary it says which model. If people attended who could not be
///  emailed — guests, who have no address here — it says how many, because a
///  recipient list that silently omits half the room is how a decision gets
///  made without the people it affects.
///
///  EVERY PIECE OF TEXT IN HERE CAME FROM A HUMAN OR A MODEL, so every piece
///  of text is HTML-encoded. A meeting titled `<script>` is not an attack
///  anybody planned; it is a Tuesday.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectMinutes
{
    // The brand, matching Shared/Notify. Repeated rather than referenced
    // because Notify is Core's lane and a Connect feature must not need a
    // change there to ship.
    private const string Green = "#03b562";
    private const string GreenDark = "#0a8a4b";
    private const string Ink = "#0a0a0a";
    private const string Body = "#4d5875";
    private const string Muted = "#8d9eb5";
    private const string Canvas = "#f2f4f9";
    private const string Border = "#e6e9ee";
    private const string Font = "'Plus Jakarta Sans',Segoe UI,Roboto,Helvetica,Arial,sans-serif";

    /// <summary>One line of what was said in the chat.</summary>
    public sealed record ChatLine(string Who, bool Guest, string Body, DateTimeOffset SentAt);

    /// <summary>Everything the document needs. Assembled by the caller so this
    /// file touches no database and can be rendered from a test.</summary>
    public sealed record Input(
        string MeetingTitle,
        DateTimeOffset? StartedAt,
        DateTimeOffset? EndedAt,
        string? HostName,
        string TimeZoneId,
        ConnectNotesModel.Notes Notes,
        IReadOnlyList<ChatLine> Chat,
        bool HadTranscript,
        /// <summary>Attendees with no address here — almost always guests.</summary>
        int UnreachableAttendees,
        string BaseUrl,
        Guid MeetingId,
        // Appended with a default rather than placed beside HadTranscript,
        // deliberately: every existing positional construction (including the
        // test suite's) stays valid, and the compiler still forces the one
        // caller that matters to say it by name.
        bool HadRecording = false);

    public static string Subject(Input m) =>
        $"Minutes: {Trim(m.MeetingTitle, 120)}"
        + (m.StartedAt is { } s ? $" — {Local(s, m.TimeZoneId):d MMM yyyy}" : "");

    /// <summary>A filename a person can find again in six months.</summary>
    public static string FileName(Input m, string extension = "html")
    {
        var when = m.StartedAt ?? m.EndedAt ?? DateTimeOffset.UtcNow;
        var safe = new string(m.MeetingTitle
            .Select(c => char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' ? c : ' ')
            .ToArray()).Trim();
        if (safe.Length == 0) safe = "Meeting";
        if (safe.Length > 60) safe = safe[..60].Trim();
        return $"Minutes — {safe} — {Local(when, m.TimeZoneId):yyyy-MM-dd}.{extension}";
    }

    // ======================================================================
    //  Plain text.
    //
    //  Not a fallback nobody reads: it is what gets pasted into a WhatsApp
    //  group, and for a school that is the channel that actually reaches
    //  parents. It carries the same facts in the same order.
    // ======================================================================
    public static string Text(Input m)
    {
        var b = new StringBuilder();
        var n = m.Notes;

        b.AppendLine("MINUTES OF MEETING").AppendLine();
        b.AppendLine(m.MeetingTitle);
        if (m.StartedAt is { } start)
            b.AppendLine(Local(start, m.TimeZoneId).ToString("dddd d MMMM yyyy, h:mm tt", Inv)
                         + (Duration(m) is { } d ? $" · {d}" : ""));
        if (!string.IsNullOrWhiteSpace(m.HostName)) b.AppendLine($"Host: {m.HostName}");
        b.AppendLine();

        if (!string.IsNullOrWhiteSpace(n.Summary))
            b.AppendLine("SUMMARY").AppendLine(n.Summary.Trim()).AppendLine();

        Section(b, "DECISIONS", n.Decisions);
        Section(b, "ACTION ITEMS", n.ActionItems);
        Section(b, "KEY POINTS", n.KeyPoints);

        if (n.Attendance.Count > 0)
        {
            b.AppendLine("WHO ATTENDED");
            foreach (var a in n.Attendance)
                b.AppendLine($"  - {a.Name}{(a.Guest ? " (guest)" : "")} — {Spell(a.Seconds)}"
                             + (a.Joins > 1 ? $", {a.Joins} joins" : ""));
            b.AppendLine();
        }

        if (m.Chat.Count > 0)
        {
            b.AppendLine("CHAT");
            foreach (var c in m.Chat)
                b.AppendLine($"  [{Local(c.SentAt, m.TimeZoneId):HH:mm}] {c.Who}: {c.Body}");
            b.AppendLine();
        }

        b.AppendLine(Provenance(m));
        return b.ToString();
    }

    private static void Section(StringBuilder b, string title, IReadOnlyList<string> items)
    {
        if (items.Count == 0) return;
        b.AppendLine(title);
        foreach (var i in items) b.AppendLine($"  - {i}");
        b.AppendLine();
    }

    // ======================================================================
    //  HTML.
    // ======================================================================
    public static string Html(Input m)
    {
        var n = m.Notes;
        var title = Enc(m.MeetingTitle);
        var b = m.BaseUrl.TrimEnd('/');

        var when = m.StartedAt is { } s
            ? Enc(Local(s, m.TimeZoneId).ToString("dddd d MMMM yyyy, h:mm tt", Inv))
            : "";
        var dur = Duration(m);

        var sb = new StringBuilder();
        sb.Append($@"<!DOCTYPE html>
<html lang=""en""><head><meta charset=""utf-8"">
<meta name=""viewport"" content=""width=device-width, initial-scale=1"">
<meta name=""color-scheme"" content=""light""><title>Minutes — {title}</title></head>
<body style=""margin:0;padding:0;background:{Canvas};"">
  <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""background:{Canvas};"">
    <tr><td align=""center"" style=""padding:32px 16px;"">
      <table role=""presentation"" width=""640"" cellpadding=""0"" cellspacing=""0""
             style=""width:640px;max-width:640px;background:#ffffff;border:1px solid {Border};border-radius:14px;overflow:hidden;font-family:{Font};"">

        <tr><td style=""background:{Green};background-image:linear-gradient(120deg,{GreenDark} 0%,{Green} 100%);padding:26px 32px;"">
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
            <td style=""vertical-align:middle;"">
              <img src=""{b}/brand/core-logo.png"" width=""32"" height=""32"" alt=""""
                   style=""display:block;border:0;border-radius:8px;background:#ffffff;"">
            </td>
            <td style=""vertical-align:middle;padding-left:12px;"">
              <span style=""font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;"">TatvaOS Connect</span>
              <div style=""font-size:12px;color:rgba(255,255,255,.85);letter-spacing:.04em;text-transform:uppercase;font-weight:700;"">Minutes of meeting</div>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style=""padding:30px 32px 6px;"">
          <h1 style=""margin:0 0 8px;font-size:23px;line-height:1.25;font-weight:800;color:{Ink};"">{title}</h1>
          <p style=""margin:0;font-size:14px;line-height:1.6;color:{Body};"">{when}{(dur is null ? "" : $" &middot; {Enc(dur)}")}</p>");

        if (!string.IsNullOrWhiteSpace(m.HostName))
            sb.Append($@"
          <p style=""margin:4px 0 0;font-size:13px;color:{Muted};"">Hosted by {Enc(m.HostName!)}</p>");

        sb.Append(@"
        </td></tr>");

        // ── The summary. First, because it is what a person opens this for.
        if (!string.IsNullOrWhiteSpace(n.Summary))
            sb.Append($@"
        <tr><td style=""padding:20px 32px 0;"">
          <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0""
                 style=""background:{Canvas};border:1px solid {Border};border-radius:10px;"">
            <tr><td style=""padding:16px 18px;"">
              <div style=""font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{Muted};margin-bottom:6px;"">Summary</div>
              <div style=""font-size:15px;line-height:1.65;color:{Ink};"">{Para(n.Summary!)}</div>
            </td></tr>
          </table>
        </td></tr>");

        // Decisions and actions BEFORE key points. A person scanning minutes
        // wants what was agreed and what they now owe, in that order.
        sb.Append(List("Decisions", n.Decisions, "#1f9d55"));
        sb.Append(List("Action items", n.ActionItems, "#d97706"));
        sb.Append(List("Key points", n.KeyPoints, Muted));

        // ── Who came.
        if (n.Attendance.Count > 0)
        {
            sb.Append($@"
        <tr><td style=""padding:22px 32px 0;"">
          <div style=""font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{Muted};margin-bottom:8px;"">Who attended</div>
          <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""border:1px solid {Border};border-radius:10px;overflow:hidden;"">");

            var row = 0;
            foreach (var a in n.Attendance)
            {
                var bg = row++ % 2 == 0 ? "#ffffff" : Canvas;
                sb.Append($@"
            <tr><td style=""padding:9px 14px;background:{bg};font-size:14px;color:{Ink};"">
              {Enc(a.Name)}{(a.Guest ? $@" <span style=""font-size:11px;color:{Muted};"">guest</span>" : "")}
            </td>
            <td align=""right"" style=""padding:9px 14px;background:{bg};font-size:13px;color:{Body};white-space:nowrap;"">
              {Enc(Spell(a.Seconds))}{(a.Joins > 1 ? $@" <span style=""color:{Muted};"">&middot; {a.Joins} joins</span>" : "")}
            </td></tr>");
            }

            sb.Append(@"
          </table>");

            // The honest footnote. Guests have no address on this platform, and
            // a document that quietly leaves them out of 'who was told' is
            // worse than one that says so.
            if (m.UnreachableAttendees > 0)
                sb.Append($@"
          <p style=""margin:8px 0 0;font-size:12px;line-height:1.6;color:{Muted};"">
            {m.UnreachableAttendees} {(m.UnreachableAttendees == 1 ? "person" : "people")} attended as a guest and {(m.UnreachableAttendees == 1 ? "was" : "were")} not sent these minutes — the platform has no email address for {(m.UnreachableAttendees == 1 ? "them" : "them")}. Forward this if they need it.
          </p>");

            sb.Append(@"
        </td></tr>");
        }

        // ── Who talked. Only when a transcript exists; without one every
        //    speaker time is zero and a table of zeroes reads as a fault.
        if (n.Speakers.Count > 0 && n.Speakers.Any(s => s.Seconds > 0))
        {
            sb.Append($@"
        <tr><td style=""padding:22px 32px 0;"">
          <div style=""font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{Muted};margin-bottom:8px;"">Who spoke</div>
          <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"">");
            foreach (var talker in n.Speakers.OrderByDescending(x => x.Seconds).Take(12))
                sb.Append($@"
            <tr><td style=""padding:4px 0;font-size:14px;color:{Ink};"">{Enc(talker.Name)}</td>
                <td align=""right"" style=""padding:4px 0;font-size:13px;color:{Body};"">{Enc(Spell(talker.Seconds))}</td></tr>");
            sb.Append(@"
          </table>
        </td></tr>");
        }

        // ── The chat, which is half of what was actually said.
        if (m.Chat.Count > 0)
        {
            sb.Append($@"
        <tr><td style=""padding:22px 32px 0;"">
          <div style=""font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{Muted};margin-bottom:8px;"">Chat</div>
          <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"" style=""border:1px solid {Border};border-radius:10px;"">
            <tr><td style=""padding:12px 14px;"">");
            foreach (var c in m.Chat)
                sb.Append($@"
              <div style=""margin:0 0 7px;font-size:13px;line-height:1.55;color:{Ink};"">
                <span style=""color:{Muted};font-variant-numeric:tabular-nums;"">{Enc(Local(c.SentAt, m.TimeZoneId).ToString("HH:mm", Inv))}</span>
                <strong style=""color:{Body};"">{Enc(c.Who)}</strong>{(c.Guest ? $@" <span style=""font-size:11px;color:{Muted};"">guest</span>" : "")}
                — {Para(c.Body)}
              </div>");
            sb.Append(@"
            </td></tr>
          </table>
        </td></tr>");
        }

        sb.Append($@"
        <tr><td align=""center"" style=""padding:26px 32px 6px;"">
          <table role=""presentation"" cellpadding=""0"" cellspacing=""0""><tr>
            <td style=""border-radius:10px;background:{Green};"">
              <a href=""{b}/connect/meetings/{m.MeetingId}"" style=""display:inline-block;padding:13px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;"">
                Open the meeting
              </a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style=""padding:22px 32px 26px;border-top:1px solid {Border};"">
          <p style=""margin:0;font-size:12px;line-height:1.65;color:{Muted};"">{Enc(Provenance(m))}</p>
        </td></tr>
      </table>
      <p style=""margin:16px 0 0;font-size:11px;color:{Muted};font-family:{Font};"">© TatvaOS by Techvein</p>
    </td></tr>
  </table>
</body></html>");

        return sb.ToString();
    }

    private static string List(string title, IReadOnlyList<string> items, string dot)
    {
        if (items.Count == 0) return "";
        var sb = new StringBuilder();
        sb.Append($@"
        <tr><td style=""padding:22px 32px 0;"">
          <div style=""font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{Muted};margin-bottom:8px;"">{Enc(title)}</div>
          <table role=""presentation"" width=""100%"" cellpadding=""0"" cellspacing=""0"">");
        foreach (var item in items)
            sb.Append($@"
            <tr>
              <td width=""16"" style=""vertical-align:top;padding:4px 0 0;"">
                <div style=""width:6px;height:6px;border-radius:50%;background:{dot};margin-top:7px;""></div>
              </td>
              <td style=""padding:3px 0;font-size:14px;line-height:1.6;color:{Ink};"">{Para(item)}</td>
            </tr>");
        sb.Append(@"
          </table>
        </td></tr>");
        return sb.ToString();
    }

    /// <summary>
    /// Where these minutes came from, in one sentence.
    ///
    /// This is the line that stops the document being oversold. 'Digest' notes
    /// are assembled mechanically from attendance and, where there is one, the
    /// transcript — useful, and not a summary somebody wrote. Saying which is
    /// the difference between a record and a claim.
    /// </summary>
    private static string Provenance(Input m)
    {
        var n = m.Notes;
        var how = n.Kind == "model"
            ? $"summarised automatically{(string.IsNullOrWhiteSpace(n.Model) ? "" : $" by {n.Model}")}"
            : "assembled automatically";

        // Three true sentences, not two. "No transcript" has two causes —
        // never recorded, and recorded-but-not-transcribed — and on the
        // module's first proven run the two-way version claimed "not
        // recorded" beside a Ready recording. A document that is a record
        // cannot contain a sentence the recordings list contradicts.
        var from = m.HadTranscript
            ? "from the meeting's recording and transcript"
            : m.HadRecording
                ? "from who joined and when — the meeting was recorded, but no "
                  + "transcript was made of the recording"
                : "from who joined and when — this meeting was not recorded, so there is no transcript";

        return $"These minutes were {how} {from}. "
             + (n.Kind == "model"
                 ? "Automatic summaries can be wrong; check anything that matters against the recording."
                 : "Nothing here was written by a person — it is a record of the meeting, not an interpretation of it.")
             + " Sent by TatvaOS Connect.";
    }

    // ── formatting ────────────────────────────────────────────────────────
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>HTML-encoded, with newlines kept as line breaks. A model that
    /// returns a two-line action item should not have it run together.</summary>
    private static string Para(string s) =>
        Enc(s.Trim()).Replace("\r\n", "\n").Replace("\n", "<br>");

    private static string Enc(string s) => WebUtility.HtmlEncode(s);

    private static string Trim(string s, int n) => s.Length <= n ? s : s[..n].TrimEnd() + "…";

    /// <summary>
    /// A duration a person reads without doing arithmetic.
    ///
    /// "1h 05m", not "3900 seconds" and not "65 minutes". Zero is not blank:
    /// somebody who joined and never spoke was still there, and their
    /// attendance is exactly the fact a school needs.
    /// </summary>
    private static string Spell(long seconds)
    {
        if (seconds <= 0) return "joined";
        if (seconds < 60) return $"{seconds}s";
        var minutes = seconds / 60;
        if (minutes < 60) return $"{minutes}m";
        return $"{minutes / 60}h {minutes % 60:00}m";
    }

    private static string? Duration(Input m)
    {
        if (m.StartedAt is not { } s || m.EndedAt is not { } e || e <= s) return null;
        return Spell((long)(e - s).TotalSeconds);
    }

    /// <summary>
    /// The organisation's clock, not UTC.
    ///
    /// Minutes stamped 04:30 for a meeting everybody remembers at 10:00 are
    /// minutes nobody trusts. An unknown zone falls back to UTC rather than
    /// throwing — the same rule CalendarReminderWorker follows.
    /// </summary>
    private static DateTimeOffset Local(DateTimeOffset when, string timeZoneId)
    {
        try { return TimeZoneInfo.ConvertTime(when, TimeZoneInfo.FindSystemTimeZoneById(timeZoneId)); }
        catch { return when.ToUniversalTime(); }
    }
}

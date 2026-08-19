using System.Globalization;
using System.Text;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// iCalendar (RFC 5545) generation and reply parsing for iMIP (RFC 6047).
///
/// Contract: docs/MAIL_IMIP_SEAM.md, v1.2 — Calendar builds the CONTENT, Mail
/// carries it. Nothing in this file knows what MIME is, on purpose: it returns
/// a VCALENDAR string and the method name, and Mail assembles both carriages
/// (the multipart/alternative sibling and the invite.ics attachment) from
/// those two. One caller then owns both the `method=` content-type parameter
/// and the METHOD inside the body, so they cannot drift apart.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE THREE THINGS THAT ARE USUALLY WRONG, AND ARE WHY THIS IS HAND-WRITTEN
///
///  1. FOLDING IS COUNTED IN OCTETS, NOT CHARACTERS. RFC 5545 §3.1 caps a
///     line at 75 octets. A subject with Devanagari in it is three bytes per
///     character, so a "60 character" SUMMARY can be 180 octets — and Outlook
///     rejects the whole object rather than the long line. Fold() counts
///     UTF-8 bytes and never splits a character across the fold.
///
///  2. TEXT VALUES MUST BE ESCAPED, and the set is specific: backslash,
///     semicolon, comma and newline — but NOT the colon, which is escaped in
///     some other formats and must be left alone here. An unescaped comma in
///     a LOCATION silently truncates it at the comma, because comma is the
///     list separator.
///
///  3. LINE ENDINGS ARE CRLF, everywhere, including the last line. A payload
///     with bare LF is accepted by Gmail and rejected by Exchange, which is
///     the worst possible split: it works in testing and fails at the
///     customer who bought it for Outlook.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class Imip
{
    /// <summary>RFC 5545 methods this platform emits or understands.</summary>
    public const string MethodRequest = "REQUEST";
    public const string MethodCancel  = "CANCEL";
    public const string MethodReply   = "REPLY";

    private const string ProdId = "-//Techvein//TatvaOS Calendar//EN";

    // ======================================================================
    //  BUILD — the invitation, the update and the cancellation
    // ======================================================================

    /// <summary>
    /// The complete VCALENDAR for an event. <paramref name="method"/> is
    /// REQUEST for a new or updated invitation and CANCEL to withdraw one.
    ///
    /// The caller is responsible for having bumped <c>Sequence</c> before a
    /// material change: a receiver that sees the same UID at the same
    /// SEQUENCE treats the message as a duplicate and ignores it, which is
    /// exactly right for a resend and exactly wrong for an update.
    /// </summary>
    public static string Build(
        CalendarEvent ev,
        IEnumerable<CalendarAttendee> attendees,
        string organiserEmail,
        string? organiserName,
        string method)
    {
        var sb = new StringBuilder();
        var lines = new List<string>
        {
            "BEGIN:VCALENDAR",
            "PRODID:" + ProdId,
            "VERSION:2.0",
            "CALSCALE:GREGORIAN",
            "METHOD:" + method,
        };

        // A VTIMEZONE is only meaningful when the times reference it. All-day
        // events carry DATE values (no zone at all), and for a one-off we use
        // UTC — see TimeLines below for why.
        var usesTzid = !ev.IsAllDay && ev.RecurrenceRule is not null;
        if (usesTzid) lines.AddRange(TimeZoneLines(ev.Timezone));

        lines.Add("BEGIN:VEVENT");
        lines.Add("UID:" + ev.Uid);
        lines.Add("DTSTAMP:" + Utc(DateTimeOffset.UtcNow));
        lines.Add("SEQUENCE:" + ev.Sequence.ToString(CultureInfo.InvariantCulture));
        lines.AddRange(TimeLines(ev, usesTzid));

        lines.Add("SUMMARY:" + Escape(ev.Title));

        // The Connect link goes in LOCATION when there is no physical place,
        // and always in DESCRIPTION on its own line — clients linkify the
        // description, and the ones that do not still show a copyable URL.
        var location = !string.IsNullOrWhiteSpace(ev.Location) ? ev.Location : ev.MeetingUrl;
        if (!string.IsNullOrWhiteSpace(location)) lines.Add("LOCATION:" + Escape(location));

        var description = BuildDescription(ev);
        if (description is not null) lines.Add("DESCRIPTION:" + Escape(description));

        if (ev.RecurrenceRule is { Length: > 0 } rrule)
            // Verbatim. The expander in Recurrence.cs refuses at save time
            // anything it cannot expand exactly, so what is stored is already
            // known-good — re-deriving it here would be a second opinion with
            // no way to be more right.
            lines.Add("RRULE:" + rrule);

        lines.Add("ORGANIZER" + CnParam(organiserName) + ":mailto:" + organiserEmail);

        foreach (var a in attendees)
        {
            lines.Add(
                "ATTENDEE" + CnParam(a.DisplayName)
                + ";ROLE=" + Role(a.Role)
                + ";PARTSTAT=" + PartStat(a.Status)
                // RSVP=TRUE is what makes Gmail and Outlook render the
                // Accept/Decline buttons rather than a read-only summary.
                + ";RSVP=TRUE"
                + ":mailto:" + a.Email);
        }

        // CANCEL must say so in the body as well as the METHOD, or clients
        // that read the VEVENT and ignore the envelope leave the event in
        // place looking confirmed.
        lines.Add("STATUS:" + (method == MethodCancel
            ? "CANCELLED"
            : ev.Status.Equals("tentative", StringComparison.OrdinalIgnoreCase)
                ? "TENTATIVE"
                : "CONFIRMED"));

        lines.Add("TRANSP:" + (ev.Transparency.Equals("transparent", StringComparison.OrdinalIgnoreCase)
            ? "TRANSPARENT" : "OPAQUE"));

        lines.Add("END:VEVENT");
        lines.Add("END:VCALENDAR");

        foreach (var line in lines) sb.Append(Fold(line)).Append("\r\n");
        return sb.ToString();
    }

    /// <summary>
    /// DTSTART/DTEND, and the one decision inside them.
    ///
    /// A ONE-OFF event is emitted in UTC ("...Z"). That is unambiguous
    /// everywhere and needs no VTIMEZONE, which removes the single biggest
    /// source of Outlook rejections.
    ///
    /// A RECURRING event cannot be: a weekly 10:00 expressed in UTC drifts an
    /// hour when the recipient's zone crosses a DST boundary, and the meeting
    /// silently moves. So those carry TZID plus a VTIMEZONE. Our own zone
    /// (Asia/Kolkata) has no DST, which is why this has not bitten yet and
    /// why it would have, the first time an event recurred for a customer
    /// abroad.
    /// </summary>
    private static IEnumerable<string> TimeLines(CalendarEvent ev, bool usesTzid)
    {
        if (ev.IsAllDay)
        {
            // DATE, not DATE-TIME. DTEND is EXCLUSIVE in iCalendar: a
            // one-day event ends on the following day, and getting this wrong
            // shows every all-day event as one day short.
            yield return "DTSTART;VALUE=DATE:" + ev.StartsAt.UtcDateTime.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
            yield return "DTEND;VALUE=DATE:" + ev.EndsAt.UtcDateTime.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
            yield break;
        }

        if (!usesTzid)
        {
            yield return "DTSTART:" + Utc(ev.StartsAt);
            yield return "DTEND:" + Utc(ev.EndsAt);
            yield break;
        }

        var tz = ResolveZone(ev.Timezone);
        yield return $"DTSTART;TZID={ev.Timezone}:" + Local(ev.StartsAt, tz);
        yield return $"DTEND;TZID={ev.Timezone}:" + Local(ev.EndsAt, tz);
    }

    /// <summary>
    /// A VTIMEZONE for the event's zone.
    ///
    /// Zones with no DST — Asia/Kolkata, most of our customers — need one
    /// STANDARD component with a fixed offset, and that is the whole of it.
    /// Zones with DST get STANDARD plus DAYLIGHT built from the CURRENT
    /// adjustment rule.
    ///
    /// Deliberately not historically accurate: a full VTIMEZONE encodes every
    /// rule change a zone has ever had, and clients use it to render dates in
    /// the past. Ours describes today's rule only. For an invitation — which
    /// is about a future occurrence — that is correct, and pretending
    /// otherwise would be a large amount of code producing a subtler lie.
    /// </summary>
    private static IEnumerable<string> TimeZoneLines(string ianaId)
    {
        var tz = ResolveZone(ianaId);
        var now = DateTime.UtcNow;
        var rule = tz.GetAdjustmentRules()
                     .FirstOrDefault(r => r.DateStart <= now && now <= r.DateEnd);

        yield return "BEGIN:VTIMEZONE";
        yield return "TZID:" + ianaId;

        if (rule is null || !tz.SupportsDaylightSavingTime)
        {
            var offset = Offset(tz.BaseUtcOffset);
            yield return "BEGIN:STANDARD";
            // Required by the grammar even when nothing ever transitions.
            yield return "DTSTART:19700101T000000";
            yield return "TZOFFSETFROM:" + offset;
            yield return "TZOFFSETTO:" + offset;
            yield return "TZNAME:" + ianaId;
            yield return "END:STANDARD";
            yield return "END:VTIMEZONE";
            yield break;
        }

        var standardOffset = Offset(tz.BaseUtcOffset);
        var daylightOffset = Offset(tz.BaseUtcOffset + rule.DaylightDelta);

        yield return "BEGIN:DAYLIGHT";
        yield return "DTSTART:19700101T000000";
        yield return "TZOFFSETFROM:" + standardOffset;
        yield return "TZOFFSETTO:" + daylightOffset;
        yield return "RRULE:" + TransitionRule(rule.DaylightTransitionStart);
        yield return "END:DAYLIGHT";

        yield return "BEGIN:STANDARD";
        yield return "DTSTART:19700101T000000";
        yield return "TZOFFSETFROM:" + daylightOffset;
        yield return "TZOFFSETTO:" + standardOffset;
        yield return "RRULE:" + TransitionRule(rule.DaylightTransitionEnd);
        yield return "END:STANDARD";

        yield return "END:VTIMEZONE";
    }

    private static string TransitionRule(TimeZoneInfo.TransitionTime t)
    {
        if (t.IsFixedDateRule)
            return $"FREQ=YEARLY;BYMONTH={t.Month};BYMONTHDAY={t.Day}";

        // Week 5 means "last", which is BYDAY=-1<day> in RFC 5545.
        var week = t.Week == 5 ? "-1" : t.Week.ToString(CultureInfo.InvariantCulture);
        var day = t.DayOfWeek switch
        {
            DayOfWeek.Sunday => "SU", DayOfWeek.Monday => "MO", DayOfWeek.Tuesday => "TU",
            DayOfWeek.Wednesday => "WE", DayOfWeek.Thursday => "TH", DayOfWeek.Friday => "FR",
            _ => "SA",
        };
        return $"FREQ=YEARLY;BYMONTH={t.Month};BYDAY={week}{day}";
    }

    private static string? BuildDescription(CalendarEvent ev)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(ev.Description)) parts.Add(ev.Description!.Trim());
        if (!string.IsNullOrWhiteSpace(ev.MeetingUrl)) parts.Add("Join: " + ev.MeetingUrl);
        return parts.Count == 0 ? null : string.Join("\n\n", parts);
    }

    // ======================================================================
    //  PARSE — what came back
    // ======================================================================

    /// <summary>One attendee's answer, lifted out of a METHOD:REPLY payload.</summary>
    public sealed record ImipReply(
        string Uid,
        int Sequence,
        string AttendeeEmail,
        /// <summary>needs-action | accepted | declined | tentative — OUR spelling,
        /// already normalised to what CalendarAttendee.Status stores.</summary>
        string PartStat,
        /// <summary>Set when the reply is about ONE occurrence of a series.</summary>
        DateTimeOffset? RecurrenceId,
        string Method);

    /// <summary>
    /// Read a REPLY (or COUNTER, which v1 treats as a reply with a note we
    /// ignore). Returns null for anything that is not a usable reply —
    /// including calendar payloads that are perfectly valid but not for us.
    ///
    /// NOTHING HERE IS TRUSTED FOR AUTHORISATION. The ATTENDEE address in the
    /// payload is attacker-controlled text; the caller matches on the
    /// SMTP-authenticated sender instead and uses this only to find which
    /// attendee row the answer is about, then verifies the two agree.
    /// </summary>
    public static ImipReply? ParseReply(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload)) return null;

        var lines = Unfold(payload);

        var method = Value(lines, "METHOD");
        if (method is null) return null;
        if (!method.Equals(MethodReply, StringComparison.OrdinalIgnoreCase)
            && !method.Equals("COUNTER", StringComparison.OrdinalIgnoreCase))
            return null;

        var uid = Value(lines, "UID");
        if (string.IsNullOrWhiteSpace(uid)) return null;

        // Absent SEQUENCE means 0 (RFC 5545 §3.8.7.4), not "unknown".
        var sequence = 0;
        if (Value(lines, "SEQUENCE") is { } seqText)
            int.TryParse(seqText, NumberStyles.Integer, CultureInfo.InvariantCulture, out sequence);

        // The FIRST ATTENDEE line carrying a PARTSTAT is the replier. A reply
        // may echo the whole attendee list; the others are stale copies of
        // what the organiser sent and must not overwrite anyone's answer.
        foreach (var line in lines)
        {
            if (!line.StartsWith("ATTENDEE", StringComparison.OrdinalIgnoreCase)) continue;

            var partstat = Param(line, "PARTSTAT");
            if (partstat is null) continue;

            var email = MailtoOf(line);
            if (email is null) continue;

            return new ImipReply(
                uid!,
                sequence,
                email,
                NormalisePartStat(partstat),
                ParseRecurrenceId(lines),
                method.ToUpperInvariant());
        }

        return null;
    }

    private static DateTimeOffset? ParseRecurrenceId(IReadOnlyList<string> lines)
    {
        foreach (var line in lines)
        {
            if (!line.StartsWith("RECURRENCE-ID", StringComparison.OrdinalIgnoreCase)) continue;
            var raw = line[(line.IndexOf(':') + 1)..].Trim();
            if (DateTimeOffset.TryParseExact(raw, "yyyyMMdd'T'HHmmss'Z'",
                    CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var utc))
                return utc;
            if (DateTimeOffset.TryParseExact(raw, "yyyyMMdd'T'HHmmss",
                    CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var floating))
                return floating;
        }
        return null;
    }

    // ======================================================================
    //  Wire mechanics
    // ======================================================================

    /// <summary>
    /// Fold to 75 OCTETS per RFC 5545 §3.1, continuation lines beginning with
    /// a single space. Counts UTF-8 bytes, and never splits a character
    /// across the boundary — a half-character either side of a fold makes the
    /// whole object unparseable, and it only happens once the text is not
    /// ASCII, which is to say once a real customer uses it.
    /// </summary>
    internal static string Fold(string line)
    {
        var bytes = Encoding.UTF8.GetByteCount(line);
        if (bytes <= 75) return line;

        var sb = new StringBuilder();
        var used = 0;
        var first = true;

        foreach (var rune in line.EnumerateRunes())
        {
            var size = Encoding.UTF8.GetByteCount(rune.ToString());
            // 75 on the first line; continuations spend one octet on the
            // leading space, so 74 of payload.
            var budget = first ? 75 : 74;
            if (used + size > budget)
            {
                sb.Append("\r\n ");
                used = 0;
                first = false;
            }
            sb.Append(rune);
            used += size;
        }
        return sb.ToString();
    }

    /// <summary>
    /// Reverse of folding: a line beginning with space or tab continues the
    /// previous one. Done before any field is read, or a folded ATTENDEE —
    /// which is most of them, since an address plus CN plus PARTSTAT passes
    /// 75 octets easily — parses as two unrecognisable fragments.
    /// </summary>
    internal static List<string> Unfold(string payload)
    {
        var raw = payload.Replace("\r\n", "\n").Split('\n');
        var result = new List<string>();

        foreach (var line in raw)
        {
            if (line.Length > 0 && (line[0] == ' ' || line[0] == '\t') && result.Count > 0)
                result[^1] += line[1..];
            else
                result.Add(line);
        }
        return result;
    }

    /// <summary>
    /// RFC 5545 §3.3.11. Backslash first — escaping it after the others would
    /// double the backslashes they introduce. Colon is NOT escaped in TEXT.
    /// </summary>
    internal static string Escape(string value) => value
        .Replace("\\", "\\\\")
        .Replace(";", "\\;")
        .Replace(",", "\\,")
        .Replace("\r\n", "\\n")
        .Replace("\n", "\\n")
        .Replace("\r", "\\n");

    private static string Utc(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);

    private static string Local(DateTimeOffset t, TimeZoneInfo tz) =>
        TimeZoneInfo.ConvertTime(t, tz).ToString("yyyyMMdd'T'HHmmss", CultureInfo.InvariantCulture);

    private static string Offset(TimeSpan offset) =>
        (offset < TimeSpan.Zero ? "-" : "+")
        + offset.Duration().Hours.ToString("00", CultureInfo.InvariantCulture)
        + offset.Duration().Minutes.ToString("00", CultureInfo.InvariantCulture);

    /// <summary>
    /// IANA id to TimeZoneInfo, tolerating a Windows host.
    ///
    /// .NET on Linux takes IANA ids directly; on Windows it wants "India
    /// Standard Time" unless the ICU shim is in play. FindSystemTimeZoneById
    /// handles both on modern .NET, and a zone we cannot resolve falls back to
    /// UTC rather than throwing — an invitation with the wrong offset is
    /// recoverable, an exception during send is a meeting nobody hears about.
    /// </summary>
    private static TimeZoneInfo ResolveZone(string ianaId)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(ianaId); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }

    private static string CnParam(string? name) =>
        string.IsNullOrWhiteSpace(name)
            ? ""
            // Quoted, and quotes stripped from the value: a CN containing a
            // double quote ends the parameter early and the rest of the line
            // is read as garbage.
            : ";CN=\"" + name.Replace("\"", "").Replace("\\", "") + "\"";

    private static string Role(string role) => role.ToLowerInvariant() switch
    {
        "chair" => "CHAIR",
        "opt-participant" => "OPT-PARTICIPANT",
        _ => "REQ-PARTICIPANT",
    };

    private static string PartStat(string status) => status.ToLowerInvariant() switch
    {
        "accepted" => "ACCEPTED",
        "declined" => "DECLINED",
        "tentative" => "TENTATIVE",
        _ => "NEEDS-ACTION",
    };

    /// <summary>Wire spelling back to what CalendarAttendee.Status stores.</summary>
    internal static string NormalisePartStat(string wire) => wire.Trim().ToUpperInvariant() switch
    {
        "ACCEPTED" => "accepted",
        "DECLINED" => "declined",
        "TENTATIVE" => "tentative",
        // DELEGATED is a real PARTSTAT we do not model. It is not an
        // acceptance, and recording it as one would tell an organiser someone
        // is coming when they have handed the meeting to somebody else.
        _ => "needs-action",
    };

    private static string? Value(IReadOnlyList<string> lines, string name)
    {
        foreach (var line in lines)
        {
            if (!line.StartsWith(name, StringComparison.OrdinalIgnoreCase)) continue;
            var colon = line.IndexOf(':');
            if (colon < 0) continue;
            // Guard against SUMMARY matching a prefix search for SUM: the
            // character after the name must end the name.
            var after = line[name.Length];
            if (after != ':' && after != ';') continue;
            return line[(colon + 1)..].Trim();
        }
        return null;
    }

    private static string? Param(string line, string name)
    {
        var idx = line.IndexOf(name + "=", StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return null;
        var start = idx + name.Length + 1;
        var end = line.IndexOfAny([';', ':'], start);
        return (end < 0 ? line[start..] : line[start..end]).Trim().Trim('"');
    }

    private static string? MailtoOf(string line)
    {
        var idx = line.IndexOf("mailto:", StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return null;
        var value = line[(idx + "mailto:".Length)..].Trim();
        var cut = value.IndexOfAny([';', ' ', '"']);
        if (cut >= 0) value = value[..cut];
        return value.Length == 0 ? null : value.ToLowerInvariant();
    }
}

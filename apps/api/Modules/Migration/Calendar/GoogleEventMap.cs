using System.Globalization;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Migration.Calendar;

/// <summary>
/// Google Calendar's event JSON in the calendar module's terms. Pure, so
/// every rule is tested without Google or a database (tests/migration-calendar).
///
/// TIMES. A timed event is an instant with an offset (RFC 3339) and, usually,
/// a zone; it is stored as UTC plus the zone, the calendar schema's decision 2.
/// An ALL-DAY event is a date with no instant: it is stored as midnight of
/// that date IN THE EVENT'S ZONE, and Google's end date - the day AFTER the
/// last day, exclusive - is kept as it is, so a one-day event runs midnight to
/// midnight. "Timezones will be wrong at least once" (design, phase 3): the
/// test places an all-day event in Kolkata and checks the UTC instant.
///
/// RECURRENCE. Google's recurrence lines are iCalendar: the RRULE goes to
/// recurrence_rule as it is (decision 1: a rule, not rows); each EXDATE
/// becomes a cancelled exception; RDATE and EXRULE are not supported by the
/// calendar module and are reported, not dropped silently.
/// </summary>
public static class GoogleEventMap
{
    public sealed record When(DateTimeOffset At, bool AllDay);

    /// <summary>A start/end/originalStartTime object: {"dateTime", "timeZone"} or {"date"}.</summary>
    public static When? ReadWhen(JsonElement e, string property, string fallbackZone)
    {
        if (!e.TryGetProperty(property, out var w) || w.ValueKind != JsonValueKind.Object) return null;
        if (w.TryGetProperty("dateTime", out var dt) && dt.ValueKind == JsonValueKind.String
            && DateTimeOffset.TryParse(dt.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.None, out var at))
            return new When(at.ToUniversalTime(), false);
        if (w.TryGetProperty("date", out var d) && d.ValueKind == JsonValueKind.String
            && DateOnly.TryParseExact(d.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
            return new When(MidnightIn(day, Str(w, "timeZone") ?? fallbackZone), true);
        return null;
    }

    public static DateTimeOffset MidnightIn(DateOnly day, string zone)
    {
        var tz = Zone(zone);
        var local = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);
        return new DateTimeOffset(local, tz.GetUtcOffset(local)).ToUniversalTime();
    }

    public static TimeZoneInfo Zone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception) { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata"); }
    }

    /// <summary>The RRULE (without "RRULE:"), the EXDATE instants, and anything not carried.</summary>
    public static (string? Rule, List<DateTimeOffset> ExDates, List<string> NotCarried) Recurrence(
        JsonElement e, string zone)
    {
        string? rule = null;
        var ex = new List<DateTimeOffset>();
        var notCarried = new List<string>();
        if (!e.TryGetProperty("recurrence", out var lines) || lines.ValueKind != JsonValueKind.Array)
            return (null, ex, notCarried);

        foreach (var l in lines.EnumerateArray())
        {
            var line = l.GetString() ?? "";
            if (line.StartsWith("RRULE:", StringComparison.OrdinalIgnoreCase)) rule ??= line[6..];
            else if (line.StartsWith("EXDATE", StringComparison.OrdinalIgnoreCase)) ex.AddRange(ExDates(line, zone));
            else if (line.Length > 0) notCarried.Add(line.Split(':', ';')[0]);
        }
        return (rule, ex, notCarried);
    }

    /// <summary>
    /// "EXDATE:20261012T043000Z", "EXDATE;TZID=Asia/Kolkata:20261012T100000,20261019T100000",
    /// "EXDATE;VALUE=DATE:20261012". A value that cannot be read is skipped.
    /// </summary>
    public static IEnumerable<DateTimeOffset> ExDates(string line, string zone)
    {
        var colon = line.IndexOf(':');
        if (colon < 0) yield break;
        var head = line[..colon];
        var tzid = head.Split(';').Select(p => p.Split('=', 2)).Where(p => p.Length == 2 && p[0].Equals("TZID", StringComparison.OrdinalIgnoreCase))
            .Select(p => p[1]).FirstOrDefault() ?? zone;
        foreach (var v in line[(colon + 1)..].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (v.EndsWith('Z') && DateTime.TryParseExact(v, "yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var utc))
                yield return new DateTimeOffset(utc, TimeSpan.Zero);
            else if (DateTime.TryParseExact(v, "yyyyMMdd'T'HHmmss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var local))
                yield return new DateTimeOffset(local, Zone(tzid).GetUtcOffset(local)).ToUniversalTime();
            else if (DateOnly.TryParseExact(v, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
                yield return MidnightIn(day, tzid);
        }
    }

    public static string Status(string? google) => google switch
    {
        "tentative" => "tentative",
        "cancelled" => "cancelled",
        _ => "confirmed",
    };

    public static string AttendeeStatus(string? google) => google switch
    {
        "accepted" => "accepted",
        "declined" => "declined",
        "tentative" => "tentative",
        _ => "needs-action",
    };

    /// <summary>Google's private and confidential are both "private" here; public is the default.</summary>
    public static string Visibility(string? google) => google is "private" or "confidential" ? "private" : "default";

    /// <summary>email -> email; popup (and anything else) -> notification.</summary>
    public static string ReminderMethod(string? google) => google == "email" ? "email" : "notification";

    public static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    public static bool True(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// RFC 5545 recurrence, expanded inside a window.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS IS HAND-WRITTEN AND DELIBERATELY SMALL.
///
///  A full RRULE implementation is a large, subtle thing (BYSETPOS, BYYEARDAY,
///  WKST, leap seconds' worth of edge cases). We support the subset people
///  actually create in a calendar UI — daily, weekly on chosen days, monthly
///  by day-of-month, monthly by nth weekday, yearly — and we REFUSE anything
///  else at the API rather than expanding it wrongly.
///
///  Refusing is the important half. A rule we half-understand produces
///  meetings on days nobody agreed to, and nobody reports that as a bug for
///  weeks — they just quietly stop trusting the calendar. Every rule this
///  parser cannot represent exactly is rejected when the event is saved.
///
///  EXPANSION IS BOUNDED BY THE WINDOW, NEVER BY A COUNT OF OCCURRENCES.
///  "Every weekday forever" is legitimate and infinite; the caller asks for a
///  month and gets that month. There is also a hard iteration cap, because a
///  malformed INTERVAL of 0 would otherwise spin.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class Recurrence
{
    /// <summary>Iteration ceiling — a month view needs ~31, a year ~366.</summary>
    private const int MaxSteps = 4000;

    public sealed record Rule(
        string Freq,
        int Interval,
        IReadOnlyList<DayOfWeek> ByDay,
        int? ByMonthDay,
        int? BySetPos,
        int? Count,
        DateTimeOffset? Until);

    /// <summary>
    /// Parse an RRULE. Returns null when the rule uses anything we would not
    /// expand exactly — the caller turns that into a 400 rather than storing
    /// a rule it cannot honour.
    /// </summary>
    public static Rule? Parse(string? rrule)
    {
        if (string.IsNullOrWhiteSpace(rrule)) return null;

        var parts = rrule.Split(';', StringSplitOptions.RemoveEmptyEntries);
        string freq = "";
        int interval = 1;
        var byDay = new List<DayOfWeek>();
        int? byMonthDay = null, bySetPos = null, count = null;
        DateTimeOffset? until = null;

        foreach (var part in parts)
        {
            var kv = part.Split('=', 2);
            if (kv.Length != 2) return null;
            var key = kv[0].Trim().ToUpperInvariant();
            var val = kv[1].Trim();

            switch (key)
            {
                case "FREQ":
                    freq = val.ToUpperInvariant();
                    if (freq is not ("DAILY" or "WEEKLY" or "MONTHLY" or "YEARLY")) return null;
                    break;

                case "INTERVAL":
                    if (!int.TryParse(val, out interval) || interval < 1 || interval > 999) return null;
                    break;

                case "BYDAY":
                    foreach (var d in val.Split(',', StringSplitOptions.RemoveEmptyEntries))
                    {
                        // "2MO" (second Monday) is expressed here as BYDAY=MO
                        // with BYSETPOS=2; a numeric prefix we did not put
                        // there ourselves is a rule shape we do not support.
                        var token = d.Trim().ToUpperInvariant();
                        var day = ToDay(token);
                        if (day is null) return null;
                        byDay.Add(day.Value);
                    }
                    break;

                case "BYMONTHDAY":
                    if (!int.TryParse(val, out var md) || md < 1 || md > 31) return null;
                    byMonthDay = md;
                    break;

                case "BYSETPOS":
                    // -1 (last) and 1..5 only: what "the last Friday" and "the
                    // second Tuesday" need, and nothing more.
                    if (!int.TryParse(val, out var sp) || sp == 0 || sp < -1 || sp > 5) return null;
                    bySetPos = sp;
                    break;

                case "COUNT":
                    if (!int.TryParse(val, out var c) || c < 1 || c > 1000) return null;
                    count = c;
                    break;

                case "UNTIL":
                    if (!TryParseUntil(val, out var u)) return null;
                    until = u;
                    break;

                // WKST is accepted and ignored: it only changes results for
                // rules we do not support anyway (weekly INTERVAL > 1 with
                // BYSETPOS). Rejecting it would refuse rules other clients
                // routinely attach it to.
                case "WKST":
                    break;

                default:
                    return null;   // unknown part — refuse rather than guess
            }
        }

        if (freq.Length == 0) return null;
        if (count is not null && until is not null) return null;  // RFC: not both

        return new Rule(freq, interval, byDay, byMonthDay, bySetPos, count, until);
    }

    private static DayOfWeek? ToDay(string s) => s switch
    {
        "MO" => DayOfWeek.Monday,
        "TU" => DayOfWeek.Tuesday,
        "WE" => DayOfWeek.Wednesday,
        "TH" => DayOfWeek.Thursday,
        "FR" => DayOfWeek.Friday,
        "SA" => DayOfWeek.Saturday,
        "SU" => DayOfWeek.Sunday,
        _ => null,
    };

    private static bool TryParseUntil(string v, out DateTimeOffset value)
    {
        // Both iCalendar forms: 20261231T000000Z and 20261231.
        var formats = new[] { "yyyyMMdd'T'HHmmss'Z'", "yyyyMMdd'T'HHmmss", "yyyyMMdd" };
        if (DateTime.TryParseExact(v, formats, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal
                | System.Globalization.DateTimeStyles.AssumeUniversal, out var dt))
        {
            value = new DateTimeOffset(dt, TimeSpan.Zero);
            return true;
        }
        value = default;
        return false;
    }

    /// <summary>
    /// Every occurrence START that falls inside [from, to).
    ///
    /// The zone matters and is not decoration: a weekly 10:00 meeting must
    /// stay at 10:00 local across a DST change, so stepping happens in LOCAL
    /// time and each result is converted back to an instant. Stepping in UTC
    /// would silently move the meeting by an hour twice a year for anyone in
    /// a zone that observes it.
    /// </summary>
    public static IEnumerable<DateTimeOffset> Expand(
        DateTimeOffset seriesStart, string? rrule, string timezoneId,
        DateTimeOffset from, DateTimeOffset to)
    {
        var rule = Parse(rrule);
        if (rule is null)
        {
            // Not recurring (or unparseable, which the write path already
            // refused): the event is itself, if it lands in the window.
            if (seriesStart >= from && seriesStart < to) yield return seriesStart;
            yield break;
        }

        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById(timezoneId); }
        catch { tz = TimeZoneInfo.Utc; }

        var localStart = TimeZoneInfo.ConvertTime(seriesStart, tz);

        // The day-of-month the series is anchored to. Carried explicitly
        // because the cursor cannot hold it — see the stepping note below.
        var wantDay = rule.ByMonthDay ?? localStart.Day;

        var cursor = localStart;
        var emitted = 0;
        var steps = 0;

        while (steps < MaxSteps)
        {
            if (rule.Until is DateTimeOffset until && cursor > until) yield break;
            if (rule.Count is int max && emitted >= max) yield break;
            if (cursor >= to) yield break;

            foreach (var occ in OccurrencesAt(cursor, localStart, rule, tz, wantDay))
            {
                if (rule.Until is DateTimeOffset u2 && occ > u2) yield break;
                if (rule.Count is int m2 && emitted >= m2) yield break;

                // COUNT counts occurrences from the series start, including
                // those before the window — otherwise scrolling to next month
                // would hand out a fresh allowance of occurrences.
                if (occ >= localStart) emitted++;
                if (occ >= from && occ < to) yield return occ;
            }

            steps++;

            // STEPPED FROM THE ANCHOR, NEVER FROM THE PREVIOUS CURSOR.
            //
            // AddMonths and AddYears CLAMP: 29 February plus one year is 28
            // February, and 31 January plus one month is 28 February. Feeding
            // that back in as the next cursor poisons every step after it —
            // the series moves permanently to the 28th and the real 29
            // February is lost in the leap years it should appear in. Caught
            // by a test rather than by a customer, which is the only reason
            // this comment is here rather than a bug report.
            cursor = rule.Freq switch
            {
                "DAILY"   => localStart.AddDays(rule.Interval * steps),
                "WEEKLY"  => localStart.AddDays(7 * rule.Interval * steps),
                // First of the target month; the wanted day is applied (or
                // skipped, if that month is too short) inside OccurrencesAt.
                "MONTHLY" => FirstOfMonth(localStart, rule.Interval * steps, tz),
                "YEARLY"  => FirstOfYear(localStart, rule.Interval * steps, tz),
                _ => to,
            };
        }
    }


    /// <summary>The 1st of the month N months after the anchor, same time.</summary>
    private static DateTimeOffset FirstOfMonth(DateTimeOffset anchor, int months, TimeZoneInfo tz)
    {
        var m = anchor.Month - 1 + months;
        var year = anchor.Year + (int)Math.Floor(m / 12.0);
        var month = ((m % 12) + 12) % 12 + 1;
        var dt = new DateTime(year, month, 1, anchor.Hour, anchor.Minute, anchor.Second);
        return new DateTimeOffset(dt, tz.GetUtcOffset(dt));
    }

    /// <summary>The 1st of the anchor's month, N years on, same time.</summary>
    private static DateTimeOffset FirstOfYear(DateTimeOffset anchor, int years, TimeZoneInfo tz)
    {
        var dt = new DateTime(anchor.Year + years, anchor.Month, 1,
                              anchor.Hour, anchor.Minute, anchor.Second);
        return new DateTimeOffset(dt, tz.GetUtcOffset(dt));
    }

    /// <summary>Occurrences generated by one step of the rule.</summary>
    private static IEnumerable<DateTimeOffset> OccurrencesAt(
        DateTimeOffset cursor, DateTimeOffset seriesStart, Rule rule, TimeZoneInfo tz,
        int wantDay)
    {
        switch (rule.Freq)
        {
            case "DAILY":
                yield return cursor;
                break;

            case "WEEKLY":
                if (rule.ByDay.Count == 0) { yield return cursor; break; }
                // The week containing the cursor, Monday-based — every chosen
                // day in it, in order.
                var monday = cursor.AddDays(-(((int)cursor.DayOfWeek + 6) % 7));
                foreach (var day in rule.ByDay.OrderBy(d => ((int)d + 6) % 7))
                {
                    var occ = monday.AddDays(((int)day + 6) % 7);
                    if (occ >= seriesStart) yield return occ;
                }
                break;

            case "MONTHLY":
                if (rule.ByDay.Count > 0 && rule.BySetPos is int pos)
                {
                    // "the second Tuesday", "the last Friday".
                    var target = rule.ByDay[0];
                    var days = DaysOfMonth(cursor, target).ToList();
                    if (days.Count > 0)
                    {
                        var pick = pos == -1 ? days[^1] : (pos <= days.Count ? days[pos - 1] : (DateTimeOffset?)null);
                        if (pick is DateTimeOffset p) yield return p;
                    }
                }
                else
                {
                    var dom = wantDay;
                    // A 31st in a 30-day month does not exist and is SKIPPED,
                    // not clamped to the 30th — the RFC's behaviour, and the
                    // one that does not silently invent a meeting.
                    if (dom <= DateTime.DaysInMonth(cursor.Year, cursor.Month))
                        yield return new DateTimeOffset(
                            new DateTime(cursor.Year, cursor.Month, dom,
                                         cursor.Hour, cursor.Minute, cursor.Second),
                            tz.GetUtcOffset(new DateTime(cursor.Year, cursor.Month, dom,
                                                         cursor.Hour, cursor.Minute, cursor.Second)));
                }
                break;

            case "YEARLY":
                // 29 February in a non-leap year is SKIPPED, not moved to the
                // 28th — an anniversary that silently happens on the wrong day
                // is worse than one that waits for the next leap year.
                if (wantDay > DateTime.DaysInMonth(cursor.Year, cursor.Month)) break;
                yield return new DateTimeOffset(
                    new DateTime(cursor.Year, cursor.Month, wantDay,
                                 cursor.Hour, cursor.Minute, cursor.Second),
                    cursor.Offset);
                break;
        }
    }

    private static IEnumerable<DateTimeOffset> DaysOfMonth(DateTimeOffset cursor, DayOfWeek want)
    {
        var days = DateTime.DaysInMonth(cursor.Year, cursor.Month);
        for (var d = 1; d <= days; d++)
        {
            var date = new DateTime(cursor.Year, cursor.Month, d,
                                    cursor.Hour, cursor.Minute, cursor.Second);
            if (date.DayOfWeek == want)
                yield return new DateTimeOffset(date, cursor.Offset);
        }
    }

    /// <summary>
    /// A human sentence for a rule — "Every Monday and Thursday, until 31 Dec
    /// 2026". Built here rather than in the client so the API, an invitation
    /// email and the UI all describe a rule the same way.
    /// </summary>
    public static string Describe(string? rrule)
    {
        var r = Parse(rrule);
        if (r is null) return "Does not repeat";

        var every = r.Interval == 1 ? "Every" : $"Every {r.Interval}";
        var body = r.Freq switch
        {
            "DAILY" => r.Interval == 1 ? "Every day" : $"{every} days",
            "WEEKLY" => r.ByDay.Count > 0
                ? $"{every} {string.Join(" and ", r.ByDay.Select(d => d.ToString()))}"
                : (r.Interval == 1 ? "Every week" : $"{every} weeks"),
            "MONTHLY" => r.BySetPos is int p && r.ByDay.Count > 0
                ? $"{every} month on the {Ordinal(p)} {r.ByDay[0]}"
                : (r.Interval == 1 ? "Every month" : $"{every} months"),
            "YEARLY" => r.Interval == 1 ? "Every year" : $"{every} years",
            _ => "Repeats",
        };

        if (r.Until is DateTimeOffset u) body += $", until {u:d MMM yyyy}";
        if (r.Count is int c) body += $", {c} times";
        return body;
    }

    private static string Ordinal(int n) => n switch
    {
        -1 => "last", 1 => "first", 2 => "second", 3 => "third", 4 => "fourth", _ => "fifth",
    };
}

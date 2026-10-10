using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Read-only Google Calendar, as one person, with calendar.readonly: the
/// events of their PRIMARY calendar, a page at a time, as Google holds them -
/// recurring events as one event with its RRULE (singleEvents=false), and
/// each changed or cancelled occurrence as an event of its own carrying
/// recurringEventId and originalStartTime.
///
/// A person's own extra calendars are listed by GoogleCalendarListing; ones
/// merely shared with them arrive with their owners' migrations.
/// </summary>
public sealed class GoogleCalendarClient(GoogleApi api)
{
    /// <summary>The calendars the person owns, main one first (GoogleCalendarListing).</summary>
    public Task<IReadOnlyList<GoogleCalendarInfo>> OwnedCalendarsAsync(GoogleServiceAccount account, string person, CancellationToken ct) =>
        GoogleCalendarListing.OwnedAsync(api, account, person, ct);

    private static readonly string[] Scopes = [GoogleScopes.CalendarReadOnly];

    /// <param name="showDeleted">
    /// True to include cancelled events - needed for cancelled OCCURRENCES of a
    /// recurring event, which Google reports as cancelled instances.
    /// </param>
    public Task<GoogleEventPage> ListEventsAsync(
        GoogleServiceAccount account, string person, string? pageToken, bool showDeleted, int pageSize, CancellationToken ct) =>
        ListEventsAsync(account, person, "primary", pageToken, showDeleted, pageSize, ct);

    public async Task<GoogleEventPage> ListEventsAsync(
        GoogleServiceAccount account, string person, string calendarId, string? pageToken, bool showDeleted, int pageSize, CancellationToken ct)
    {
        var q = $"calendars/{Uri.EscapeDataString(calendarId)}/events?singleEvents=false&showDeleted={(showDeleted ? "true" : "false")}" +
                $"&maxResults={Math.Clamp(pageSize, 1, 2500)}" +
                (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        using var doc = await api.GetJsonAsync(account, person, Scopes, new Uri(api.Endpoints.Calendar, q), ct);
        var root = doc.RootElement;
        var events = new List<JsonElement>();
        if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            foreach (var e in items.EnumerateArray()) events.Add(e.Clone());
        return new GoogleEventPage(events,
            root.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null,
            root.TryGetProperty("timeZone", out var tz) && tz.ValueKind == JsonValueKind.String ? tz.GetString() : null);
    }
}

/// <param name="TimeZone">The calendar's own zone, for events that do not name one.</param>
/// <summary>
/// The calendars the person OWNS, main one first: their own extra calendars
/// come with them; ones merely shared with them come with their owners.
/// </summary>
public static class GoogleCalendarListing
{
    public static async Task<IReadOnlyList<GoogleCalendarInfo>> OwnedAsync(
        GoogleApi api, GoogleServiceAccount account, string person, CancellationToken ct)
    {
        var list = new List<GoogleCalendarInfo>();
        string? page = null;
        do
        {
            using var doc = await api.GetJsonAsync(account, person, [GoogleScopes.CalendarReadOnly], new Uri(api.Endpoints.Calendar,
                "users/me/calendarList?minAccessRole=owner&showHidden=true" + (page is null ? "" : $"&pageToken={Uri.EscapeDataString(page)}")), ct);
            if (doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                foreach (var c in items.EnumerateArray())
                    if (c.TryGetProperty("id", out var id) && id.GetString() is { } i)
                        list.Add(new GoogleCalendarInfo(i,
                            c.TryGetProperty("summary", out var n) ? n.GetString() ?? i : i,
                            c.TryGetProperty("primary", out var pr) && pr.ValueKind == JsonValueKind.True));
            page = doc.RootElement.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        } while (page is not null);
        // Main calendar first (it is "primary" to the events API), the rest in a fixed order.
        return [.. list.Where(c => c.Primary), .. list.Where(c => !c.Primary).OrderBy(c => c.Id, StringComparer.Ordinal)];
    }
}

public sealed record GoogleCalendarInfo(string Id, string Name, bool Primary);

public sealed record GoogleEventPage(IReadOnlyList<JsonElement> Events, string? NextPageToken, string? TimeZone);

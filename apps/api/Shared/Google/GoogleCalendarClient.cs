using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Read-only Google Calendar, as one person, with calendar.readonly: the
/// events of their PRIMARY calendar, a page at a time, as Google holds them -
/// recurring events as one event with its RRULE (singleEvents=false), and
/// each changed or cancelled occurrence as an event of its own carrying
/// recurringEventId and originalStartTime.
///
/// Secondary calendars (a person's own extra calendars, and the ones shared
/// with them) are not read yet - a follow-up, said rather than hidden.
/// </summary>
public sealed class GoogleCalendarClient(GoogleApi api)
{
    private static readonly string[] Scopes = [GoogleScopes.CalendarReadOnly];

    /// <param name="showDeleted">
    /// True to include cancelled events - needed for cancelled OCCURRENCES of a
    /// recurring event, which Google reports as cancelled instances.
    /// </param>
    public async Task<GoogleEventPage> ListEventsAsync(
        GoogleServiceAccount account, string person, string? pageToken, bool showDeleted, int pageSize, CancellationToken ct)
    {
        var q = $"calendars/primary/events?singleEvents=false&showDeleted={(showDeleted ? "true" : "false")}" +
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
public sealed record GoogleEventPage(IReadOnlyList<JsonElement> Events, string? NextPageToken, string? TimeZone);

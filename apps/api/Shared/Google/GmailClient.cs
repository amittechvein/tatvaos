using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Read-only Gmail, as one person in the customer's domain.
///
/// Phase 0: the profile and the labels with their counts (migration design,
/// section 4: "prove the client by listing one mailbox's folders and counts").
/// Phase 1: message ids a page at a time, and each message raw, with its
/// labels. Mapping labels to folders is GmailLabelMap's job, not this one's.
/// </summary>
public sealed class GmailClient(GoogleApi api)
{
    private static readonly string[] Scopes = [GoogleScopes.GmailReadOnly];

    public async Task<GmailProfile> GetProfileAsync(GoogleServiceAccount account, string person, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, person, Scopes, Url(person, "profile"), ct);
        var r = doc.RootElement;
        return new GmailProfile(
            Str(r, "emailAddress") ?? person,
            Long(r, "messagesTotal"),
            Long(r, "threadsTotal"));
    }

    /// <summary>
    /// Every label, with its message count. labels.list does not carry counts,
    /// so each label is fetched once more - a mailbox has tens of labels, not
    /// thousands, and GoogleApi absorbs the throttling.
    /// </summary>
    public async Task<IReadOnlyList<GmailLabel>> ListLabelsAsync(GoogleServiceAccount account, string person, CancellationToken ct)
    {
        var ids = new List<(string Id, string Name, string Type)>();
        using (var doc = await api.GetJsonAsync(account, person, Scopes, Url(person, "labels"), ct))
        {
            if (doc.RootElement.TryGetProperty("labels", out var labels) && labels.ValueKind == JsonValueKind.Array)
                foreach (var l in labels.EnumerateArray())
                    if (Str(l, "id") is { } id)
                        ids.Add((id, Str(l, "name") ?? id, Str(l, "type") ?? "user"));
        }

        var result = new List<GmailLabel>(ids.Count);
        foreach (var (id, name, type) in ids)
        {
            using var doc = await api.GetJsonAsync(account, person, Scopes,
                Url(person, $"labels/{Uri.EscapeDataString(id)}"), ct);
            result.Add(new GmailLabel(id, name, type,
                Long(doc.RootElement, "messagesTotal"), Long(doc.RootElement, "threadsTotal")));
        }
        return result;
    }

    /// <summary>The person's USER labels, id -> name. One call; no counts.</summary>
    public async Task<IReadOnlyDictionary<string, string>> UserLabelNamesAsync(
        GoogleServiceAccount account, string person, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, person, Scopes, Url(person, "labels"), ct);
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        if (doc.RootElement.TryGetProperty("labels", out var labels) && labels.ValueKind == JsonValueKind.Array)
            foreach (var l in labels.EnumerateArray())
                if (Str(l, "type") == "user" && Str(l, "id") is { } id)
                    names[id] = Str(l, "name") ?? id;
        return names;
    }

    /// <summary>
    /// One page of message ids, oldest pages last (Gmail's own order). Spam and
    /// trash INCLUDED: what is in them is the customer's, and GmailLabelMap
    /// puts it back where it was. <paramref name="pageToken"/> null = first page.
    /// </summary>
    public async Task<GmailMessagePage> ListMessageIdsAsync(
        GoogleServiceAccount account, string person, string? pageToken, int pageSize, CancellationToken ct)
    {
        var q = $"messages?includeSpamTrash=true&maxResults={Math.Clamp(pageSize, 1, 500)}" +
                (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        using var doc = await api.GetJsonAsync(account, person, Scopes, Url(person, q), ct);
        var ids = new List<string>();
        if (doc.RootElement.TryGetProperty("messages", out var ms) && ms.ValueKind == JsonValueKind.Array)
            foreach (var m in ms.EnumerateArray())
                if (Str(m, "id") is { } id) ids.Add(id);
        return new GmailMessagePage(ids, Str(doc.RootElement, "nextPageToken"),
            doc.RootElement.TryGetProperty("resultSizeEstimate", out var e) && e.TryGetInt64(out var n) ? n : null);
    }

    /// <summary>The whole message as sent (RFC 822), with its labels and Gmail's received time.</summary>
    public async Task<GmailRawMessage> GetRawAsync(
        GoogleServiceAccount account, string person, string id, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, person, Scopes,
            Url(person, $"messages/{Uri.EscapeDataString(id)}?format=raw"), ct);
        var r = doc.RootElement;
        var raw = Str(r, "raw") ?? throw new GoogleApiException(200, "noRaw", $"message {id} came back without its raw body", 1);
        var labels = new List<string>();
        if (r.TryGetProperty("labelIds", out var ls) && ls.ValueKind == JsonValueKind.Array)
            foreach (var l in ls.EnumerateArray())
                if (l.ValueKind == JsonValueKind.String) labels.Add(l.GetString()!);
        // internalDate: milliseconds since the epoch, as a STRING.
        var internalDate = Str(r, "internalDate") is { } ms && long.TryParse(ms, out var millis)
            ? DateTimeOffset.FromUnixTimeMilliseconds(millis) : (DateTimeOffset?)null;
        return new GmailRawMessage(id, Base64Url(raw), labels, internalDate);
    }

    private static byte[] Base64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s + new string('=', (4 - s.Length % 4) % 4));
    }

    private Uri Url(string person, string path) =>
        new(api.Endpoints.Gmail, $"users/{Uri.EscapeDataString(person)}/{path}");

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long Long(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}

public sealed record GmailProfile(string EmailAddress, long MessagesTotal, long ThreadsTotal);

public sealed record GmailMessagePage(IReadOnlyList<string> Ids, string? NextPageToken, long? ResultSizeEstimate);

/// <param name="Raw">The RFC 822 bytes exactly as Gmail holds them.</param>
/// <param name="InternalDate">When Gmail received it - becomes the IMAP internal date.</param>
public sealed record GmailRawMessage(string Id, byte[] Raw, IReadOnlyList<string> LabelIds, DateTimeOffset? InternalDate);

/// <param name="Type">"system" (INBOX, SENT, IMPORTANT ...) or "user".</param>
public sealed record GmailLabel(string Id, string Name, string Type, long MessagesTotal, long ThreadsTotal);

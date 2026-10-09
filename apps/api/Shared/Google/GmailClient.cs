using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Read-only Gmail, as one person in the customer's domain. Phase 0 needs
/// only what proves the client end to end and feeds the size estimate: the
/// mailbox's profile and its labels with their counts (migration design,
/// section 4: "prove the client by listing one mailbox's folders and counts").
///
/// Fetching messages, and mapping labels to folders (section 5: All Mail,
/// Important and the other system labels are not folders), are phase 1.
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

    private Uri Url(string person, string path) =>
        new(api.Endpoints.Gmail, $"users/{Uri.EscapeDataString(person)}/{path}");

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long Long(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}

public sealed record GmailProfile(string EmailAddress, long MessagesTotal, long ThreadsTotal);

/// <param name="Type">"system" (INBOX, SENT, IMPORTANT ...) or "user".</param>
public sealed record GmailLabel(string Id, string Name, string Type, long MessagesTotal, long ThreadsTotal);

using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Read-only Google Contacts (the People API), as one person, with
/// contacts.readonly. Their "My Contacts", a page at a time, and the names of
/// their contact groups (which become labels here).
///
/// Also "Other contacts" - the addresses Gmail saved automatically from mail
/// (ListOtherAsync), with their own scope, contacts.other.readonly.
/// </summary>
public sealed class GoogleContactsClient(GoogleApi api)
{
    private static readonly string[] Scopes = [GoogleScopes.ContactsReadOnly];
    private const string Fields =
        "names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,biographies,birthdays,memberships";

    public async Task<GooglePeoplePage> ListAsync(
        GoogleServiceAccount account, string person, string? pageToken, int pageSize, CancellationToken ct)
    {
        var q = $"people/me/connections?personFields={Fields}&pageSize={Math.Clamp(pageSize, 1, 1000)}&sortOrder=FIRST_NAME_ASCENDING" +
                (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        using var doc = await api.GetJsonAsync(account, person, Scopes, new Uri(api.Endpoints.People, q), ct);
        var root = doc.RootElement;
        var people = new List<JsonElement>();
        if (root.TryGetProperty("connections", out var cs) && cs.ValueKind == JsonValueKind.Array)
            foreach (var c in cs.EnumerateArray()) people.Add(c.Clone());
        return new GooglePeoplePage(people,
            root.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null,
            root.TryGetProperty("totalPeople", out var n) && n.TryGetInt64(out var total) ? total : null);
    }

    /// <summary>
    /// Gmail's "Other contacts" (otherContacts.list, contacts.other.readonly):
    /// the addresses Gmail saved from mail the person exchanged. Names,
    /// addresses and numbers only - that is all Google keeps for them.
    /// </summary>
    public async Task<GooglePeoplePage> ListOtherAsync(
        GoogleServiceAccount account, string person, string? pageToken, int pageSize, CancellationToken ct)
    {
        var q = $"otherContacts?readMask=names,emailAddresses,phoneNumbers&pageSize={Math.Clamp(pageSize, 1, 1000)}" +
                (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        using var doc = await api.GetJsonAsync(account, person, [GoogleScopes.OtherContactsReadOnly], new Uri(api.Endpoints.People, q), ct);
        var root = doc.RootElement;
        var people = new List<JsonElement>();
        if (root.TryGetProperty("otherContacts", out var cs) && cs.ValueKind == JsonValueKind.Array)
            foreach (var c in cs.EnumerateArray()) people.Add(c.Clone());
        return new GooglePeoplePage(people,
            root.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null,
            root.TryGetProperty("totalSize", out var n) && n.TryGetInt64(out var total) ? total : null);
    }

    /// <summary>The person's own contact groups: resource name -> name.</summary>
    public async Task<IReadOnlyDictionary<string, string>> GroupNamesAsync(
        GoogleServiceAccount account, string person, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, person, Scopes,
            new Uri(api.Endpoints.People, "contactGroups?pageSize=1000&groupFields=name,groupType"), ct);
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        if (doc.RootElement.TryGetProperty("contactGroups", out var gs) && gs.ValueKind == JsonValueKind.Array)
            foreach (var g in gs.EnumerateArray())
                if (g.TryGetProperty("groupType", out var type) && type.GetString() == "USER_CONTACT_GROUP"
                    && g.TryGetProperty("resourceName", out var rn) && g.TryGetProperty("name", out var name))
                    names[rn.GetString()!] = name.GetString() ?? rn.GetString()!;
        return names;
    }
}

/// <param name="People">Each person as Google's JSON (cloned; safe to keep).</param>
public sealed record GooglePeoplePage(IReadOnlyList<JsonElement> People, string? NextPageToken, long? TotalPeople);

using System.Text.Json;
using TatvaOS.Api.Modules.Family;

namespace TatvaOS.Api.Modules.Migration.Contacts;

/// <summary>
/// One Google People API person -> the ContactRecord the existing importer
/// takes (Modules/Family/ContactImport.cs). Everything type-shaped goes
/// through ContactTypes, the importer's own single mapping - its comment
/// explains why: the three tables' CHECK constraints differ, and Google's
/// "home" email must become "personal" in ONE place, not three.
///
/// Labels: the person's own groups (USER_CONTACT_GROUP) by name; the starred
/// system group becomes IsFavourite; "myContacts" and the other system groups
/// are not labels.
/// </summary>
public static class GooglePersonMap
{
    public static ContactRecord ToRecord(JsonElement p, IReadOnlyDictionary<string, string> groupNames)
    {
        var r = new ContactRecord();

        var name = Primary(p, "names");
        if (name is { } n)
        {
            r.DisplayName = Str(n, "displayName");
            r.FirstName = Str(n, "givenName");
            r.MiddleName = Str(n, "middleName");
            r.LastName = Str(n, "familyName");
        }
        if (Primary(p, "nicknames") is { } nick) r.Nickname = Str(nick, "value");
        if (Primary(p, "organizations") is { } org)
        {
            r.CompanyName = Str(org, "name");
            r.JobTitle = Str(org, "title");
        }
        if (Primary(p, "biographies") is { } bio) r.Notes = Str(bio, "value");
        if (Primary(p, "birthdays") is { } b && b.TryGetProperty("date", out var d))
            r.Birthday = Date(d);

        foreach (var e in All(p, "emailAddresses"))
            if (Str(e, "value") is { Length: > 0 } v)
                r.Emails.Add(new LabelledValue { Value = v.Trim(), Type = ContactTypes.Email(Str(e, "type")) });
        foreach (var ph in All(p, "phoneNumbers"))
            if (Str(ph, "value") is { Length: > 0 } v)
                r.Phones.Add(new LabelledValue { Value = v.Trim(), Type = ContactTypes.Phone(Str(ph, "type")) });
        foreach (var a in All(p, "addresses"))
        {
            var post = new PostalRecord
            {
                Type = ContactTypes.Address(Str(a, "type")),
                Street1 = Str(a, "streetAddress"),
                Street2 = Str(a, "extendedAddress"),
                City = Str(a, "city"),
                Region = Str(a, "region"),
                Postcode = Str(a, "postalCode"),
                Country = Str(a, "country"),
            };
            if (!post.IsEmpty) r.Addresses.Add(post);
        }

        foreach (var m in All(p, "memberships"))
            if (m.TryGetProperty("contactGroupMembership", out var g)
                && Str(g, "contactGroupResourceName") is { } rn)
            {
                if (rn == "contactGroups/starred") r.IsFavourite = true;
                else if (groupNames.TryGetValue(rn, out var label)) r.Labels.Add(label);
            }
        return r;
    }

    /// <summary>Google's id for the person, e.g. "people/c123" - the job's source id.</summary>
    public static string? ResourceName(JsonElement p) => Str(p, "resourceName");

    private static IEnumerable<JsonElement> All(JsonElement p, string field) =>
        p.TryGetProperty(field, out var a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray() : [];

    /// <summary>The entry Google marks primary, else the first.</summary>
    private static JsonElement? Primary(JsonElement p, string field)
    {
        JsonElement? first = null;
        foreach (var e in All(p, field))
        {
            first ??= e;
            if (e.TryGetProperty("metadata", out var md) && md.TryGetProperty("primary", out var pr) && pr.ValueKind == JsonValueKind.True)
                return e;
        }
        return first;
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    /// <summary>yyyy-mm-dd, or --mm-dd when Google has no year (as vCard writes it).</summary>
    private static string? Date(JsonElement d)
    {
        int Get(string k) => d.TryGetProperty(k, out var v) && v.TryGetInt32(out var i) ? i : 0;
        var (y, m, day) = (Get("year"), Get("month"), Get("day"));
        if (m == 0 || day == 0) return null;
        return y > 0 ? $"{y:0000}-{m:00}-{day:00}" : $"--{m:00}-{day:00}";
    }
}

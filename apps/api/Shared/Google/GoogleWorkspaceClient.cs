using System.Globalization;
using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// The two read-only questions the size estimate asks Google (migration
/// design, section 8): who is in the domain, and how much each of them holds.
///
/// WHO: the Admin SDK Directory API, acting as one of the customer's admins
/// (only an admin may list users), with admin.directory.user.readonly.
///
/// HOW MUCH: Drive's about.storageQuota, acting as each person, with
/// drive.readonly. ONE call per person. Google's storage quota is shared by
/// Gmail, Drive and Photos, and it reports usage IN DRIVE separately, so
///     mail estimate = usage - usageInDrive
///     drive estimate = usageInDrive - usageInDriveTrash
/// The mail figure includes Google Photos, so it is an OVER-estimate - the
/// safe direction for a check whose job is to refuse rather than fill a disk.
/// Counting the mail exactly would mean fetching every message's size: tens of
/// thousands of calls per person, to make a "will it fit" answer smaller.
/// Google Docs/Sheets count nothing against the quota but become .docx/.xlsx
/// files here (section 6), so the Drive figure UNDER-counts those; the report
/// says so rather than guessing a factor.
/// </summary>
public sealed class GoogleWorkspaceClient(GoogleApi api)
{
    private static readonly string[] DirectoryScopes = [GoogleScopes.DirectoryUsersReadOnly];
    private static readonly string[] DriveScopes = [GoogleScopes.DriveReadOnly];

    /// <summary>
    /// Every user in the customer's account, all pages. <paramref name="admin"/>
    /// is an administrator's address in that domain, impersonated for the call.
    /// </summary>
    public async Task<IReadOnlyList<GoogleDirectoryUser>> ListUsersAsync(
        GoogleServiceAccount account, string admin, CancellationToken ct)
    {
        var users = new List<GoogleDirectoryUser>();
        string? page = null;
        do
        {
            var url = new Uri(api.Endpoints.Directory,
                "users?customer=my_customer&maxResults=500&projection=basic" +
                (page is null ? "" : $"&pageToken={Uri.EscapeDataString(page)}"));
            using var doc = await api.GetJsonAsync(account, admin, DirectoryScopes, url, ct);
            var root = doc.RootElement;
            if (root.TryGetProperty("users", out var list) && list.ValueKind == JsonValueKind.Array)
                foreach (var u in list.EnumerateArray())
                    if (Str(u, "primaryEmail") is { Length: > 0 } email)
                        users.Add(new GoogleDirectoryUser(email,
                            u.TryGetProperty("suspended", out var s) && s.ValueKind == JsonValueKind.True,
                            u.TryGetProperty("archived", out var a) && a.ValueKind == JsonValueKind.True));
            page = Str(root, "nextPageToken");
        } while (page is not null);
        return users;
    }

    public async Task<GoogleStorageUsage> GetStorageUsageAsync(
        GoogleServiceAccount account, string person, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, person, DriveScopes,
            new Uri(api.Endpoints.Drive, "about?fields=storageQuota"), ct);
        var q = doc.RootElement.TryGetProperty("storageQuota", out var sq) ? sq : default;
        // Drive returns these int64s as STRINGS. A missing "limit" means
        // unlimited (pooled Workspace storage), not zero.
        return new GoogleStorageUsage(
            Usage: Int64(q, "usage"),
            UsageInDrive: Int64(q, "usageInDrive"),
            UsageInDriveTrash: Int64(q, "usageInDriveTrash"));
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static long Int64(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v)
            ? v.ValueKind switch
            {
                JsonValueKind.String when long.TryParse(v.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var n) => n,
                JsonValueKind.Number when v.TryGetInt64(out var n) => n,
                _ => 0,
            }
            : 0;
}

public sealed record GoogleDirectoryUser(string PrimaryEmail, bool Suspended, bool Archived);

public sealed record GoogleStorageUsage(long Usage, long UsageInDrive, long UsageInDriveTrash)
{
    /// <summary>Gmail (and Photos): an over-estimate of the mail to migrate.</summary>
    public long MailBytes => Math.Max(0, Usage - UsageInDrive);
    /// <summary>Drive files, trash excluded (trash is not migrated).</summary>
    public long DriveBytes => Math.Max(0, UsageInDrive - UsageInDriveTrash);
}

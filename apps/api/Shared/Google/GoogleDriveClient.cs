using System.Text.Json;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Read-only Google Drive, as one person, with drive.readonly: the files they
/// OWN in My Drive (not trashed, not folders), a page at a time; a folder's
/// name and parent, to rebuild where a file sits; and a file's bytes, as a
/// stream.
///
/// Files shared WITH the person but owned by someone else are not theirs to
/// bring: the owner's own migration brings them. SHARED DRIVES - owned by the
/// organisation, not a person - are listed as an admin and read as one of
/// their members (below).
/// </summary>
public sealed class GoogleDriveClient(GoogleApi api)
{
    private static readonly string[] Scopes = [GoogleScopes.DriveReadOnly];
    public const string FolderMime = "application/vnd.google-apps.folder";

    public async Task<GoogleDrivePage> ListOwnedFilesAsync(
        GoogleServiceAccount account, string person, string? pageToken, int pageSize, CancellationToken ct)
    {
        var q = Uri.EscapeDataString($"'me' in owners and trashed = false and mimeType != '{FolderMime}'");
        var url = $"files?q={q}&pageSize={Math.Clamp(pageSize, 1, 1000)}" +
                  "&fields=nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)" +
                  (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        using var doc = await api.GetJsonAsync(account, person, Scopes, new Uri(api.Endpoints.Drive, url), ct);
        var files = new List<GoogleDriveFile>();
        if (doc.RootElement.TryGetProperty("files", out var fs) && fs.ValueKind == JsonValueKind.Array)
            foreach (var f in fs.EnumerateArray())
                files.Add(Read(f));
        return new GoogleDrivePage(files,
            doc.RootElement.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null);
    }

    /// <summary>One file or folder's name and parent (folders have one parent in My Drive).</summary>
    public async Task<GoogleDriveFile> GetAsync(GoogleServiceAccount account, string person, string id, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, person, Scopes,
            new Uri(api.Endpoints.Drive, $"files/{Uri.EscapeDataString(id)}?fields=id,name,mimeType,parents&supportsAllDrives=true"), ct);
        return Read(doc.RootElement);
    }

    /// <summary>The file's bytes. The caller disposes the result.</summary>
    public Task<GoogleBody> DownloadAsync(GoogleServiceAccount account, string person, string id, CancellationToken ct) =>
        api.GetStreamAsync(account, person, Scopes, new Uri(api.Endpoints.Drive, $"files/{Uri.EscapeDataString(id)}?alt=media&supportsAllDrives=true"), ct);

    // ── Shared drives: the ORGANISATION's, not a person's ───────────────────

    /// <summary>Every shared drive in the domain, listed as an admin (useDomainAdminAccess).</summary>
    public async Task<IReadOnlyList<GoogleSharedDrive>> ListSharedDrivesAsync(
        GoogleServiceAccount account, string admin, CancellationToken ct)
    {
        var drives = new List<GoogleSharedDrive>();
        string? page = null;
        do
        {
            using var doc = await api.GetJsonAsync(account, admin, Scopes, new Uri(api.Endpoints.Drive,
                "drives?useDomainAdminAccess=true&pageSize=100" + (page is null ? "" : $"&pageToken={Uri.EscapeDataString(page)}")), ct);
            if (doc.RootElement.TryGetProperty("drives", out var ds) && ds.ValueKind == JsonValueKind.Array)
                foreach (var d in ds.EnumerateArray())
                    if (d.TryGetProperty("id", out var id) && id.GetString() is { } i)
                        drives.Add(new GoogleSharedDrive(i, d.TryGetProperty("name", out var n) ? n.GetString() ?? i : i));
            page = doc.RootElement.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        } while (page is not null);
        return drives;
    }

    /// <summary>
    /// A person who can READ the shared drive, to read it as: an admin can list
    /// a shared drive without being able to open its files. Organisers first.
    /// Null when no person in the domain is a member.
    /// </summary>
    public async Task<string?> MemberToReadAsAsync(GoogleServiceAccount account, string admin, string driveId, CancellationToken ct)
    {
        using var doc = await api.GetJsonAsync(account, admin, Scopes, new Uri(api.Endpoints.Drive,
            $"files/{Uri.EscapeDataString(driveId)}/permissions?supportsAllDrives=true&useDomainAdminAccess=true&fields=permissions(emailAddress,role,type)"), ct);
        string[] order = ["organizer", "fileOrganizer", "writer", "commenter", "reader"];
        return doc.RootElement.TryGetProperty("permissions", out var ps) && ps.ValueKind == JsonValueKind.Array
            ? ps.EnumerateArray()
                .Where(p => p.TryGetProperty("type", out var t) && t.GetString() == "user" && p.TryGetProperty("emailAddress", out _))
                .Select(p => (Email: p.GetProperty("emailAddress").GetString()!, Rank: Array.IndexOf(order, p.TryGetProperty("role", out var r) ? r.GetString() : "")))
                .Where(p => p.Rank >= 0).OrderBy(p => p.Rank).Select(p => p.Email).FirstOrDefault()
            : null;
    }

    /// <summary>A shared drive's files (not trashed, not folders), a page at a time, read as a member.</summary>
    public async Task<GoogleDrivePage> ListSharedDriveFilesAsync(
        GoogleServiceAccount account, string member, string driveId, string? pageToken, int pageSize, CancellationToken ct)
    {
        var q = Uri.EscapeDataString($"trashed = false and mimeType != '{FolderMime}'");
        var url = $"files?corpora=drive&driveId={Uri.EscapeDataString(driveId)}&includeItemsFromAllDrives=true&supportsAllDrives=true" +
                  $"&q={q}&pageSize={Math.Clamp(pageSize, 1, 1000)}&fields=nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)" +
                  (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
        using var doc = await api.GetJsonAsync(account, member, Scopes, new Uri(api.Endpoints.Drive, url), ct);
        var files = new List<GoogleDriveFile>();
        if (doc.RootElement.TryGetProperty("files", out var fs) && fs.ValueKind == JsonValueKind.Array)
            foreach (var f in fs.EnumerateArray()) files.Add(Read(f));
        return new GoogleDrivePage(files,
            doc.RootElement.TryGetProperty("nextPageToken", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null);
    }

    private static GoogleDriveFile Read(JsonElement f)
    {
        string? S(string n) => f.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var parents = f.TryGetProperty("parents", out var ps) && ps.ValueKind == JsonValueKind.Array
            ? ps.EnumerateArray().Where(p => p.ValueKind == JsonValueKind.String).Select(p => p.GetString()!).ToList()
            : [];
        // "size" is an int64 as a STRING, and absent for Google-native files.
        long? size = S("size") is { } sz && long.TryParse(sz, out var n) ? n : null;
        return new GoogleDriveFile(S("id")!, S("name") ?? "Untitled", S("mimeType") ?? "application/octet-stream", parents, size);
    }
}

public sealed record GoogleDriveFile(string Id, string Name, string MimeType, IReadOnlyList<string> Parents, long? Size);
public sealed record GoogleDrivePage(IReadOnlyList<GoogleDriveFile> Files, string? NextPageToken);
public sealed record GoogleSharedDrive(string Id, string Name);

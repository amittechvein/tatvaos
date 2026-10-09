using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Modules.Space;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Migration.Drive;

/// <summary>
/// Phase 4: the files a person owns in Google Drive into their own Space,
/// with the folder structure kept ('google_workspace' / 'drive').
///
/// ─────────────────────────────────────────────────────────────────────────
///  THROUGH SPACE'S OWN SAVE PATH: SpaceContentGateway.SaveAsync, as the
///  person - the same quota gate the upload endpoint uses (design section 8:
///  "storage quota respected"), the same blob store, the same file rows.
///  Space owns no second way in, and neither does this.
///
///  WHERE. Under a folder "Google Drive" at the top of the person's own
///  Space, the path rebuilt from each file's Drive parents ("My Drive/A/B/x"
///  -> "Google Drive/A/B/x"). Folders are found by name under their parent,
///  else created; two Drive folders with the same name in the same place
///  become one here (Space allows it, Drive allows it, the merge is the
///  honest outcome without a Drive id column on space.folders). Empty Drive
///  folders do not arrive: only the paths of files are built.
///
///  NOT GOOGLE DOCS, SHEETS OR SLIDES. They are phase 5, and section 6 says
///  plainly "do not start phase 5" until Mr. Singh has ruled. They are
///  skipped by name, with that reason, so the per-person progress counts
///  them rather than losing them. Other Google-native types (Forms, Sites,
///  shortcuts...) have no file to download and are skipped the same way.
///
///  SAFE TO REPEAT: a file already in its folder with the same name and size
///  is skipped. The ledger stops everything else.
///
///  NOT REGISTERED in Program.cs (section 9).
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GoogleDriveSource(
    GoogleDriveClient google,
    IGoogleCredentialProvider credentials,
    IServiceScopeFactory scopes,
    IConfiguration config) : IMigrationSource
{
    public const string RootFolder = "Google Drive";
    public string Source => "google_workspace";
    public string DataType => "drive";

    private int PageSize => Math.Clamp(config.GetValue("Migration:Drive:PageSize", 100), 1, 1000);

    // Drive folder id -> (name, parent id), per job, so a folder is asked
    // about once however many files sit in it.
    private readonly ConcurrentDictionary<(Guid Job, string Folder), (string Name, string? Parent)> _folders = new();

    public async Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct)
    {
        var account = await AccountAsync(job, ct);
        var page = await google.ListOwnedFilesAsync(account, job.SourceUser, job.Cursor, PageSize, ct);
        var items = page.Files.Select(f => new MigrationSourceItem(f.Id, null, f)).ToList();
        return new MigrationPage(items, page.NextPageToken, IsLast: page.NextPageToken is null);
    }

    public async Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct)
    {
        var file = (GoogleDriveFile)item.Payload!;
        if (file.MimeType.StartsWith("application/vnd.google-apps.", StringComparison.Ordinal))
            return MigrationWriteResult.Skipped(file.MimeType switch
            {
                "application/vnd.google-apps.document" or "application/vnd.google-apps.spreadsheet" or "application/vnd.google-apps.presentation"
                    => "a Google Docs/Sheets/Slides file: phase 5, waiting on Mr. Singh's ruling (design section 6)",
                _ => $"a Google-native {file.MimeType["application/vnd.google-apps.".Length..]} has no file to bring",
            });

        var account = await AccountAsync(job, ct);
        var path = await PathAsync(account, job, file, ct);

        await using var scope = scopes.CreateAsyncScope();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        tenant.Set(job.TenantId, job.TargetUserId, "employee");
        await db.SyncTenantAsync(ct);

        var folderId = await EnsureFoldersAsync(db, job, [RootFolder, .. path], ct);
        if (file.Size is long size && await db.SpaceFiles.AnyAsync(
                f => f.FolderId == folderId && f.Name == file.Name && f.SizeBytes == size && f.DeletedAt == null, ct))
            return MigrationWriteResult.Skipped("already in Space");

        using var body = await google.DownloadAsync(account, job.SourceUser, file.Id, ct);
        var gateway = scope.ServiceProvider.GetRequiredService<SpaceContentGateway>();
        var saved = await gateway.SaveAsync(body.Stream, file.Name, file.MimeType,
            file.Size ?? body.Length ?? 0, folderId, ct: ct);
        return saved.Ok
            ? MigrationWriteResult.Done(saved.File!.SizeBytes)
            : MigrationWriteResult.Failed($"Space refused it ({saved.Reason}): {saved.Error}");
    }

    /// <summary>The folder names from My Drive down to the file's folder (My Drive itself excluded).</summary>
    private async Task<List<string>> PathAsync(GoogleServiceAccount account, MigrationJobView job, GoogleDriveFile file, CancellationToken ct)
    {
        var names = new List<string>();
        var parent = file.Parents.FirstOrDefault();
        for (var depth = 0; parent is not null && depth < 64; depth++)
        {
            if (!_folders.TryGetValue((job.Id, parent), out var f))
            {
                var meta = await google.GetAsync(account, job.SourceUser, parent, ct);
                f = (meta.Name, meta.Parents.FirstOrDefault());
                _folders[(job.Id, parent)] = f;
            }
            if (f.Parent is null) break;   // the top: My Drive, which is RootFolder here
            names.Insert(0, f.Name);
            parent = f.Parent;
        }
        return names;
    }

    /// <summary>Each path segment found by name under its parent, else created - personal, the person's.</summary>
    private static async Task<Guid> EnsureFoldersAsync(AppDbContext db, MigrationJobView job, IReadOnlyList<string> path, CancellationToken ct)
    {
        Guid? parent = null;
        foreach (var raw in path)
        {
            var name = raw.Trim() is { Length: > 0 } n ? (n.Length > 300 ? n[..300] : n) : "Untitled";
            var existing = await db.SpaceFolders
                .Where(f => f.ParentFolderId == parent && f.Name == name && f.DeletedAt == null
                            && f.OwnershipType == "personal" && f.OwnerUserId == job.TargetUserId)
                .Select(f => (Guid?)f.Id).FirstOrDefaultAsync(ct);
            if (existing is Guid id) { parent = id; continue; }

            var folder = new SpaceFolder
            {
                TenantId = job.TenantId, ParentFolderId = parent, CreatedByUserId = job.TargetUserId,
                OwnershipType = "personal", OwnerUserId = job.TargetUserId, Name = name,
            };
            db.SpaceFolders.Add(folder);
            await db.SaveChangesAsync(ct);
            parent = folder.Id;
        }
        return parent!.Value;
    }

    private async Task<GoogleServiceAccount> AccountAsync(MigrationJobView job, CancellationToken ct) =>
        await credentials.ForTenantAsync(job.TenantId, ct)
        ?? throw new InvalidOperationException("this organisation has no Google service account on file");
}

using System.Text.Json;
using Microsoft.AspNetCore.Http;
using TatvaOS.Api.Modules.Family;
using TatvaOS.Api.Modules.Migration.Mail;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Migration.Contacts;

/// <summary>
/// Phase 2: one person's Google Contacts into their own TatvaOS address book
/// ('google_workspace' / 'contacts').
///
/// ─────────────────────────────────────────────────────────────────────────
///  THROUGH THE IMPORTER THAT EXISTS, not beside it (design section 2): each
///  Google person becomes a ContactRecord (GooglePersonMap) and goes through
///  Modules/Family/ContactImport.RunAsync - its duplicate rule
///  (ContactMatching, the same one mail auto-save uses), its labels, its
///  audit trail. Nothing in the Family module is changed.
///
///  AS THE PERSON. Personal contacts are fenced by app.user_id
///  (family.contacts' policy: owner_user_id = the session's person), so each
///  write runs in a scope of its own, entered as the job's target person.
///  The audit row therefore names that person as the actor; its reason is
///  "import" and its user agent says it was this migration, which is what
///  the importer's audit has room to say.
///
///  SAFE TO REPEAT for every contact with an email address: the importer's
///  "skip" mode leaves an address already in the book alone. A contact with
///  NO address (a phone number only) cannot be recognised that way; the
///  job's ledger stops it in every case but the page in flight at a kill.
///
///  Birthdays: the importer counts them and does not store them yet
///  (family.contact_dates has no entity) - its own comment says so.
///
///  NOT REGISTERED in Program.cs: like the mail source, it needs
///  IGoogleCredentialProvider, which is design section 9.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GoogleContactsSource(
    GoogleContactsClient google,
    IGoogleCredentialProvider credentials,
    IServiceScopeFactory scopes,
    IConfiguration config) : IMigrationSource
{
    public const string UserAgent = "tatvaos-migration (Google Contacts)";

    public string Source => "google_workspace";
    public string DataType => "contacts";

    private int PageSize => Math.Clamp(config.GetValue("Migration:Contacts:PageSize", 100), 1, 1000);

    public async Task<MigrationPage> FetchAsync(MigrationJobView job, CancellationToken ct)
    {
        var account = await credentials.ForTenantAsync(job.TenantId, ct)
                      ?? throw new InvalidOperationException("this organisation has no Google service account on file");
        // Group names afresh each page: cheap (one call), and a group renamed
        // mid-migration should land under its current name.
        var groups = await google.GroupNamesAsync(account, job.SourceUser, ct);
        var page = await google.ListAsync(account, job.SourceUser, job.Cursor, PageSize, ct);

        var items = new List<MigrationSourceItem>(page.People.Count);
        foreach (var p in page.People)
            if (GooglePersonMap.ResourceName(p) is { } id)
            {
                var record = GooglePersonMap.ToRecord(p, groups);
                // The dedupe key is the first address, normalised the way the
                // importer will: two Google entries for one address are one
                // contact here.
                var key = record.Emails.Select(e => ContactMatching.NormaliseEmail(e.Value)).FirstOrDefault(k => k.Length > 0);
                items.Add(new MigrationSourceItem(id, key, record));
            }

        return new MigrationPage(items, page.NextPageToken, IsLast: page.NextPageToken is null,
            ItemsTotal: job.Cursor is null ? page.TotalPeople : null);
    }

    public async Task<MigrationWriteResult> WriteAsync(MigrationJobView job, MigrationSourceItem item, CancellationToken ct)
    {
        var record = (ContactRecord)item.Payload!;

        await using var scope = scopes.CreateAsyncScope();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        tenant.Set(job.TenantId, job.TargetUserId, "employee");
        await db.SyncTenantAsync(ct);

        var http = new DefaultHttpContext();
        http.Request.Headers.UserAgent = UserAgent;

        var report = await ContactImport.RunAsync(
            [record], new ImportOptions { Ownership = "personal", Mode = "skip", CreateLabels = true },
            dryRun: false, fileName: $"Google Contacts ({job.SourceUser})", format: "google-people-api",
            db, tenant, job.TargetUserId, http, ct);

        if (report.Created == 1) return MigrationWriteResult.Done(0);
        var problem = report.Problems.FirstOrDefault();
        if (report.Skipped == 1)
            return MigrationWriteResult.Skipped(problem?.Reason ?? "already in the address book");
        return MigrationWriteResult.Failed(problem?.Reason ?? "the importer did not create it");
    }
}

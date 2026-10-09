using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Google;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Migration;

/// <summary>
/// The Google migration, as an organisation's own administrator runs it -
/// from "here is the client ID to authorise" to "bring the mail that arrived
/// since". Decision 0019 (proposed); the design is GOOGLE-WORKSPACE-MIGRATION-SPEC.md.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE ORDER AN ADMIN GOES IN, and what each step refuses:
///
///   GET  /setup       our service account's client ID and the read-only
///                     scopes to paste into Google's Admin console
///   POST /grant       record that it was authorised - only after LISTING
///                     THE CUSTOMER'S DIRECTORY as the admin they name, so a
///                     grant that does not work is never recorded as one
///   POST /estimate    how much, per person, and whether it fits (section 8)
///   POST /enrol       everyone in Google's directory -> planned jobs
///   POST /start       planned jobs -> pending: everyone, or a few people
///   GET  /people      progress per address, per data type
///   POST /catch-up    mail that arrived in Gmail since a person's copy
///   POST /revoke      the admin removed the grant in Google: cancel what
///                     is unfinished and stop
///
///  Everything after /grant needs an ACTIVE grant; the runner and the
///  credential provider check it again, so an endpoint is not the only gate.
///
///  NOTHING HERE WORKS until Migration:Google:KeyFile is set (/setup says
///  so). Every action that changes state is in the audit log.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MigrationEndpoints
{
    public static void MapMigrationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/migration")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/people", PeopleAsync);
        g.MapGet("/setup", SetupAsync);
        g.MapPost("/grant", GrantAsync);
        g.MapPost("/revoke", RevokeAsync);
        g.MapPost("/estimate", EstimateAsync);
        g.MapPost("/enrol", EnrolAsync);
        g.MapPost("/start", StartAsync);
        g.MapPost("/catch-up", CatchUpAsync);
    }

    public sealed record GrantRequest(string? GoogleDomain, string? GoogleAdmin);
    public sealed record TypesRequest(string[]? DataTypes, string[]? People);
    public sealed record PeopleRequest(string[]? People);

    private static IResult Err(int status, string error) => Results.Json(new { error }, statusCode: status);

    private static FileGoogleCredentialProvider? Provider(IServiceProvider sp) =>
        sp.GetService<FileGoogleCredentialProvider>();

    private static Task<MigrationGrant?> ActiveGrantAsync(AppDbContext db, CancellationToken ct) =>
        db.MigrationGrants.AsNoTracking()
            .Where(x => x.Source == "google_workspace" && x.RevokedAt == null)
            .FirstOrDefaultAsync(ct);

    // ── progress ───────────────────────────────────────────────────────────
    private static async Task<IResult> PeopleAsync(MigrationEnrolment enrolment, CancellationToken ct)
    {
        var people = await enrolment.ProgressAsync(ct);
        return Results.Ok(new
        {
            people,
            totals = new
            {
                people = people.Count,
                matched = people.Count(p => p.TargetUserId is not null),
                jobs = people.Sum(p => p.Types.Count),
                byState = people.SelectMany(p => p.Types).GroupBy(t => t.State).ToDictionary(x => x.Key, x => x.Count()),
                itemsDone = people.SelectMany(p => p.Types).Sum(t => t.ItemsDone),
                bytesDone = people.SelectMany(p => p.Types).Sum(t => t.BytesDone),
            },
        });
    }

    // ── setup and grant ────────────────────────────────────────────────────
    private static async Task<IResult> SetupAsync(IServiceProvider sp, AppDbContext db, CancellationToken ct)
    {
        var provider = Provider(sp);
        var grant = await ActiveGrantAsync(db, ct);
        if (provider is null)
            return Results.Ok(new { configured = false, reason = "This server has no Google service account (Migration:Google:KeyFile).", grant });
        GoogleServiceAccount account;
        try { account = provider.Account; }
        catch (Exception ex) when (ex is InvalidOperationException or GoogleKeyFormatException)
        {
            return Results.Ok(new { configured = false, reason = ex.Message, grant });
        }
        return Results.Ok(new
        {
            configured = true,
            clientId = account.ClientId,
            serviceAccount = account.ClientEmail,
            // Exactly these, comma-separated, in Admin console > Security >
            // Access and data control > API controls > Manage domain-wide delegation.
            scopes = GoogleScopes.Allowed.Order(StringComparer.Ordinal).ToArray(),
            grant,
            grantIsForThisKey = grant is null ? (bool?)null : grant.ClientId == account.ClientId,
        });
    }

    private static async Task<IResult> GrantAsync(
        GrantRequest req, IServiceProvider sp, AppDbContext db, TenantContext tenant,
        GoogleWorkspaceClient google, AuditWriter audit, CancellationToken ct)
    {
        if (Provider(sp) is not { } provider) return Err(409, "This server has no Google service account configured.");
        var domain = req.GoogleDomain?.Trim().ToLowerInvariant() ?? "";
        var admin = req.GoogleAdmin?.Trim().ToLowerInvariant() ?? "";
        if (domain.Length < 3 || !domain.Contains('.')) return Err(400, "The Google domain is required, e.g. example.com.");
        if (!admin.EndsWith("@" + domain, StringComparison.Ordinal))
            return Err(400, $"The admin's address must be in {domain}.");
        if (await ActiveGrantAsync(db, ct) is not null)
            return Err(409, "Access is already granted. Remove it first to grant it again.");

        var account = provider.Account;
        int people;
        try { people = (await google.ListUsersAsync(account, admin, ct)).Count; }
        catch (Exception ex) when (ex is GoogleAuthException or GoogleApiException)
        {
            // Our own sentence (GoogleAuthException) or Google's status: never a token.
            return Err(400, $"Google did not allow it, so nothing was recorded: {ex.Message}");
        }

        var grant = new MigrationGrant
        {
            TenantId = tenant.TenantId, GoogleDomain = domain, GoogleAdmin = admin,
            ClientId = account.ClientId ?? "", GrantedBy = tenant.UserId,
        };
        db.MigrationGrants.Add(grant);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("migration.google_granted", "migration_grant", grant.Id.ToString(),
            after: new { domain, admin, account.ClientEmail, peopleListed = people }, ct: ct);
        return Results.Ok(new { grant, peopleListed = people });
    }

    private static async Task<IResult> RevokeAsync(
        AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var grant = await db.MigrationGrants
            .FirstOrDefaultAsync(x => x.Source == "google_workspace" && x.RevokedAt == null, ct);
        if (grant is null) return Err(404, "There is no active grant.");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        grant.RevokedAt = DateTimeOffset.UtcNow;
        grant.RevokedBy = tenant.UserId;
        await db.SaveChangesAsync(ct);
        // Unfinished jobs stop. A running one loses its lease and stops at its
        // next page (MigrationJobRunner checks the lease at every record).
        var cancelled = await db.Database.ExecuteSqlAsync($"""
            UPDATE migration.jobs SET state = 'cancelled', finished_at = now(),
                   lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE source = 'google_workspace' AND state IN ('planned', 'pending', 'running')
            """, ct);
        await tx.CommitAsync(ct);
        await audit.WriteAsync("migration.google_revoked", "migration_grant", grant.Id.ToString(),
            after: new { jobsCancelled = cancelled }, ct: ct);
        return Results.Ok(new
        {
            jobsCancelled = cancelled,
            // Ours to record; Google's to enforce. Design section 9.
            removeInGoogle = "In the Google Admin console: Security > Access and data control > API controls > " +
                             "Manage domain-wide delegation. Delete the entry for TatvaOS's client ID. " +
                             "Until you do, the access is still granted in Google.",
        });
    }

    // ── estimate, enrol, start, catch-up ───────────────────────────────────
    private static async Task<IResult> EstimateAsync(
        IServiceProvider sp, AppDbContext db, TenantContext tenant, MigrationSizeEstimator estimator,
        StorageAllocator storage, IConfiguration config, CancellationToken ct)
    {
        if (Provider(sp) is not { } provider) return Err(409, "This server has no Google service account configured.");
        if (await ActiveGrantAsync(db, ct) is not { } grant) return Err(409, "Grant access first.");

        MigrationSizeReport report;
        try { report = await estimator.MeasureAsync(provider.Account, grant.GoogleAdmin, ct); }
        catch (Exception ex) when (ex is GoogleAuthException or GoogleApiException)
        {
            return Err(502, $"Google did not answer the directory listing: {ex.Message}");
        }

        DiskFigures mailDisk, spaceDisk;
        try
        {
            mailDisk = DiskFigures.Of(config["Mail:VmailRoot"] ?? "/var/mail/vhosts");
            spaceDisk = DiskFigures.Of(config["Space:BlobRoot"] ?? "/var/lib/space/blobs");
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return Err(503, $"The server's disks could not be measured, so no verdict: {ex.GetType().Name}");
        }

        var pool = await db.StoragePools.AsNoTracking().FirstOrDefaultAsync(p => p.TenantId == tenant.TenantId, ct);
        var verdict = MigrationFit.Judge(report, mailDisk, spaceDisk,
            await storage.GetCapacityAsync(tenant.TenantId, "mail", ct),
            await storage.GetCapacityAsync(tenant.TenantId, "drive", ct),
            pool?.StorageModel == "per_user" ? pool.PerUserQuotaBytes ?? StorageAllocator.DefaultPerUserQuota : null);
        return Results.Ok(new { report.People, report.NotMigrated, report.Unmeasured, report.MailBytes, report.DriveBytes, verdict });
    }

    private static async Task<IResult> EnrolAsync(
        TypesRequest req, IServiceProvider sp, AppDbContext db, TenantContext tenant,
        GoogleWorkspaceClient google, MigrationEnrolment enrolment, AuditWriter audit, CancellationToken ct)
    {
        if (Provider(sp) is not { } provider) return Err(409, "This server has no Google service account configured.");
        if (await ActiveGrantAsync(db, ct) is not { } grant) return Err(409, "Grant access first.");
        var types = req.DataTypes is { Length: > 0 } t ? t : MigrationEnrolment.DataTypes.ToArray();
        if (types.Any(x => !MigrationEnrolment.DataTypes.Contains(x)))
            return Err(400, $"Data types must be some of: {string.Join(", ", MigrationEnrolment.DataTypes.Order())}.");

        IReadOnlyList<GoogleDirectoryUser> people;
        try { people = await google.ListUsersAsync(provider.Account, grant.GoogleAdmin, ct); }
        catch (Exception ex) when (ex is GoogleAuthException or GoogleApiException)
        {
            return Err(502, $"Google did not answer the directory listing: {ex.Message}");
        }
        var report = await enrolment.EnrolAsync(tenant.TenantId, people, types, tenant.UserId, ct);
        await audit.WriteAsync("migration.enrolled", "migration", null,
            after: new { types, report.People, report.JobsCreated, report.Matched, unmatched = report.Unmatched.Count }, ct: ct);
        return Results.Ok(report);
    }

    private static async Task<IResult> StartAsync(
        TypesRequest req, AppDbContext db, MigrationEnrolment enrolment, AuditWriter audit, CancellationToken ct)
    {
        if (await ActiveGrantAsync(db, ct) is null) return Err(409, "Grant access first.");
        var types = req.DataTypes is { Length: > 0 } t ? t : MigrationEnrolment.DataTypes.ToArray();
        StartReport report;
        try { report = await enrolment.StartAsync(types, req.People, ct); }
        catch (ArgumentException ex) { return Err(400, ex.Message); }
        await audit.WriteAsync("migration.started", "migration", null,
            after: new { types, people = req.People?.Length, report.JobsStarted, report.PeopleStarted }, ct: ct);
        return Results.Ok(report);
    }

    private static async Task<IResult> CatchUpAsync(
        PeopleRequest req, AppDbContext db, MigrationEnrolment enrolment, AuditWriter audit, CancellationToken ct)
    {
        if (await ActiveGrantAsync(db, ct) is null) return Err(409, "Grant access first.");
        var queued = await enrolment.CatchUpMailAsync(req.People, ct);
        await audit.WriteAsync("migration.catch_up", "migration", null, after: new { people = queued.Count }, ct: ct);
        return Results.Ok(new { queued });
    }
}

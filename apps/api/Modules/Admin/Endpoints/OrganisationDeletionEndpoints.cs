using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Modules.Connect.Endpoints;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Deleting an organisation, permanently (Amit, 29 Sept 2026: three
/// organisations made for testing, and nothing that could remove them).
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE RULES LIVE IN THE DATABASE, NOT HERE.
///  local/postgres/init/20260929-organisation-deletions.sql holds the
///  checks, the removal and the check afterwards, in one function and one
///  transaction. This file asks it questions, shows the answers, and removes
///  the FILES the database cannot reach. If the two ever disagree, the
///  database is right: read that file first.
///
///  TWO STEPS, AND A TYPED NAME. An organisation must be suspended before it
///  can be deleted, and the operator types its name. Neither makes a wrong
///  deletion impossible; both make it something a person did on purpose.
///
///  WHAT IS REFUSED: an organisation that is not suspended; one that was ever
///  invoiced (tax records are kept); one a platform operator belongs to; the
///  operator's own; the house personal accounts live in.
///
///  THE ORGANISATION'S OWN AUDIT LOG GOES WITH IT — it is the organisation's
///  data. What remains is one row in core.organisation_deletions (numbers and
///  names of things, never a person's address or a message) and one line in
///  the OPERATOR'S organisation's audit log.
///
///  FILES. After the database commits:
///    Space files      removed here (the API is that volume's one writer)
///    recordings       removed here (the API is their one deleter)
///    DKIM keys        removed here
///    MAIL             NOT removed. The maildir is mounted read-only into
///                     this container, on purpose. The domains whose folder
///                     exists are recorded as pending, and the database
///                     refuses to register such a domain again until a person
///                     has removed the folder on the server and marked it.
///  A crash between the commit and the file removal leaves the record with
///  files_removed_at empty; "remove-files" finishes the job and is safe to
///  press twice.
///
///  NOT TOUCHED, ON PURPOSE: the platform setting ai.mail.organisations. An
///  id left in that list is harmless; an id REMOVED from it could leave the
///  list empty, and empty means "every organisation" (AiProductSwitch).
///  Backups: the organisation stays inside encrypted backups until they age
///  out. The screen says so.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static partial class OrganisationDeletionEndpoints
{
    public static void MapOrganisationDeletionEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/organisations/{id:guid}")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        g.MapGet("/deletion-preview", PreviewAsync);
        g.MapPost("/delete", DeleteAsync);

        var d = app.MapGroup("/api/admin/organisation-deletions")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        d.MapGet("/", ListAsync);
        d.MapPost("/{recordId:guid}/remove-files", RemoveFilesAgainAsync);
    }

    public sealed record DeleteOrganisationRequest(string? TypedName, string? Reason);

    private sealed record Blocker(string Code, string Reason);
    private sealed record DeletionFiles(Guid TenantId, string Domains, string RecordingFiles, DateTimeOffset? FilesRemovedAt);

    // ------------------------------------------------------------------
    private static async Task<IResult> PreviewAsync(
        Guid id, AppDbContext db, TenantContext tenant, IConfiguration config,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();
        var actor = CurrentUserId(http);

        var blockers = await db.Database.SqlQuery<Blocker>($"""
            SELECT code AS "Code", reason AS "Reason" FROM core.organisation_delete_blockers({id}, {actor})
            """).ToListAsync(ct);

        var countsJson = await db.Database.SqlQuery<string>($"""
            SELECT core.organisation_row_counts({id})::text AS "Value"
            """).FirstAsync(ct);
        var tables = JsonSerializer.Deserialize<Dictionary<string, long>>(countsJson) ?? [];
        long N(string key) => tables.GetValueOrDefault(key);

        tenant.EnterPlatformScope(id, actor);
        await db.SyncTenantAsync(ct);

        var domains = await db.Domains.AsNoTracking().Where(x => x.TenantId == id)
            .OrderBy(x => x.Fqdn).Select(x => x.Fqdn).ToListAsync(ct);
        var recordings = await (
                from r in db.ConnectRecordings.AsNoTracking()
                join m in db.ConnectMeetings.AsNoTracking() on r.MeetingId equals m.Id
                where m.TenantId == id && r.FileName != null && r.FileName != ""
                select r.Id)
            .CountAsync(ct);

        return Results.Ok(new
        {
            org = new { org.Id, org.Name, org.Status, org.Kind, org.Type, org.CreatedAt, org.SuspendedAt },
            canDelete = blockers.Count == 0,
            blockers,
            counts = new
            {
                people = N("core.users.tenant_id"),
                domains = N("core.domains.tenant_id"),
                mailboxes = N("mail.mailboxes.tenant_id"),
                messages = N("mail.messages.tenant_id"),
                meetings = N("connect.meetings.tenant_id"),
                recordings,
                files = N("space.files.tenant_id"),
                documents = N("docs.documents.tenant_id"),
                rowsInAll = tables.Values.Sum(),
            },
            // Every table that names the organisation, so nothing is hidden
            // behind the friendly numbers above.
            tables,
            domains,
            mailFolders = MailFoldersOnDisk(config, domains),
            // False = the mail store could not be looked at, and every domain
            // above is listed out of caution rather than because a folder
            // was seen. The screen says which.
            mailStoreSeen = MailStoreSeen(config),
            spaceFolderOnDisk = Directory.Exists(SpaceFolder(config, id)),
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> DeleteAsync(
        Guid id, DeleteOrganisationRequest req,
        AppDbContext db, TenantContext tenant, AuditWriter audit, IConfiguration config,
        ConnectRecordingOptions recordingOptions, ILoggerFactory logs,
        HttpContext http, CancellationToken ct)
    {
        var log = logs.CreateLogger("OrganisationDeletion");
        var actor = CurrentUserId(http);

        var org = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        // Read here for a plain message; the function checks all of it again.
        if (string.IsNullOrWhiteSpace(req.TypedName) || req.TypedName.Trim() != org.Name.Trim())
            return Results.BadRequest(new { error = "Type the organisation's name exactly as it is shown to delete it." });

        var domains = await db.Domains.IgnoreQueryFilters().AsNoTracking()
            .Where(x => x.TenantId == id).Select(x => x.Fqdn).ToListAsync(ct);
        var mailDirs = MailFoldersOnDisk(config, domains).ToArray();

        // The operator's own organisation, for the audit line afterwards —
        // read now, while nothing has changed.
        var operatorTenant = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == actor).Select(u => (Guid?)u.TenantId).FirstOrDefaultAsync(ct);

        Guid recordId;
        try
        {
            recordId = await db.Database.SqlQuery<Guid>($"""
                SELECT core.delete_organisation({id}, {req.TypedName}, {actor}, {req.Reason}, {mailDirs}) AS "Value"
                """).FirstAsync(ct);
        }
        catch (PostgresException ex) when (ex.SqlState.StartsWith("TVD", StringComparison.Ordinal))
        {
            // The function's own refusals, in its own words. TVD09 is the one
            // that matters most: rows were left behind, so NOTHING was deleted.
            log.LogWarning("Deleting organisation {Id} was refused by the database: {State} {Message}",
                id, ex.SqlState, ex.MessageText);
            var status = ex.SqlState switch
            {
                "TVD01" => 404,
                "TVD04" => 400,
                "TVD00" or "TVD09" or "TVD11" => 500,
                _ => 409,
            };
            return Results.Json(new { error = ex.MessageText, code = ex.SqlState }, statusCode: status);
        }

        log.LogWarning(
            "ORGANISATION DELETED: {Name} ({Id}) by {Actor}. Record {Record}. {Domains} domain(s), {MailDirs} mail folder(s) left on disk.",
            org.Name, id, actor, recordId, domains.Count, mailDirs.Length);

        // From here the organisation is gone and that cannot be undone, so
        // nothing below may turn the answer into an error: a 500 now would
        // read as "it did not work" about something that did.
        object? files;
        try { files = await RemoveFilesAsync(db, config, recordingOptions, recordId, log, ct); }
        catch (Exception ex)
        {
            log.LogError(ex, "Organisation {Id} is deleted, but removing its files failed. Record {Record}: press remove-files.", id, recordId);
            files = new { error = "The files could not be removed. Press \"Remove files\" on the record." };
        }

        try
        {
            if (operatorTenant is Guid home)
            {
                tenant.EnterPlatformScope(home, actor);
                await db.SyncTenantAsync(ct);
                await audit.WriteAsync("organisation.deleted", "tenant", id.ToString(),
                    before: new { org.Name, org.Type, org.Status, domains = domains.Count },
                    after: new { record = recordId, reason = req.Reason }, ct: ct);
            }
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Organisation {Id} is deleted; the operator's audit line could not be written. Record {Record} holds the facts.", id, recordId);
        }

        return Results.Ok(new { deleted = true, record = recordId, name = org.Name, mailFoldersLeft = mailDirs, files });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ListAsync(AppDbContext db, CancellationToken ct)
    {
        // Assembled by the database so the arrays and the jsonb arrive as
        // JSON rather than as strings the browser has to parse a second time.
        var json = await db.Database.SqlQuery<string>($"""
            SELECT COALESCE(json_agg(x ORDER BY x."deletedAt" DESC), '[]'::json)::text AS "Value"
              FROM (SELECT id, tenant_id AS "organisationId", name, type, origin,
                           organisation_created_at AS "organisationCreatedAt",
                           domains, counts, reason,
                           deleted_by_email AS "deletedBy", deleted_at AS "deletedAt",
                           cardinality(recording_files) AS "recordingFiles",
                           files_removed AS "filesRemoved", files_removed_at AS "filesRemovedAt",
                           mail_dirs_pending AS "mailFolders",
                           mail_dirs_purged_at AS "mailFoldersRemovedAt"
                      FROM core.organisation_deletions
                     ORDER BY deleted_at DESC
                     LIMIT 200) x
            """).FirstAsync(ct);
        return Results.Text(json, "application/json");
    }

    private static async Task<IResult> RemoveFilesAgainAsync(
        Guid recordId, AppDbContext db, IConfiguration config,
        ConnectRecordingOptions recordingOptions, ILoggerFactory logs, CancellationToken ct)
    {
        var log = logs.CreateLogger("OrganisationDeletion");
        var files = await RemoveFilesAsync(db, config, recordingOptions, recordId, log, ct);
        return files is null ? Results.NotFound() : Results.Ok(new { record = recordId, files });
    }

    // ==================================================================
    //  Files
    // ==================================================================

    /// <summary>
    /// Removes what the record lists and writes down what happened. Safe to
    /// run again: a file that is already gone is counted as gone.
    /// </summary>
    private static async Task<object?> RemoveFilesAsync(
        AppDbContext db, IConfiguration config, ConnectRecordingOptions recordingOptions,
        Guid recordId, ILogger log, CancellationToken ct)
    {
        var rows = await db.Database.SqlQuery<DeletionFiles>($"""
            SELECT tenant_id AS "TenantId", to_json(domains)::text AS "Domains",
                   to_json(recording_files)::text AS "RecordingFiles",
                   files_removed_at AS "FilesRemovedAt"
              FROM core.organisation_deletions WHERE id = {recordId}
            """).ToListAsync(ct);
        if (rows.Count == 0) return null;
        var row = rows[0];

        // The organisation must really be gone. This removes files by an id
        // read from a table; if that id still names a living organisation,
        // something is badly wrong and the files stay.
        if (await db.Tenants.IgnoreQueryFilters().AnyAsync(t => t.Id == row.TenantId, ct))
            throw new InvalidOperationException(
                $"Record {recordId} names organisation {row.TenantId}, which still exists. No file was touched.");

        var domains = JsonSerializer.Deserialize<string[]>(row.Domains) ?? [];
        var recordings = JsonSerializer.Deserialize<string[]>(row.RecordingFiles) ?? [];
        var errors = new List<string>();

        // ---- Space: the organisation's own folder, whole -------------------
        var space = SpaceFolder(config, row.TenantId);
        int spaceFiles = 0; long spaceBytes = 0; var spaceRemoved = false;
        try
        {
            if (Directory.Exists(space))
            {
                foreach (var f in Directory.EnumerateFiles(space, "*", SearchOption.AllDirectories))
                {
                    spaceFiles++;
                    try { spaceBytes += new FileInfo(f).Length; } catch (IOException) { }
                }
                Directory.Delete(space, recursive: true);
                spaceRemoved = true;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogError(ex, "Could not remove the Space folder of deleted organisation {Id}", row.TenantId);
            errors.Add("Space files could not be removed.");
        }

        // ---- Recordings: by the names the database held --------------------
        int recRemoved = 0, recMissing = 0, recFailed = 0;
        foreach (var name in recordings)
        {
            var path = ConnectRecordingEndpoints.ResolvePath(recordingOptions, name);
            if (path is null) { recFailed++; continue; }
            try
            {
                if (File.Exists(path)) { File.Delete(path); recRemoved++; }
                else recMissing++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogError(ex, "Could not remove a recording of deleted organisation {Id}", row.TenantId);
                recFailed++;
            }
        }
        if (recFailed > 0) errors.Add($"{recFailed} recording(s) could not be removed.");

        // ---- DKIM keys: {domain}.{selector}.key -----------------------------
        var keyDir = config["Dkim:KeyDirectory"] ?? "/dkim";
        int keysRemoved = 0;
        try
        {
            if (Directory.Exists(keyDir))
            {
                foreach (var fqdn in domains.Where(IsDomain))
                {
                    // A selector has no dot in it. Without that, "a.com.*.key"
                    // would also take "a.com.au.sel.key" — another customer's.
                    var mine = new Regex("^" + Regex.Escape(fqdn) + @"\.[A-Za-z0-9_-]+\.key$");
                    foreach (var f in Directory.EnumerateFiles(keyDir, fqdn + ".*.key"))
                    {
                        if (!mine.IsMatch(Path.GetFileName(f))) continue;
                        File.Delete(f);
                        keysRemoved++;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogError(ex, "Could not remove DKIM keys of deleted organisation {Id}", row.TenantId);
            errors.Add("DKIM keys could not be removed.");
        }

        var result = new
        {
            space = new { files = spaceFiles, bytes = spaceBytes, removed = spaceRemoved },
            recordings = new { listed = recordings.Length, removed = recRemoved, alreadyGone = recMissing, failed = recFailed },
            dkimKeys = new { removed = keysRemoved },
            errors,
        };

        // Marked done only when nothing failed, so a record with a failure
        // keeps offering the button.
        var json = JsonSerializer.Serialize(result);
        if (errors.Count == 0)
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE core.organisation_deletions
                   SET files_removed = {json}::jsonb, files_removed_at = now()
                 WHERE id = {recordId}
                """, ct);
        else
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE core.organisation_deletions SET files_removed = {json}::jsonb WHERE id = {recordId}
                """, ct);

        return result;
    }

    /// <summary>
    /// The organisation's domains whose mail folder is on disk. IF THE MAIL
    /// VOLUME CANNOT BE SEEN AT ALL, EVERY DOMAIN IS RETURNED: "I could not
    /// look" must not read as "there is nothing there", because what hangs on
    /// the answer is whether the domain may be registered again.
    /// </summary>
    private static List<string> MailFoldersOnDisk(IConfiguration config, IEnumerable<string> domains)
    {
        var root = config["Mail:VmailRoot"] ?? "/var/mail/vhosts";
        var valid = domains.Where(IsDomain).ToList();
        try
        {
            if (!Directory.Exists(root)) return valid;
            return valid.Where(d => Directory.Exists(Path.Combine(root, d))).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return valid;
        }
    }

    private static bool MailStoreSeen(IConfiguration config)
    {
        try { return Directory.Exists(config["Mail:VmailRoot"] ?? "/var/mail/vhosts"); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }

    private static string SpaceFolder(IConfiguration config, Guid tenantId)
    {
        var root = Path.GetFullPath(config["Space:BlobRoot"] ?? "/var/lib/space/blobs");
        // A Guid formats to 36 characters of hex and hyphens; nothing a
        // caller supplies reaches this path.
        return Path.Combine(root, tenantId.ToString("D"));
    }

    [GeneratedRegex(@"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$")]
    private static partial Regex DomainShape();
    private static bool IsDomain(string fqdn) => fqdn.Length <= 253 && DomainShape().IsMatch(fqdn);

    /// <summary>
    /// Who is pressing. The token's "sub" arrives renamed to NameIdentifier
    /// (the JWT handler maps it), so asking for "sub" alone finds nothing and
    /// answers Guid.Empty — which is what the other operator endpoints do
    /// today, and why their audit lines name nobody (found 29 Sept 2026 by
    /// this file's own test: the database refused "an operator" it could not
    /// find). Same order as TenantMiddleware.
    /// </summary>
    private static Guid CurrentUserId(HttpContext http) =>
        Guid.TryParse(
            http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                ?? http.User.FindFirst("sub")?.Value, out var id) ? id : Guid.Empty;
}

/// <summary>
/// A domain that belonged to a deleted organisation, whose mail folder is
/// still on the server. Mail lives at vhosts/{domain}/{local part}: register
/// the domain again, create the same address, and the new mailbox opens onto
/// the old organisation's mail. So it is held back until the folder is gone.
///
/// The database enforces this for every route (trg_domains_leftover_mail).
/// This is the same question asked first, so the person gets a sentence and
/// not a 500.
/// </summary>
public static class DeletedOrganisationDomains
{
    public static async Task<bool> IsHeldAsync(AppDbContext db, string fqdn, CancellationToken ct)
    {
        var held = await db.Database.SqlQuery<int>($"""
            SELECT count(*)::int AS "Value" FROM core.organisation_deletions
             WHERE mail_dirs_purged_at IS NULL AND mail_dirs_pending @> ARRAY[{fqdn}]::text[]
            """).FirstAsync(ct);
        return held > 0;
    }

    public static string Refusal(string fqdn) =>
        $"{fqdn} belonged to an organisation that was deleted, and its mail is still on our " +
        "servers. It can be registered again once that mail has been removed — contact support.";
}

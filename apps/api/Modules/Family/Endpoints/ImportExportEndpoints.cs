using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Family.Endpoints;

/// <summary>
/// Getting an address book in, and getting it back out.
///
/// ─────────────────────────────────────────────────────────────────────────
///  EXPORT IS NOT THE SMALLER HALF OF THIS FEATURE.
///
///  Import is what lets somebody start using Family. Export is what lets them
///  believe it is safe to. An address book you cannot get out of is one people
///  will keep a private copy of "just in case", and a private copy is a
///  contact list that never gets updated and quietly becomes the real one.
///
///  So: everything the caller can see, in a file Google and Apple will read,
///  with no cap, no watermark and no "premium" gate.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Both routes hang off the same /api/family group as the rest, so they
/// inherit its authorisation, and every query runs through the DbSets that
/// carry the tenant and ownership filters. Nobody exports what they could not
/// already read one page at a time.
/// </summary>
public static class ImportExportEndpoints
{
    /// <summary>
    /// Ten megabytes. A contacts export is text; Google's own export of five
    /// thousand contacts is comfortably under two. Anything larger is either a
    /// mistake or not a contacts file.
    /// </summary>
    private const long MaxUploadBytes = 10L * 1024 * 1024;

    /// <summary>
    /// Above this, an export is asked to narrow itself. Building one string
    /// holding every contact in a large tenant is the kind of thing that looks
    /// fine until the day somebody clicks it twice.
    /// </summary>
    private const int MaxExportRows = 20_000;

    public static void MapImportExport(this RouteGroupBuilder g)
    {
        g.MapGet("/contacts/export", ExportAsync);
        g.MapPost("/contacts/import", ImportAsync);
    }

    // ==================================================================
    //  Export
    // ==================================================================

    private static async Task<IResult> ExportAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        string format = "csv",
        string? ownership = null,
        Guid? groupId = null,
        string? source = null,
        bool favourite = false)
    {
        var vcard = format.Equals("vcf", StringComparison.OrdinalIgnoreCase)
                 || format.Equals("vcard", StringComparison.OrdinalIgnoreCase);

        // The same filter the list route applies, so "export what I am looking
        // at" means exactly that. See ContactFilters.
        var q = ContactFilters.Apply(
            db, db.Contacts.Where(c => c.DeletedAt == null),
            ownership, groupId, favourite, source);

        var count = await q.CountAsync(ct);
        if (count > MaxExportRows)
            return Results.Problem(
                title: "That is too many contacts for one file.",
                detail: $"This export would contain {count:N0} contacts and the limit is " +
                        $"{MaxExportRows:N0}. Narrow it with a label, or export your own " +
                        "contacts and the shared ones separately.",
                statusCode: StatusCodes.Status400BadRequest);

        var contacts = await q
            .Include(c => c.Emails)
            .Include(c => c.Phones)
            .Include(c => c.Addresses)
            .OrderBy(c => c.DisplayName)
            .ToListAsync(ct);

        // Labels in one query rather than one per contact.
        var ids = contacts.Select(c => c.Id).ToList();
        var memberships = await db.ContactGroupMembers
            .Where(m => ids.Contains(m.ContactId))
            .Join(db.ContactGroups, m => m.GroupId, x => x.Id,
                  (m, x) => new { m.ContactId, x.Name })
            .ToListAsync(ct);

        var labels = memberships
            .GroupBy(m => m.ContactId)
            .ToDictionary(x => x.Key, x => x.Select(m => m.Name).OrderBy(n => n).ToList());

        var records = new List<ContactRecord>(contacts.Count);
        foreach (var c in contacts)
        {
            var record = new ContactRecord
            {
                DisplayName = c.DisplayName,
                FirstName = c.FirstName,
                LastName = c.LastName,
                Nickname = c.Nickname,
                JobTitle = c.JobTitle,
                CompanyName = c.CompanyName,
                Notes = c.Notes,
                IsFavourite = c.IsFavourite,
                Visibility = c.OwnershipType == "organisational" ? "Shared" : "Mine",
            };

            // Primary first, so the first slot in the file is the one that
            // matters and a reader that only takes one address takes the right
            // one.
            foreach (var e in c.Emails.OrderByDescending(e => e.IsPrimary).ThenBy(e => e.Email))
                record.Emails.Add(new LabelledValue { Value = e.Email, Type = e.Type });

            foreach (var p in c.Phones.OrderByDescending(p => p.IsPrimary).ThenBy(p => p.Phone))
                record.Phones.Add(new LabelledValue { Value = p.Phone, Type = p.Type });

            foreach (var a in c.Addresses.OrderByDescending(a => a.IsPrimary))
                record.Addresses.Add(new PostalRecord
                {
                    Type = a.Type,
                    Street1 = a.StreetLine1,
                    Street2 = a.StreetLine2,
                    City = a.City,
                    Region = a.StateProvince,
                    Postcode = a.PostalCode,
                    Country = a.Country,
                });

            if (labels.TryGetValue(c.Id, out var mine)) record.Labels.AddRange(mine);

            records.Add(record);
        }

        var stamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd");

        if (vcard)
        {
            var sb = new System.Text.StringBuilder();
            foreach (var r in records) VCard.Append(sb, r);

            return Results.File(
                System.Text.Encoding.UTF8.GetBytes(sb.ToString()),
                "text/vcard; charset=utf-8",
                $"tatvaos-contacts-{stamp}.vcf");
        }

        return Results.File(
            System.Text.Encoding.UTF8.GetBytes(ContactCsvFormat.Write(records)),
            "text/csv; charset=utf-8",
            $"tatvaos-contacts-{stamp}.csv");
    }

    // ==================================================================
    //  Import
    // ==================================================================

    /// <summary>
    /// Accepts the file either as a multipart upload or as a raw body — a
    /// browser sends the first, curl and a script send the second, and there
    /// is no reason to make either of them wrap the other.
    ///
    /// The form is read by hand rather than bound as an IFormFile parameter.
    /// Binding one turns on the framework's antiforgery validation, which this
    /// application has no middleware for and does not need: the endpoint
    /// authenticates on a bearer token, and a token is not something a browser
    /// attaches to a cross-site request on its own.
    /// </summary>
    private static async Task<IResult> ImportAsync(
        HttpContext http, AppDbContext db, TenantContext tenant, CancellationToken ct,
        bool dryRun = false,
        string ownership = "personal",
        string mode = "skip",
        bool createLabels = true,
        string? label = null)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        byte[] bytes;
        var fileName = "contacts";

        if (http.Request.HasFormContentType)
        {
            var form = await http.Request.ReadFormAsync(ct);
            if (form.Files.Count == 0)
                return Results.BadRequest(new
                {
                    error = "no_file",
                    message = "No file was attached to the upload.",
                });

            var file = form.Files[0];
            if (file.Length > MaxUploadBytes) return TooLarge();

            fileName = SafeName(file.FileName);

            using var ms = new MemoryStream();
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        else
        {
            if (http.Request.ContentLength is > MaxUploadBytes) return TooLarge();

            using var ms = new MemoryStream();
            await http.Request.Body.CopyToAsync(ms, ct);
            if (ms.Length > MaxUploadBytes) return TooLarge();
            bytes = ms.ToArray();

            var supplied = http.Request.Headers["X-File-Name"].ToString();
            if (supplied.Length > 0) fileName = SafeName(supplied);
        }

        if (bytes.Length == 0)
            return Results.BadRequest(new { error = "empty_file", message = "That file is empty." });

        var text = TextFile.Decode(bytes);

        // Extension first, content second. A file called contacts.txt that
        // begins with BEGIN:VCARD is a vCard whatever it is named, and a
        // browser's reported type is not to be trusted either way.
        var isVCard = fileName.EndsWith(".vcf", StringComparison.OrdinalIgnoreCase)
                   || fileName.EndsWith(".vcard", StringComparison.OrdinalIgnoreCase)
                   || text.TrimStart('\uFEFF', ' ', '\r', '\n', '\t')
                          .StartsWith("BEGIN:VCARD", StringComparison.OrdinalIgnoreCase);

        List<ContactRecord> records;
        string format;

        if (isVCard)
        {
            format = "vcard";
            records = VCard.Parse(text);

            if (records.Count == 0)
                return Results.BadRequest(new
                {
                    error = "no_cards",
                    message = "No vCards were found in that file. A vCard file is made of " +
                              "blocks that begin with BEGIN:VCARD and end with END:VCARD.",
                });
        }
        else
        {
            format = "csv";

            if (!ContactCsvFormat.LooksLikeContacts(text))
                return Results.BadRequest(new
                {
                    error = "unrecognised_columns",
                    message = "This does not look like a contacts export. The first row should " +
                              "be column headings — at least one of Name, First Name, Last Name, " +
                              "Company or an E-mail column. Export from Google Contacts as " +
                              "\"Google CSV\" and upload that file unchanged.",
                });

            records = ContactCsvFormat.Parse(text);

            if (records.Count == 0)
                return Results.BadRequest(new
                {
                    error = "no_rows",
                    message = "That file has column headings but no contacts underneath them.",
                });
        }

        if (records.Count > ContactImport.MaxRows)
            return Results.BadRequest(new
            {
                error = "too_many_rows",
                message = $"That file holds {records.Count:N0} contacts and the limit for one " +
                          $"import is {ContactImport.MaxRows:N0}. Split it and import the parts.",
            });

        var options = new ImportOptions
        {
            Ownership = ownership == "organisational" ? "organisational" : "personal",
            Mode = mode == "update" ? "update" : "skip",
            CreateLabels = createLabels,
            TagLabel = string.IsNullOrWhiteSpace(label) ? null : label.Trim(),
        };

        try
        {
            var report = await ContactImport.RunAsync(
                records, options, dryRun, fileName, format, db, tenant, uid, http, ct);

            return Results.Ok(report);
        }
        catch (DbUpdateException e)
        {
            // One import is one transaction, so this really does mean nothing
            // landed — say so plainly rather than leaving somebody to guess
            // whether they should try again or check for half an address book.
            return Results.Problem(
                title: "The import could not be saved.",
                detail: "Nothing was imported — the whole file is written in one go, so there " +
                        "is no half-finished result to clean up. " + Innermost(e),
                statusCode: StatusCodes.Status409Conflict);
        }
    }

    private static IResult TooLarge() => Results.Problem(
        title: "That file is too large.",
        detail: $"The limit is {MaxUploadBytes / (1024 * 1024)} MB. A contacts export is plain " +
                "text and is almost never anywhere near that, so this is usually the wrong file.",
        statusCode: StatusCodes.Status413PayloadTooLarge);

    /// <summary>
    /// The name goes into an audit row and back to the browser, so it is
    /// stripped of any path and of anything that is not printable.
    /// </summary>
    private static string SafeName(string? supplied)
    {
        if (string.IsNullOrWhiteSpace(supplied)) return "contacts";

        var name = Path.GetFileName(supplied.Trim());
        if (name.Length == 0) return "contacts";

        var clean = new string(name.Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length == 0) return "contacts";

        return clean.Length > 200 ? clean[..200] : clean;
    }

    private static string Innermost(Exception e)
    {
        var current = e;
        while (current.InnerException is not null) current = current.InnerException;
        return current.Message;
    }
}

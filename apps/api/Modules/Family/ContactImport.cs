using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Family;

// ============================================================================
//  Turning parsed records into contacts.
//
//  ─────────────────────────────────────────────────────────────────────────
//   AN IMPORT THAT SILENTLY DROPS ROWS IS WORSE THAN ONE THAT REFUSES.
//
//   Somebody migrating four hundred contacts out of Gmail has no way to tell
//   that three hundred and eighty arrived. They find out months later, when
//   they go looking for a supplier who is not there, and by then the original
//   file is gone. So every row that does not become a contact is reported with
//   a reason a person can act on, and the whole thing can be run as a dry run
//   first so nobody has to find out afterwards.
//  ─────────────────────────────────────────────────────────────────────────
//
//  Duplicate handling reuses ContactMatching.NormaliseEmail — the SAME rule
//  auto-save uses. An importer with its own idea of what counts as the same
//  person would let a Gmail address in through the front door that mail would
//  have folded into an existing contact, and the two halves of the product
//  would disagree about how many people there are.
// ============================================================================

public sealed record ImportOptions
{
    /// <summary>personal | organisational. Where the imported rows land.</summary>
    public string Ownership { get; init; } = "personal";

    /// <summary>
    /// skip    an address already in the book leaves the existing contact alone
    /// update  fills in blanks on it and adds addresses and numbers it lacks
    ///
    /// Neither ever overwrites something already filled in. An import is not a
    /// licence to replace what somebody typed by hand.
    /// </summary>
    public string Mode { get; init; } = "skip";

    /// <summary>Create labels named in the file that do not exist yet.</summary>
    public bool CreateLabels { get; init; } = true;

    /// <summary>
    /// A label applied to everything in this file. Worth insisting on in the
    /// UI: it is the only practical way to undo a bad import in bulk.
    /// </summary>
    public string? TagLabel { get; init; }
}

/// <summary>What happened to one row, in words meant for the person importing.</summary>
public sealed record ImportOutcome(
    int Row, string Name, string? Email, string Outcome, string Reason, Guid? ContactId);

public sealed record ImportReport(
    bool DryRun,
    string FileName,
    string Format,
    int RowsRead,
    int Created,
    int Updated,
    int Skipped,
    List<string> Warnings,
    List<ImportOutcome> Problems,
    bool ProblemsTruncated,
    List<string> Sample);

public static class ContactImport
{
    /// <summary>
    /// One import is one transaction, so a file either lands or it does not.
    /// This is the ceiling on how big that transaction may get — five thousand
    /// contacts is far beyond any real address book, and well below the size
    /// where a single SaveChanges becomes a problem for everybody else on the
    /// database.
    /// </summary>
    public const int MaxRows = 5000;

    /// <summary>Problems returned in full up to here; the count stays exact.</summary>
    private const int MaxProblemsReported = 500;

    public static async Task<ImportReport> RunAsync(
        List<ContactRecord> records,
        ImportOptions options,
        bool dryRun,
        string fileName,
        string format,
        AppDbContext db,
        TenantContext tenant,
        Guid uid,
        HttpContext http,
        CancellationToken ct)
    {
        var organisational = options.Ownership == "organisational";
        var updating = options.Mode == "update";

        var problems = new List<ImportOutcome>();
        var sample = new List<string>();
        var warnings = new List<string>();

        var created = 0;
        var updated = 0;
        var skipped = 0;
        var birthdaysSeen = 0;

        // ------------------------------------------------------------------
        //  What is already in the book.
        //
        //  One query for the lot rather than one per row: a four-hundred-row
        //  file would otherwise be four hundred round trips, and the import
        //  would take a minute for no reason.
        // ------------------------------------------------------------------
        var keys = records
            .SelectMany(r => r.Emails)
            .Select(e => ContactMatching.NormaliseEmail(e.Value))
            .Where(k => k.Length > 0)
            .Distinct()
            .ToList();

        var existing = new Dictionary<string, (Guid Id, string Name)>(StringComparer.OrdinalIgnoreCase);

        if (keys.Count > 0)
        {
            var hits = await db.ContactEmails
                .Where(e => keys.Contains(e.EmailNormalised))
                .Join(db.Contacts.Where(c => c.DeletedAt == null),
                      e => e.ContactId, c => c.Id,
                      (e, c) => new { e.EmailNormalised, c.Id, c.DisplayName })
                .ToListAsync(ct);

            foreach (var h in hits) existing.TryAdd(h.EmailNormalised, (h.Id, h.DisplayName));
        }

        // ------------------------------------------------------------------
        //  Labels
        // ------------------------------------------------------------------
        var groups = await db.ContactGroups.ToListAsync(ct);
        var groupsByName = new Dictionary<string, ContactGroup>(StringComparer.OrdinalIgnoreCase);
        foreach (var g in groups) groupsByName.TryAdd(g.Name, g);

        var tag = Fit.Cap(options.TagLabel, 200);

        // Memberships that already exist, so update mode does not try to
        // insert a duplicate primary key.
        var existingMemberships = new HashSet<(Guid, Guid)>();

        // ------------------------------------------------------------------
        //  Contacts we may enrich, loaded once with their children.
        // ------------------------------------------------------------------
        var loaded = new Dictionary<Guid, Contact>();
        if (updating && existing.Count > 0)
        {
            var ids = existing.Values.Select(v => v.Id).Distinct().ToList();

            var rows = await db.Contacts
                .Include(c => c.Emails)
                .Include(c => c.Phones)
                .Include(c => c.Addresses)
                .Where(c => ids.Contains(c.Id) && c.DeletedAt == null)
                .ToListAsync(ct);
            foreach (var c in rows) loaded[c.Id] = c;

            var members = await db.ContactGroupMembers
                .Where(m => ids.Contains(m.ContactId))
                .Select(m => new { m.GroupId, m.ContactId })
                .ToListAsync(ct);
            foreach (var m in members) existingMemberships.Add((m.GroupId, m.ContactId));
        }

        // Addresses claimed by earlier rows of THIS file. Google exports
        // routinely contain the same person twice, and without this the second
        // copy either violates the unique index or creates a duplicate that the
        // importer itself was supposed to prevent.
        var claimed = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        // Existing contacts this file has already touched, so the count stays
        // a count of people rather than of rows.
        var enriched = new HashSet<Guid>();

        var now = DateTimeOffset.UtcNow;

        foreach (var record in records)
        {
            if (record.Birthday is not null) birthdaysSeen++;

            var name = Fit.Cap(record.ResolveName(), 400);
            if (name is null)
            {
                skipped++;
                Add(problems, new ImportOutcome(record.Row, "—", null, "skipped",
                    "No name, company or email address in this row.", null));
                continue;
            }

            // Normalise and de-duplicate WITHIN the row first: a.b@gmail.com
            // and ab@gmail.com are one address, and the unique index on
            // (contact, normalised) would reject the second.
            var addresses = new List<(string Raw, string Key, string Type)>();
            foreach (var e in record.Emails)
            {
                var key = ContactMatching.NormaliseEmail(e.Value);
                if (key.Length == 0) continue;
                if (addresses.Any(a => a.Key.Equals(key, StringComparison.OrdinalIgnoreCase))) continue;
                addresses.Add((e.Value.Trim(), key, e.Type));
            }

            var firstEmail = addresses.Count > 0 ? addresses[0].Raw : null;

            // Does any address on this row already belong to someone?
            (Guid Id, string Name)? owner = null;
            string? ownedKey = null;
            foreach (var a in addresses)
            {
                if (existing.TryGetValue(a.Key, out var hit)) { owner = hit; ownedKey = a.Key; break; }
            }

            if (owner is { } match)
            {
                if (!updating)
                {
                    skipped++;
                    Add(problems, new ImportOutcome(record.Row, name, firstEmail, "skipped",
                        $"{ownedKey} is already saved as {match.Name}.", match.Id));
                    continue;
                }

                // Counted per CONTACT, not per row. Two rows can name the same
                // person, and "3 filled in" when there are two of them is the
                // kind of small wrongness that makes the rest of the report
                // untrustworthy.
                if (enriched.Add(match.Id)) updated++;

                if (!dryRun && loaded.TryGetValue(match.Id, out var target))
                {
                    Enrich(tenant, target, record, addresses, now);
                    ApplyLabels(db, tenant, uid, target.Id, record, tag, options,
                                groupsByName, existingMemberships, dryRun);
                    Audit(db, tenant, target.Id, uid, "update", http, new Dictionary<string, object?>
                    {
                        ["import"] = fileName,
                        ["matchedOn"] = ownedKey,
                    });
                }
                continue;
            }

            // Already claimed by an earlier row of this same file?
            var clash = addresses.FirstOrDefault(a => claimed.ContainsKey(a.Key));
            if (clash.Key is { Length: > 0 })
            {
                skipped++;
                Add(problems, new ImportOutcome(record.Row, name, firstEmail, "skipped",
                    $"{clash.Key} also appears in row {claimed[clash.Key]} of this file.", null));
                continue;
            }

            created++;
            if (sample.Count < 25) sample.Add(firstEmail is null ? name : $"{name} <{firstEmail}>");
            foreach (var a in addresses) claimed[a.Key] = record.Row;

            if (dryRun) continue;

            var contact = new Contact
            {
                TenantId = tenant.TenantId,
                CreatedByUserId = uid,
                OwnershipType = organisational ? "organisational" : "personal",
                OwnerUserId = organisational ? null : uid,
                DisplayName = name,
                FirstName = Fit.Cap(record.FirstName, 200),
                LastName = Fit.Cap(record.LastName, 200),
                Nickname = Fit.Cap(record.Nickname, 200),
                JobTitle = Fit.Cap(record.JobTitle, 200),
                CompanyName = Fit.Cap(record.CompanyName, 300),
                Notes = string.IsNullOrWhiteSpace(record.Notes) ? null : record.Notes.Trim(),
                IsFavourite = record.IsFavourite,
                Source = "import",
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Contacts.Add(contact);

            for (var i = 0; i < addresses.Count; i++)
            {
                var a = addresses[i];
                if (a.Raw.Length > 320) continue;
                db.ContactEmails.Add(new ContactEmail
                {
                    TenantId = tenant.TenantId,
                    ContactId = contact.Id,
                    Email = a.Raw,
                    EmailNormalised = a.Key,
                    Type = a.Type,
                    IsPrimary = i == 0,
                    CreatedAt = now,
                });
            }

            var numbers = new List<string>();
            foreach (var p in record.Phones)
            {
                var value = Fit.Cap(p.Value, 64);
                if (value is null) continue;
                var digits = ContactMatching.NormalisePhone(value);
                if (digits.Length == 0 || numbers.Contains(digits)) continue;
                numbers.Add(digits);

                db.ContactPhones.Add(new ContactPhone
                {
                    TenantId = tenant.TenantId,
                    ContactId = contact.Id,
                    Phone = value,
                    PhoneNormalised = digits,
                    Type = p.Type,
                    IsPrimary = numbers.Count == 1,
                    CreatedAt = now,
                });
            }

            var firstPostal = true;
            foreach (var a in record.Addresses)
            {
                db.ContactAddresses.Add(new ContactAddress
                {
                    TenantId = tenant.TenantId,
                    ContactId = contact.Id,
                    Type = a.Type,
                    StreetLine1 = Fit.Cap(a.Street1, 300),
                    StreetLine2 = Fit.Cap(a.Street2, 300),
                    City = Fit.Cap(a.City, 150),
                    StateProvince = Fit.Cap(a.Region, 150),
                    PostalCode = Fit.Cap(a.Postcode, 32),
                    Country = Fit.Cap(a.Country, 150),
                    IsPrimary = firstPostal,
                    CreatedAt = now,
                });
                firstPostal = false;
            }

            ApplyLabels(db, tenant, uid, contact.Id, record, tag, options,
                        groupsByName, existingMemberships, dryRun);

            Audit(db, tenant, contact.Id, uid, "create", http, new Dictionary<string, object?>
            {
                ["import"] = fileName,
                ["format"] = format,
            });
        }

        if (birthdaysSeen > 0)
            warnings.Add($"{birthdaysSeen} {(birthdaysSeen == 1 ? "birthday was" : "birthdays were")} " +
                         "found in this file and not imported — dates are not switched on yet. " +
                         "Keep the original file until they are.");

        if (!dryRun) await db.SaveChangesAsync(ct);

        return new ImportReport(
            dryRun, fileName, format,
            records.Count, created, updated, skipped,
            warnings,
            problems,
            problems.Count >= MaxProblemsReported,
            sample);
    }

    private static void Add(List<ImportOutcome> problems, ImportOutcome outcome)
    {
        if (problems.Count < MaxProblemsReported) problems.Add(outcome);
    }

    /// <summary>
    /// Fill in what is missing on a contact that already exists. Never
    /// overwrites: a blank in the file means the file does not know, not that
    /// the value should be cleared, and somebody typed what is there now.
    /// </summary>
    private static void Enrich(
        TenantContext tenant, Contact target, ContactRecord record,
        List<(string Raw, string Key, string Type)> addresses, DateTimeOffset now)
    {
        target.FirstName ??= Fit.Cap(record.FirstName, 200);
        target.LastName ??= Fit.Cap(record.LastName, 200);
        target.Nickname ??= Fit.Cap(record.Nickname, 200);
        target.JobTitle ??= Fit.Cap(record.JobTitle, 200);
        target.CompanyName ??= Fit.Cap(record.CompanyName, 300);
        if (string.IsNullOrWhiteSpace(target.Notes) && !string.IsNullOrWhiteSpace(record.Notes))
            target.Notes = record.Notes.Trim();

        var have = target.Emails.Select(e => e.EmailNormalised).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var a in addresses)
        {
            if (a.Raw.Length > 320 || !have.Add(a.Key)) continue;
            // Added to the tracked navigation collection, NOT to db.ContactEmails.
            //
            // Two rows of one file can match the same existing contact — the
            // same person listed twice with different addresses is exactly what
            // an import is for. A row added straight to the DbSet is invisible
            // to target.Emails, so the second pass would not see it, would add
            // the address again, and the unique index on (contact, normalised)
            // would take the whole transaction down.
            target.Emails.Add(new ContactEmail
            {
                TenantId = tenant.TenantId,
                ContactId = target.Id,
                Email = a.Raw,
                EmailNormalised = a.Key,
                Type = a.Type,
                IsPrimary = false,          // the existing primary keeps its place
                CreatedAt = now,
            });
        }

        var haveNumbers = target.Phones.Select(p => p.PhoneNormalised).ToHashSet(StringComparer.Ordinal);
        foreach (var p in record.Phones)
        {
            var value = Fit.Cap(p.Value, 64);
            if (value is null) continue;
            var digits = ContactMatching.NormalisePhone(value);
            if (digits.Length == 0 || !haveNumbers.Add(digits)) continue;

            target.Phones.Add(new ContactPhone
            {
                TenantId = tenant.TenantId,
                ContactId = target.Id,
                Phone = value,
                PhoneNormalised = digits,
                Type = p.Type,
                IsPrimary = false,
                CreatedAt = now,
            });
        }

        // Postal addresses only when the contact has none. Deciding whether two
        // free-text addresses are "the same place" is a problem this importer
        // is not going to solve, and adding a near-duplicate is worse than
        // leaving the file's copy out.
        if (target.Addresses.Count == 0)
        {
            var first = true;
            foreach (var a in record.Addresses)
            {
                target.Addresses.Add(new ContactAddress
                {
                    TenantId = tenant.TenantId,
                    ContactId = target.Id,
                    Type = a.Type,
                    StreetLine1 = Fit.Cap(a.Street1, 300),
                    StreetLine2 = Fit.Cap(a.Street2, 300),
                    City = Fit.Cap(a.City, 150),
                    StateProvince = Fit.Cap(a.Region, 150),
                    PostalCode = Fit.Cap(a.Postcode, 32),
                    Country = Fit.Cap(a.Country, 150),
                    IsPrimary = first,
                    CreatedAt = now,
                });
                first = false;
            }
        }

        if (record.IsFavourite) target.IsFavourite = true;
        target.UpdatedAt = now;
    }

    private static void ApplyLabels(
        AppDbContext db, TenantContext tenant, Guid uid, Guid contactId,
        ContactRecord record, string? tag, ImportOptions options,
        Dictionary<string, ContactGroup> groupsByName,
        HashSet<(Guid, Guid)> existingMemberships,
        bool dryRun)
    {
        if (dryRun) return;

        var wanted = new List<string>();
        foreach (var l in record.Labels)
        {
            var capped = Fit.Cap(l, 200);
            if (capped is not null) wanted.Add(capped);
        }
        if (tag is not null) wanted.Add(tag);

        foreach (var label in wanted.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!groupsByName.TryGetValue(label, out var group))
            {
                // The tag is always created — it is the caller's own request,
                // and without it there is no way to find this import again.
                if (!options.CreateLabels && !label.Equals(tag, StringComparison.OrdinalIgnoreCase))
                    continue;

                group = new ContactGroup
                {
                    TenantId = tenant.TenantId,
                    CreatedByUserId = uid,
                    Name = label,
                };
                db.ContactGroups.Add(group);
                groupsByName[label] = group;
            }

            if (!existingMemberships.Add((group.Id, contactId))) continue;

            db.ContactGroupMembers.Add(new ContactGroupMember
            {
                TenantId = tenant.TenantId,
                GroupId = group.Id,
                ContactId = contactId,
            });
        }
    }

    private static void Audit(
        AppDbContext db, TenantContext tenant, Guid contactId, Guid actor,
        string operation, HttpContext http, Dictionary<string, object?> changes) =>
        db.ContactAuditLogs.Add(new ContactAuditLog
        {
            TenantId = tenant.TenantId,
            ContactId = contactId,
            ActorUserId = actor,
            Operation = operation,
            Changes = JsonSerializer.Serialize(changes),
            Reason = "import",
            IpAddress = http.Connection.RemoteIpAddress?.ToString(),
            UserAgent = http.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua
                ? (ua.Length > 512 ? ua[..512] : ua)
                : null,
        });
}

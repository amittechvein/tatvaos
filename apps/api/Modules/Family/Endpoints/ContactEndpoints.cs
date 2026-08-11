using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Family.Endpoints;

/// <summary>
/// The Family client's API — what family.tatvaos.com talks to.
///
/// ─────────────────────────────────────────────────────────────────────────
///  A contact id in a URL proves nothing. Every handler loads through the
///  DbSet, which carries the tenant AND ownership query filter, and RLS
///  repeats the test underneath. A colleague's personal contact is therefore
///  a 404 here, not a 403 — telling someone a row exists but is not theirs
///  is itself a disclosure.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Ownership, restated because it drives every route below:
///
///   personal        OwnerUserId = the caller. Only they see it.
///   organisational  OwnerUserId null. Everyone in the tenant sees it.
///
/// Promotion from personal to organisational is a deliberate act
/// (PATCH ownershipType), and it is one-way in this version: demoting back
/// would have to pick which colleague inherits it, and guessing that wrong
/// silently hands one person's address book to another.
/// </summary>
public static class ContactEndpoints
{
    public static void MapFamilyEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/family")
            .RequireAuthorization("User")
            .WithTags("Family");

        g.MapGet("/bootstrap", BootstrapAsync);

        g.MapGet("/contacts", ListAsync);
        g.MapPost("/contacts", CreateAsync);
        g.MapGet("/contacts/{id:guid}", GetAsync);
        g.MapPatch("/contacts/{id:guid}", PatchAsync);
        g.MapDelete("/contacts/{id:guid}", DeleteAsync);
        g.MapPost("/contacts/{id:guid}/restore", RestoreAsync);

        g.MapGet("/contacts/search", SearchAsync);
        g.MapGet("/contacts/autocomplete", AutocompleteAsync);
        g.MapGet("/contacts/lookup", LookupByEmailAsync);

        g.MapPost("/contacts/{id:guid}/emails", AddEmailAsync);
        g.MapDelete("/contacts/{id:guid}/emails/{emailId:guid}", RemoveEmailAsync);
        g.MapPost("/contacts/{id:guid}/phones", AddPhoneAsync);
        g.MapDelete("/contacts/{id:guid}/phones/{phoneId:guid}", RemovePhoneAsync);

        g.MapGet("/contacts/{id:guid}/interactions", InteractionsAsync);
        g.MapPost("/contacts/{id:guid}/interactions", LogInteractionAsync);
        g.MapGet("/contacts/{id:guid}/audit", AuditAsync);

        g.MapGet("/groups", ListGroupsAsync);
        g.MapPost("/groups", CreateGroupAsync);
        g.MapPatch("/groups/{groupId:guid}", UpdateGroupAsync);
        g.MapDelete("/groups/{groupId:guid}", DeleteGroupAsync);
        g.MapPut("/groups/{groupId:guid}/members/{id:guid}", AddToGroupAsync);
        g.MapDelete("/groups/{groupId:guid}/members/{id:guid}", RemoveFromGroupAsync);

        // Import and export live in their own file — the parsing they need is
        // longer than everything above put together.
        g.MapImportExport();

        g.MapGet("/settings", GetSettingsAsync);
        g.MapPut("/settings", PutSettingsAsync);
    }

    // ------------------------------------------------------------------
    //  The caller. NULL is not a normal state on these routes — the group
    //  requires authentication — but the claim is still optional in the
    //  type system, and defaulting it to Guid.Empty would match rows.
    // ------------------------------------------------------------------
    private static bool TryCaller(TenantContext tenant, out Guid userId)
    {
        if (tenant.UserId is Guid uid) { userId = uid; return true; }
        userId = default;
        return false;
    }

    /// <summary>
    /// Live contacts only. Soft-deleted rows stay readable through the audit
    /// route, which is the whole reason the delete is soft.
    /// </summary>
    private static IQueryable<Contact> Live(AppDbContext db) =>
        db.Contacts.Where(c => c.DeletedAt == null);

    // ==================================================================
    //  Bootstrap
    // ==================================================================

    /// <summary>
    /// Everything the client needs on first paint, in one round trip: counts,
    /// groups and the caller's auto-save settings. Three separate calls here
    /// would each pay the same auth and connection cost.
    /// </summary>
    private static async Task<IResult> BootstrapAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var total = await Live(db).CountAsync(ct);
        var mine = await Live(db).CountAsync(c => c.OwnerUserId == uid, ct);
        var shared = await Live(db).CountAsync(c => c.OwnershipType == "organisational", ct);

        var groups = await db.ContactGroups
            .OrderBy(x => x.Name)
            .Select(x => new GroupDto(x.Id, x.Name, x.Description, x.Colour))
            .ToListAsync(ct);

        var s = await db.ContactSettings.FirstOrDefaultAsync(x => x.UserId == uid, ct);

        return Results.Ok(new
        {
            counts = new { total, personal = mine, organisational = shared },
            groups,
            settings = new SettingsDto(
                s?.AutoSaveReceived ?? true,
                s?.AutoSaveSent ?? false,
                s?.AutoSaveReply ?? true)
        });
    }

    // ==================================================================
    //  Contacts
    // ==================================================================

    private static async Task<IResult> ListAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct,
        string? ownership = null, Guid? groupId = null, bool? favourite = null,
        string? source = null, string? sort = null, bool deleted = false,
        int page = 1, int pageSize = 50)
    {
        if (page < 1) page = 1;
        // Capped rather than rejected. A client asking for 5000 rows is a bug
        // in the client, and failing the request makes that bug look like ours.
        pageSize = Math.Clamp(pageSize, 1, 200);

        // deleted=true is the Bin. Soft-deleted rows are otherwise invisible
        // everywhere, which is the point — this is the one door to them.
        var q = deleted
            ? db.Contacts.Where(c => c.DeletedAt != null)
            : Live(db);

        if (ownership is "personal" or "organisational")
            q = q.Where(c => c.OwnershipType == ownership);

        if (favourite == true)
            q = q.Where(c => c.IsFavourite);

        // "auto" is the whole family of auto_* sources rather than one value:
        // the client's question is "what did mail decide to save", not which
        // particular flavour of mail event produced it.
        if (source == "auto")
            q = q.Where(c => c.Source == "auto_received"
                          || c.Source == "auto_sent"
                          || c.Source == "auto_reply");
        else if (source == "manual")
            q = q.Where(c => c.Source == "manual" || c.Source == "import" || c.Source == "api");

        if (groupId is Guid gid)
            q = q.Where(c => db.ContactGroupMembers
                .Any(m => m.GroupId == gid && m.ContactId == c.Id));

        var total = await q.CountAsync(ct);

        // Sorting is server-side because it has to hold across pages. Sorting
        // one page in the browser puts the most-contacted person on page four
        // at the top of page one and nowhere near the truth.
        q = sort switch
        {
            // Nulls last: someone never contacted is not "most recent".
            "recent"   => q.OrderByDescending(c => c.LastContactedAt ?? DateTimeOffset.MinValue),
            "frequent" => q.OrderByDescending(c => c.InteractionCount)
                           .ThenByDescending(c => c.LastContactedAt ?? DateTimeOffset.MinValue),
            "deleted"  => q.OrderByDescending(c => c.DeletedAt),
            _          => q.OrderBy(c => c.DisplayName),
        };

        var items = await q
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(Summary)
            .ToListAsync(ct);

        return Results.Ok(new { total, page, pageSize, items });
    }

    /// <summary>
    /// Undo a soft delete.
    ///
    /// Deliberately does NOT reset Source. A contact that came from mail and
    /// was deleted and restored is still one mail saved — rewriting that would
    /// lose the only record of where it came from.
    /// </summary>
    private static async Task<IResult> RestoreAsync(
        Guid id, AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var c = await db.Contacts.FirstOrDefaultAsync(x => x.Id == id && x.DeletedAt != null, ct);
        if (c is null) return Results.NotFound();

        c.DeletedAt = null;
        c.UpdatedAt = DateTimeOffset.UtcNow;
        Audit(db, tenant, c.Id, uid, "update",
            new Dictionary<string, object?> { ["restored"] = true }, http);

        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var c = await Live(db)
            .Include(x => x.Emails)
            .Include(x => x.Phones)
            .Include(x => x.Addresses)
            .FirstOrDefaultAsync(x => x.Id == id, ct);

        if (c is null) return Results.NotFound();

        var groups = await db.ContactGroupMembers
            .Where(m => m.ContactId == id)
            .Join(db.ContactGroups, m => m.GroupId, x => x.Id,
                  (m, x) => new GroupDto(x.Id, x.Name, x.Description, x.Colour))
            .ToListAsync(ct);

        return Results.Ok(new ContactDetailDto(
            c.Id, c.DisplayName, c.FirstName, c.LastName, c.Nickname,
            c.JobTitle, c.CompanyName, c.OwnershipType, c.Source,
            c.IsFavourite, c.Notes, c.LastContactedAt, c.InteractionCount,
            c.CreatedAt, c.UpdatedAt,
            c.Emails.OrderByDescending(e => e.IsPrimary)
                    .Select(e => new EmailDto(e.Id, e.Email, e.Type, e.IsPrimary)).ToList(),
            c.Phones.OrderByDescending(p => p.IsPrimary)
                    .Select(p => new PhoneDto(p.Id, p.Phone, p.Type, p.IsPrimary)).ToList(),
            c.Addresses.Select(a => new AddressDto(
                a.Id, a.Type, a.StreetLine1, a.StreetLine2, a.City,
                a.StateProvince, a.PostalCode, a.Country, a.IsPrimary)).ToList(),
            groups));
    }

    private static async Task<IResult> CreateAsync(
        CreateContactRequest req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var display = (req.DisplayName ?? string.Empty).Trim();
        if (display.Length == 0)
            return Results.ValidationProblem(new Dictionary<string, string[]>
                { ["displayName"] = ["A display name is required."] });

        var organisational = req.OwnershipType == "organisational";

        // Reject a duplicate rather than silently merging. A merge is a
        // destructive edit to a row the caller has not seen, and the client
        // can offer "open the existing one" with the id returned here.
        if (req.Email is { Length: > 0 })
        {
            var key = ContactMatching.NormaliseEmail(req.Email);
            var clash = await Live(db)
                .Where(c => db.ContactEmails.Any(e =>
                    e.ContactId == c.Id && e.EmailNormalised == key))
                .Select(c => new { c.Id, c.DisplayName })
                .FirstOrDefaultAsync(ct);

            if (clash is not null)
                return Results.Conflict(new
                {
                    error = "duplicate_email",
                    message = $"{req.Email} already belongs to {clash.DisplayName}.",
                    contactId = clash.Id
                });
        }

        var contact = new Contact
        {
            TenantId = tenant.TenantId,
            CreatedByUserId = uid,
            OwnershipType = organisational ? "organisational" : "personal",
            OwnerUserId = organisational ? null : uid,
            DisplayName = display,
            FirstName = Trim(req.FirstName),
            LastName = Trim(req.LastName),
            Nickname = Trim(req.Nickname),
            JobTitle = Trim(req.JobTitle),
            CompanyName = Trim(req.CompanyName),
            Notes = Trim(req.Notes),
            IsFavourite = req.IsFavourite ?? false,
            Source = "manual"
        };
        db.Contacts.Add(contact);

        if (req.Email is { Length: > 0 })
            db.ContactEmails.Add(new ContactEmail
            {
                TenantId = tenant.TenantId,
                ContactId = contact.Id,
                Email = req.Email.Trim(),
                EmailNormalised = ContactMatching.NormaliseEmail(req.Email),
                Type = req.EmailType ?? "work",
                IsPrimary = true
            });

        if (req.Phone is { Length: > 0 })
            db.ContactPhones.Add(new ContactPhone
            {
                TenantId = tenant.TenantId,
                ContactId = contact.Id,
                Phone = req.Phone.Trim(),
                PhoneNormalised = ContactMatching.NormalisePhone(req.Phone),
                Type = req.PhoneType ?? "mobile",
                IsPrimary = true
            });

        Audit(db, tenant, contact.Id, uid, "create", null, http);

        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/family/contacts/{contact.Id}", new { id = contact.Id });
    }

    /// <summary>
    /// Partial update. Absent property means "leave it"; an explicitly null
    /// one means "clear it" — which is why every field here is nullable and
    /// the request carries a separate set of "clear" semantics through
    /// empty strings rather than nulls.
    /// </summary>
    private static async Task<IResult> PatchAsync(
        Guid id, PatchContactRequest req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var c = await Live(db).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();

        var changes = new Dictionary<string, object?>();

        if (req.DisplayName is { } dn && dn.Trim().Length > 0 && dn.Trim() != c.DisplayName)
        { changes["displayName"] = new { old = c.DisplayName, @new = dn.Trim() }; c.DisplayName = dn.Trim(); }

        if (req.FirstName is not null && Trim(req.FirstName) != c.FirstName)
        { changes["firstName"] = new { old = c.FirstName, @new = Trim(req.FirstName) }; c.FirstName = Trim(req.FirstName); }

        if (req.LastName is not null && Trim(req.LastName) != c.LastName)
        { changes["lastName"] = new { old = c.LastName, @new = Trim(req.LastName) }; c.LastName = Trim(req.LastName); }

        if (req.Nickname is not null) c.Nickname = Trim(req.Nickname);
        if (req.JobTitle is not null) c.JobTitle = Trim(req.JobTitle);
        if (req.CompanyName is not null) c.CompanyName = Trim(req.CompanyName);
        if (req.Notes is not null) c.Notes = Trim(req.Notes);
        if (req.IsFavourite is bool fav) c.IsFavourite = fav;

        // One-way, and only by the owner. Sharing my address book with the
        // organisation is mine to decide; taking it back would have to name
        // a new owner, and there is no right answer to that.
        if (req.OwnershipType == "organisational" && c.OwnershipType == "personal")
        {
            if (c.OwnerUserId != uid)
                return Results.Problem(
                    title: "Only the owner can share a contact with the organisation.",
                    statusCode: StatusCodes.Status403Forbidden);
            changes["ownershipType"] = new { old = "personal", @new = "organisational" };
            c.OwnershipType = "organisational";
            c.OwnerUserId = null;
        }
        else if (req.OwnershipType == "personal" && c.OwnershipType == "organisational")
        {
            return Results.Problem(
                title: "An organisational contact cannot be made personal.",
                detail: "It would have to be assigned to one person, and this endpoint " +
                        "cannot decide who. Create a personal copy instead.",
                statusCode: StatusCodes.Status409Conflict);
        }

        if (changes.Count == 0 && req.IsFavourite is null &&
            req.Nickname is null && req.JobTitle is null &&
            req.CompanyName is null && req.Notes is null)
            return Results.NoContent();   // nothing to do; do not write an audit row

        c.UpdatedAt = DateTimeOffset.UtcNow;
        if (changes.Count > 0) Audit(db, tenant, c.Id, uid, "update", changes, http);

        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>
    /// Soft delete. The row stays so the audit trail keeps a subject, and so
    /// auto-save does not immediately recreate the contact from the next
    /// message — a hard delete would make "stop saving this person" impossible.
    /// </summary>
    private static async Task<IResult> DeleteAsync(
        Guid id, AppDbContext db, TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var c = await Live(db).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();

        c.DeletedAt = DateTimeOffset.UtcNow;
        c.UpdatedAt = c.DeletedAt.Value;
        Audit(db, tenant, c.Id, uid, "delete", null, http);

        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ==================================================================
    //  Finding people
    // ==================================================================

    /// <summary>
    /// Full-text over the trigger-maintained vector, with a prefix match on
    /// the display name as a fallback. The vector alone misses "sam" for
    /// "Samuel"; the prefix alone misses a match on company or job title.
    /// </summary>
    private static async Task<IResult> SearchAsync(
        string q, AppDbContext db, TenantContext tenant, CancellationToken ct,
        int limit = 50)
    {
        var term = (q ?? string.Empty).Trim();
        if (term.Length == 0) return Results.Ok(Array.Empty<ContactSummaryDto>());
        limit = Math.Clamp(limit, 1, 100);

        var prefix = term.ToLowerInvariant() + "%";

        var items = await Live(db)
            .Where(c =>
                c.SearchVector!.Matches(EF.Functions.PlainToTsQuery("simple", term)) ||
                EF.Functions.ILike(c.DisplayName, prefix) ||
                db.ContactEmails.Any(e => e.ContactId == c.Id &&
                                          EF.Functions.ILike(e.Email, prefix)))
            .OrderBy(c => c.DisplayName)
            .Take(limit)
            .Select(Summary)
            .ToListAsync(ct);

        return Results.Ok(items);
    }

    /// <summary>
    /// Typeahead for the composer. Ten rows, prefix only, and deliberately
    /// NOT the full-text path — a recipient picker is judged on latency, and
    /// ranked relevance is the wrong trade there.
    /// </summary>
    private static async Task<IResult> AutocompleteAsync(
        string q, AppDbContext db, TenantContext tenant, CancellationToken ct,
        int limit = 10)
    {
        var term = (q ?? string.Empty).Trim();
        if (term.Length == 0) return Results.Ok(Array.Empty<object>());
        limit = Math.Clamp(limit, 1, 25);

        var prefix = term.ToLowerInvariant() + "%";

        // TWO SOURCES, AND THEY ARE DIFFERENT KINDS OF PERSON.
        //
        //   family.contacts  people you correspond with  — external
        //   core.users       your colleagues             — internal
        //
        // A recipient picker that offers only the first is the wrong tool: the
        // address you type most often is the one next to you. Colleagues were
        // never in Family and never will be — a person exists once, in Core —
        // so this reads both and merges.
        //
        // Colleagues are listed FIRST. Typing three letters and getting a
        // supplier before your own team is the behaviour people complain about.
        var colleagues = await db.Users
            .Where(u => u.Status == "active" &&
                        (EF.Functions.ILike(u.Email, prefix) ||
                         EF.Functions.ILike(u.DisplayName, prefix)))
            .OrderBy(u => u.DisplayName)
            .Take(limit)
            .Select(u => new AutocompleteRow(u.Id, u.Email, u.DisplayName, true))
            .ToListAsync(ct);

        var contacts = await db.ContactEmails
            .Where(e => EF.Functions.ILike(e.Email, prefix) ||
                        db.Contacts.Any(c => c.Id == e.ContactId &&
                                             c.DeletedAt == null &&
                                             EF.Functions.ILike(c.DisplayName, prefix)))
            .OrderByDescending(e => e.IsPrimary)
            .Take(limit)
            .Select(e => new AutocompleteRow(
                e.ContactId,
                e.Email,
                db.Contacts.Where(c => c.Id == e.ContactId)
                           .Select(c => c.DisplayName).FirstOrDefault() ?? e.Email,
                false))
            .ToListAsync(ct);

        // A colleague who is ALSO saved as a contact would otherwise appear
        // twice. The colleague row wins — it is the authoritative record of
        // that person, and a stale copy in someone's address book should not
        // shadow it.
        var seen = colleagues.Select(c => c.Email.ToLowerInvariant()).ToHashSet();
        var merged = colleagues
            .Concat(contacts.Where(c => !seen.Contains(c.Email.ToLowerInvariant())))
            .Take(limit)
            .ToList();

        return Results.Ok(merged);
    }

    /// <summary>
    /// Exact lookup by address, normalised. This is what Mail calls to put a
    /// name on a sender — hence the 404 rather than an empty list, so the
    /// caller can branch on "known" without inspecting a body.
    /// </summary>
    private static async Task<IResult> LookupByEmailAsync(
        string email, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(email)) return Results.BadRequest();

        var key = ContactMatching.NormaliseEmail(email);

        var hit = await Live(db)
            .Where(c => db.ContactEmails.Any(e => e.ContactId == c.Id && e.EmailNormalised == key))
            .Select(Summary)
            .FirstOrDefaultAsync(ct);

        return hit is null ? Results.NotFound() : Results.Ok(hit);
    }

    // ==================================================================
    //  Addresses and numbers
    // ==================================================================

    private static async Task<IResult> AddEmailAsync(
        Guid id, AddEmailRequest req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(req.Email)) return Results.BadRequest();

        var c = await Live(db).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();

        var key = ContactMatching.NormaliseEmail(req.Email);

        var owner = await Live(db)
            .Where(x => db.ContactEmails.Any(e => e.ContactId == x.Id && e.EmailNormalised == key))
            .Select(x => new { x.Id, x.DisplayName })
            .FirstOrDefaultAsync(ct);

        if (owner is not null)
            return owner.Id == id
                ? Results.NoContent()                       // already here; nothing to do
                : Results.Conflict(new
                {
                    error = "duplicate_email",
                    message = $"{req.Email} already belongs to {owner.DisplayName}.",
                    contactId = owner.Id
                });

        if (req.IsPrimary == true)
            await db.ContactEmails.Where(e => e.ContactId == id && e.IsPrimary)
                .ForEachAsync(e => e.IsPrimary = false, ct);

        db.ContactEmails.Add(new ContactEmail
        {
            TenantId = tenant.TenantId,
            ContactId = id,
            Email = req.Email.Trim(),
            EmailNormalised = key,
            Type = req.Type ?? "work",
            IsPrimary = req.IsPrimary ?? false
        });

        c.UpdatedAt = DateTimeOffset.UtcNow;
        Audit(db, tenant, id, uid, "update",
            new Dictionary<string, object?> { ["addEmail"] = req.Email.Trim() }, http);

        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> RemoveEmailAsync(
        Guid id, Guid emailId, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var e = await db.ContactEmails.FirstOrDefaultAsync(
            x => x.Id == emailId && x.ContactId == id, ct);
        if (e is null) return Results.NotFound();

        db.ContactEmails.Remove(e);
        Audit(db, tenant, id, uid, "update",
            new Dictionary<string, object?> { ["removeEmail"] = e.Email }, http);

        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> AddPhoneAsync(
        Guid id, AddPhoneRequest req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(req.Phone)) return Results.BadRequest();

        var c = await Live(db).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();

        if (req.IsPrimary == true)
            await db.ContactPhones.Where(p => p.ContactId == id && p.IsPrimary)
                .ForEachAsync(p => p.IsPrimary = false, ct);

        db.ContactPhones.Add(new ContactPhone
        {
            TenantId = tenant.TenantId,
            ContactId = id,
            Phone = req.Phone.Trim(),
            PhoneNormalised = ContactMatching.NormalisePhone(req.Phone),
            Type = req.Type ?? "mobile",
            IsPrimary = req.IsPrimary ?? false
        });

        c.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> RemovePhoneAsync(
        Guid id, Guid phoneId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var p = await db.ContactPhones.FirstOrDefaultAsync(
            x => x.Id == phoneId && x.ContactId == id, ct);
        if (p is null) return Results.NotFound();

        db.ContactPhones.Remove(p);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ==================================================================
    //  History
    // ==================================================================

    private static async Task<IResult> InteractionsAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct,
        int limit = 50)
    {
        if (!await Live(db).AnyAsync(c => c.Id == id, ct)) return Results.NotFound();
        limit = Math.Clamp(limit, 1, 200);

        var items = await db.ContactInteractions
            .Where(i => i.ContactId == id)
            .OrderByDescending(i => i.OccurredAt)
            .Take(limit)
            .Select(i => new InteractionDto(
                i.Id, i.Type, i.Subject, i.Notes, i.MailMessageId, i.OccurredAt))
            .ToListAsync(ct);

        return Results.Ok(items);
    }

    private static async Task<IResult> LogInteractionAsync(
        Guid id, LogInteractionRequest req, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        string[] allowed = ["email_received", "email_sent", "call_inbound",
                            "call_outbound", "meeting", "note", "other"];
        if (!allowed.Contains(req.Type))
            return Results.ValidationProblem(new Dictionary<string, string[]>
                { ["type"] = [$"Must be one of: {string.Join(", ", allowed)}."] });

        var c = await Live(db).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();

        db.ContactInteractions.Add(new ContactInteraction
        {
            TenantId = tenant.TenantId,
            ContactId = id,
            Type = req.Type,
            Subject = Trim(req.Subject),
            Notes = Trim(req.Notes),
            OccurredAt = req.OccurredAt ?? DateTimeOffset.UtcNow
        });

        var when = req.OccurredAt ?? DateTimeOffset.UtcNow;
        if (c.LastContactedAt is null || when > c.LastContactedAt) c.LastContactedAt = when;
        c.InteractionCount++;
        c.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>
    /// Note this checks db.Contacts, not Live(db): the audit trail of a
    /// DELETED contact is exactly what someone comes here to read, and the
    /// soft delete exists so it survives. Tenant and ownership still apply.
    /// </summary>
    private static async Task<IResult> AuditAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct,
        int limit = 100)
    {
        if (!await db.Contacts.AnyAsync(c => c.Id == id, ct)) return Results.NotFound();
        limit = Math.Clamp(limit, 1, 500);

        var items = await db.ContactAuditLogs
            .Where(a => a.ContactId == id)
            .OrderByDescending(a => a.OccurredAt)
            .Take(limit)
            .Select(a => new AuditDto(a.Id, a.Operation, a.ActorUserId,
                                      a.Changes, a.Reason, a.OccurredAt))
            .ToListAsync(ct);

        return Results.Ok(items);
    }

    // ==================================================================
    //  Groups
    // ==================================================================

    /// <summary>
    /// Every label, with how many live contacts carry it.
    ///
    /// The count is a SECOND query joined in memory rather than a correlated
    /// subquery inside the projection. Two reasons: a label screen showing "12
    /// contacts" when three of them are in the Bin is wrong, and the version
    /// that gets that right in one statement nests an EXISTS inside a COUNT
    /// inside a SELECT — which either translates or throws at request time,
    /// and this route is called on every contacts page load. The join-and-group
    /// form is the same shape used by the export route and is not clever.
    /// </summary>
    private static async Task<IResult> ListGroupsAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var groups = await db.ContactGroups
            .OrderBy(x => x.Name)
            .Select(x => new { x.Id, x.Name, x.Description, x.Colour })
            .ToListAsync(ct);

        var counts = await db.ContactGroupMembers
            .Join(db.Contacts.Where(c => c.DeletedAt == null),
                  m => m.ContactId, c => c.Id, (m, c) => m.GroupId)
            .GroupBy(id => id)
            .Select(g => new { GroupId = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        var byGroup = counts.ToDictionary(x => x.GroupId, x => x.Count);

        var items = groups
            .Select(x => new LabelDto(
                x.Id, x.Name, x.Description, x.Colour,
                byGroup.TryGetValue(x.Id, out var n) ? n : 0))
            .ToList();

        return Results.Ok(items);
    }

    /// <summary>
    /// Rename a label, or change its colour.
    ///
    /// Renaming rather than delete-and-recreate matters: a label is referenced
    /// by every membership row, and recreating one silently empties it. The
    /// name is unique per tenant, so a clash is a 409 naming the offender
    /// rather than a constraint violation nobody can read.
    /// </summary>
    private static async Task<IResult> UpdateGroupAsync(
        Guid groupId, UpdateGroupRequest req, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        var g = await db.ContactGroups.FirstOrDefaultAsync(x => x.Id == groupId, ct);
        if (g is null) return Results.NotFound();

        if (req.Name is { } supplied)
        {
            var name = supplied.Trim();

            if (name.Length == 0)
                return Results.ValidationProblem(new Dictionary<string, string[]>
                    { ["name"] = ["A name is required."] });

            if (name.Length > 200)
                return Results.ValidationProblem(new Dictionary<string, string[]>
                    { ["name"] = ["A label name cannot be longer than 200 characters."] });

            if (name != g.Name &&
                await db.ContactGroups.AnyAsync(x => x.Name == name && x.Id != groupId, ct))
                return Results.Conflict(new
                {
                    error = "duplicate_group",
                    message = $"\"{name}\" already exists.",
                });

            g.Name = name;
        }

        // Absent means leave it; an empty string means clear it. Trim folds
        // whitespace-only to null, which is the same thing.
        if (req.Description is not null) g.Description = Trim(req.Description);
        if (req.Colour is not null) g.Colour = Trim(req.Colour);

        g.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> CreateGroupAsync(
        CreateGroupRequest req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var name = (req.Name ?? string.Empty).Trim();
        if (name.Length == 0)
            return Results.ValidationProblem(new Dictionary<string, string[]>
                { ["name"] = ["A name is required."] });

        // The column is 200. Without this, a pasted paragraph is a 500 rather
        // than a message anyone can act on.
        if (name.Length > 200)
            return Results.ValidationProblem(new Dictionary<string, string[]>
                { ["name"] = ["A label name cannot be longer than 200 characters."] });

        if (await db.ContactGroups.AnyAsync(x => x.Name == name, ct))
            return Results.Conflict(new { error = "duplicate_group", message = $"\"{name}\" already exists." });

        var g = new ContactGroup
        {
            TenantId = tenant.TenantId,
            CreatedByUserId = uid,
            Name = name,
            Description = Trim(req.Description),
            Colour = Trim(req.Colour)
        };
        db.ContactGroups.Add(g);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/family/groups/{g.Id}", new { id = g.Id });
    }

    private static async Task<IResult> DeleteGroupAsync(
        Guid groupId, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var g = await db.ContactGroups.FirstOrDefaultAsync(x => x.Id == groupId, ct);
        if (g is null) return Results.NotFound();

        // Members cascade in the database. The contacts themselves do not —
        // deleting "Suppliers" must not delete the suppliers.
        db.ContactGroups.Remove(g);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> AddToGroupAsync(
        Guid groupId, Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!await db.ContactGroups.AnyAsync(x => x.Id == groupId, ct)) return Results.NotFound();
        if (!await Live(db).AnyAsync(c => c.Id == id, ct)) return Results.NotFound();

        // Idempotent: PUT of an existing membership succeeds rather than 409.
        if (await db.ContactGroupMembers.AnyAsync(m => m.GroupId == groupId && m.ContactId == id, ct))
            return Results.NoContent();

        db.ContactGroupMembers.Add(new ContactGroupMember
        {
            TenantId = tenant.TenantId,
            GroupId = groupId,
            ContactId = id
        });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> RemoveFromGroupAsync(
        Guid groupId, Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var m = await db.ContactGroupMembers
            .FirstOrDefaultAsync(x => x.GroupId == groupId && x.ContactId == id, ct);
        if (m is null) return Results.NotFound();

        db.ContactGroupMembers.Remove(m);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ==================================================================
    //  Settings
    // ==================================================================

    private static async Task<IResult> GetSettingsAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var s = await db.ContactSettings.FirstOrDefaultAsync(x => x.UserId == uid, ct);

        // No row means defaults, not an error. A person who has never opened
        // settings still has auto-save behaviour, and it is the documented one.
        return Results.Ok(new SettingsDto(
            s?.AutoSaveReceived ?? true,
            s?.AutoSaveSent ?? false,
            s?.AutoSaveReply ?? true));
    }

    private static async Task<IResult> PutSettingsAsync(
        SettingsDto req, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (!TryCaller(tenant, out var uid)) return Results.Unauthorized();

        var s = await db.ContactSettings.FirstOrDefaultAsync(x => x.UserId == uid, ct);
        if (s is null)
        {
            s = new ContactSetting { TenantId = tenant.TenantId, UserId = uid };
            db.ContactSettings.Add(s);
        }

        s.AutoSaveReceived = req.AutoSaveReceived;
        s.AutoSaveSent = req.AutoSaveSent;
        s.AutoSaveReply = req.AutoSaveReply;
        s.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return Results.Ok(new SettingsDto(s.AutoSaveReceived, s.AutoSaveSent, s.AutoSaveReply));
    }

    // ==================================================================
    //  Shared bits
    // ==================================================================

    private static string? Trim(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>
    /// The list projection, defined once. Every list route returns the same
    /// shape, so the client has one row renderer rather than four.
    ///
    /// An Expression, not a method. A method called inside Select() cannot be
    /// translated — EF would either fail outright or silently fall back to
    /// evaluating it per row on the client, which is a table scan wearing a
    /// projection's clothes. The email comes through the Emails navigation so
    /// the provider can turn it into a correlated subquery.
    /// </summary>
    private static readonly System.Linq.Expressions.Expression<Func<Contact, ContactSummaryDto>>
        Summary = c => new ContactSummaryDto(
            c.Id, c.DisplayName, c.JobTitle, c.CompanyName,
            c.Emails.OrderByDescending(e => e.IsPrimary)
                    .Select(e => e.Email).FirstOrDefault(),
            c.OwnershipType, c.Source, c.IsFavourite,
            c.LastContactedAt, c.InteractionCount, c.UpdatedAt);

    /// <summary>
    /// Queues an audit row. Not saved here — it rides on the caller's
    /// SaveChanges so the record and the change commit together or not at all.
    /// </summary>
    private static void Audit(
        AppDbContext db, TenantContext tenant, Guid contactId, Guid actor,
        string operation, Dictionary<string, object?>? changes, HttpContext http) =>
        db.ContactAuditLogs.Add(new ContactAuditLog
        {
            TenantId = tenant.TenantId,
            ContactId = contactId,
            ActorUserId = actor,
            Operation = operation,
            Changes = changes is null ? null : JsonSerializer.Serialize(changes),
            IpAddress = http.Connection.RemoteIpAddress?.ToString(),
            UserAgent = http.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua
                ? (ua.Length > 512 ? ua[..512] : ua)
                : null
        });
}

// ============================================================================
//  Contracts
//
//  Records, not classes: these are values that cross the wire once and are
//  never mutated, and the compiler-generated equality makes them trivial to
//  assert on in tests.
// ============================================================================

public record ContactSummaryDto(
    Guid Id, string DisplayName, string? JobTitle, string? CompanyName,
    string? PrimaryEmail, string OwnershipType, string Source, bool IsFavourite,
    DateTimeOffset? LastContactedAt, int InteractionCount, DateTimeOffset UpdatedAt);

public record ContactDetailDto(
    Guid Id, string DisplayName, string? FirstName, string? LastName, string? Nickname,
    string? JobTitle, string? CompanyName, string OwnershipType, string Source,
    bool IsFavourite, string? Notes, DateTimeOffset? LastContactedAt, int InteractionCount,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
    List<EmailDto> Emails, List<PhoneDto> Phones, List<AddressDto> Addresses,
    List<GroupDto> Groups);

public record EmailDto(Guid Id, string Email, string Type, bool IsPrimary);
public record PhoneDto(Guid Id, string Phone, string Type, bool IsPrimary);
public record AddressDto(Guid Id, string Type, string? StreetLine1, string? StreetLine2,
    string? City, string? StateProvince, string? PostalCode, string? Country, bool IsPrimary);
public record GroupDto(Guid Id, string Name, string? Description, string? Colour);

/// <summary>
/// A label on the manage-labels screen. Same as GroupDto plus the number of
/// live contacts carrying it, which is the one thing that makes a label list
/// worth looking at — an empty label is a tidy-up, a label with forty is a
/// filter.
/// </summary>
public record LabelDto(Guid Id, string Name, string? Description, string? Colour, int Count);
public record InteractionDto(Guid Id, string Type, string? Subject, string? Notes,
    Guid? MailMessageId, DateTimeOffset OccurredAt);
public record AuditDto(Guid Id, string Operation, Guid? ActorUserId, string? Changes,
    string? Reason, DateTimeOffset OccurredAt);
public record SettingsDto(bool AutoSaveReceived, bool AutoSaveSent, bool AutoSaveReply);

/// <summary>
/// One row in the recipient picker. IsColleague distinguishes a core.users row
/// from a family.contacts one — the client can badge them differently, and
/// only the latter has a contact card to open.
/// </summary>
public record AutocompleteRow(Guid Id, string Email, string DisplayName, bool IsColleague);

public record CreateContactRequest(
    string? DisplayName, string? FirstName, string? LastName, string? Nickname,
    string? JobTitle, string? CompanyName, string? Notes, bool? IsFavourite,
    string? OwnershipType, string? Email, string? EmailType, string? Phone, string? PhoneType);

public record PatchContactRequest(
    string? DisplayName, string? FirstName, string? LastName, string? Nickname,
    string? JobTitle, string? CompanyName, string? Notes, bool? IsFavourite,
    string? OwnershipType);

public record AddEmailRequest(string? Email, string? Type, bool? IsPrimary);
public record AddPhoneRequest(string? Phone, string? Type, bool? IsPrimary);
public record CreateGroupRequest(string? Name, string? Description, string? Colour);

/// <summary>Every field optional: absent means leave it alone.</summary>
public record UpdateGroupRequest(string? Name, string? Description, string? Colour);
public record LogInteractionRequest(string Type, string? Subject, string? Notes,
    DateTimeOffset? OccurredAt);

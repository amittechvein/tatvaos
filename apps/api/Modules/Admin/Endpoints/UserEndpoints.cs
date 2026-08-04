using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Organisation administration — users and categories within one tenant.
///
/// Every query here is scoped by the tenant on the authenticated principal.
/// There is no route parameter for the tenant, deliberately: an id in the URL
/// is an id a client can change.
///
/// One boundary worth stating explicitly, because it is a design position and
/// not an oversight: an organisation admin can create users, reset passwords
/// and set quotas, but has NO endpoint that returns another user's mail.
/// Administrative power over an account does not imply access to its contents.
/// Where mailbox delegation is genuinely needed it is explicit, audited, and
/// visible to the mailbox owner.
/// </summary>
public static class UserEndpoints
{
    public static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var users = app.MapGroup("/api/org/users")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        users.MapGet("/", ListAsync);
        users.MapPost("/", CreateAsync);
        users.MapPost("/bulk", BulkCreateAsync);
        users.MapPost("/{id:guid}/suspend", SuspendAsync);
        users.MapPost("/{id:guid}/reset-password", ResetPasswordAsync);

        var cats = app.MapGroup("/api/org/categories")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        cats.MapGet("/", ListCategoriesAsync);
        cats.MapPost("/", CreateCategoryAsync);
    }

    private static async Task<IResult> ListAsync(
        AppDbContext db, Guid? categoryId, string? q, CancellationToken ct)
    {
        // No .Where(m => m.TenantId == ...) here — the global query filter and
        // RLS both apply it. Writing it by hand as well would suggest the
        // filter is optional, and someone would eventually "tidy it away".
        var query = db.Mailboxes.AsNoTracking().Where(m => m.Type == "user");

        if (categoryId is Guid cid)
            query = query.Where(m => m.CategoryId == cid);

        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = $"%{q.Trim()}%";
            query = query.Where(m =>
                EF.Functions.ILike(m.Address, term) ||
                (m.DisplayName != null && EF.Functions.ILike(m.DisplayName, term)));
        }

        var list = await query
            .OrderBy(m => m.Address)
            .Select(m => new UserResponse(
                m.Id, m.Address, m.DisplayName, m.CategoryId,
                m.Category != null ? m.Category.Name : null,
                m.Role, m.Status, m.QuotaBytes, m.UsedBytes,
                m.MfaSecretRef != null, m.LastLoginAt, m.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok(list);
    }

    private static async Task<IResult> CreateAsync(
        CreateUserRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, ct);
        if (!capacity.CanAddUser)
            return Results.BadRequest(new { error = capacity.Reason });

        var domain = await db.Domains.FirstOrDefaultAsync(d => d.Id == req.DomainId, ct);
        if (domain is null) return Results.BadRequest(new { error = "Unknown domain." });

        // Mailboxes on an unverified domain would be created and then fail to
        // receive anything, which looks like our bug rather than an incomplete
        // setup. Refuse clearly instead.
        if (domain.OwnershipVerifiedAt is null)
            return Results.BadRequest(new
            {
                error = $"The domain {domain.Fqdn} is not verified yet. Publish the verification " +
                        "TXT record first — mailboxes created now could not receive mail.",
            });

        var localPart = req.LocalPart.Trim().ToLowerInvariant();
        if (!IsValidLocalPart(localPart))
            return Results.BadRequest(new { error = "Invalid local part." });

        var address = $"{localPart}@{domain.Fqdn}";

        // An address must resolve to exactly one mailbox platform-wide, or
        // delivery is ambiguous. Aliases share the same namespace.
        if (await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct) ||
            await db.Aliases.IgnoreQueryFilters().AnyAsync(a => a.Address == address, ct))
            return Results.Conflict(new { error = $"{address} already exists." });

        var category = req.CategoryId is Guid cid
            ? await db.UserCategories.FirstOrDefaultAsync(c => c.Id == cid, ct)
            : null;

        var quota = await storage.ResolveQuotaAsync(tenant.TenantId, req.CategoryId, req.QuotaBytes, ct);
        var password = req.Password ?? PasswordGenerator.Generate();

        var mailbox = new Mailbox
        {
            TenantId = tenant.TenantId,
            DomainId = domain.Id,
            CategoryId = category?.Id,
            Address = address,
            LocalPart = localPart,
            DisplayName = req.DisplayName.Trim(),
            Type = "user",
            Role = category?.DefaultRole ?? "employee",
            Status = "pending",
            PasswordHash = hasher.Hash(password),
            QuotaBytes = quota,
        };

        db.Mailboxes.Add(mailbox);
        db.Folders.AddRange(DefaultFolders(tenant.TenantId, mailbox.Id));
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("user.created", "mailbox", mailbox.Id.ToString(),
            after: new { mailbox.Address, category = category?.Name, quota }, ct: ct);

        // The generated password is returned once and never stored in
        // recoverable form. Losing it means a reset, which is the correct
        // trade — a retrievable password is a stored plaintext password.
        return Results.Created($"/api/org/users/{mailbox.Id}", new
        {
            mailbox.Id,
            mailbox.Address,
            mailbox.QuotaBytes,
            temporaryPassword = req.Password is null ? password : null,
            note = "The user must change this on first sign-in.",
        });
    }

    /// <summary>
    /// Bulk creation.
    ///
    /// A school onboarding 200 students one at a time is the point at which an
    /// admin abandons the product. Partial success is reported per row rather
    /// than failing the batch — one duplicate address should not discard 199
    /// good rows.
    /// </summary>
    private static async Task<IResult> BulkCreateAsync(
        BulkCreateUserRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, ct);
        if (!capacity.CanAddUser)
            return Results.BadRequest(new { error = capacity.Reason });

        if (capacity.MaxUsers is int max && capacity.UserCount + req.Users.Count > max)
            return Results.BadRequest(new
            {
                error = $"Creating {req.Users.Count} users would exceed the limit of {max}. " +
                        $"Currently {capacity.UserCount}.",
            });

        var domain = await db.Domains.FirstOrDefaultAsync(d => d.Id == req.DomainId, ct);
        if (domain is null || domain.OwnershipVerifiedAt is null)
            return Results.BadRequest(new { error = "Domain is unknown or not verified." });

        var quota = await storage.ResolveQuotaAsync(tenant.TenantId, req.CategoryId, null, ct);
        var category = req.CategoryId is Guid cid
            ? await db.UserCategories.FirstOrDefaultAsync(c => c.Id == cid, ct)
            : null;

        var created = new List<object>();
        var skipped = new List<object>();

        foreach (var entry in req.Users)
        {
            var localPart = entry.LocalPart.Trim().ToLowerInvariant();
            var address = $"{localPart}@{domain.Fqdn}";

            if (!IsValidLocalPart(localPart))
            {
                skipped.Add(new { address, reason = "invalid local part" });
                continue;
            }

            if (await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct))
            {
                skipped.Add(new { address, reason = "already exists" });
                continue;
            }

            var password = PasswordGenerator.Generate();
            var mb = new Mailbox
            {
                TenantId = tenant.TenantId,
                DomainId = domain.Id,
                CategoryId = category?.Id,
                Address = address,
                LocalPart = localPart,
                DisplayName = entry.DisplayName.Trim(),
                Role = category?.DefaultRole ?? "employee",
                Status = "pending",
                PasswordHash = hasher.Hash(password),
                QuotaBytes = quota,
            };

            db.Mailboxes.Add(mb);
            db.Folders.AddRange(DefaultFolders(tenant.TenantId, mb.Id));
            created.Add(new { mb.Address, temporaryPassword = password });
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.bulk_created", "mailbox", null,
            after: new { count = created.Count, skipped = skipped.Count }, ct: ct);

        return Results.Ok(new { created, skipped });
    }

    private static async Task<IResult> SuspendAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var mb = await db.Mailboxes.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (mb is null) return Results.NotFound();

        mb.IsActive = false;
        mb.Status = "suspended";
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("user.suspended", "mailbox", id.ToString(), ct: ct);

        // Mail addressed to a suspended mailbox is REJECTED at SMTP time, not
        // accepted and discarded. The sender learns immediately rather than
        // believing it was delivered.
        return Results.Ok(new { mb.Id, mb.Status });
    }

    private static async Task<IResult> ResetPasswordAsync(
        Guid id, AppDbContext db, AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        var mb = await db.Mailboxes.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (mb is null) return Results.NotFound();

        var password = PasswordGenerator.Generate();
        mb.PasswordHash = hasher.Hash(password);
        await db.SaveChangesAsync(ct);

        // Audited because it is a common step in an account takeover. The
        // record is what makes that detectable afterwards.
        await audit.WriteAsync("user.password_reset", "mailbox", id.ToString(), ct: ct);

        return Results.Ok(new { mb.Id, temporaryPassword = password });
    }

    private static async Task<IResult> ListCategoriesAsync(AppDbContext db, CancellationToken ct)
    {
        var cats = await db.UserCategories.AsNoTracking()
            .OrderBy(c => c.Name)
            .Select(c => new
            {
                c.Id, c.Name, c.Description, c.DefaultQuotaBytes,
                c.DefaultRole, c.CanSendExternal, c.AutoGroups, c.Colour,
                UserCount = db.Mailboxes.Count(m => m.CategoryId == c.Id),
            })
            .ToListAsync(ct);

        return Results.Ok(cats);
    }

    private static async Task<IResult> CreateCategoryAsync(
        CreateCategoryRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (await db.UserCategories.AnyAsync(c => c.Name == req.Name, ct))
            return Results.Conflict(new { error = $"A category named {req.Name} already exists." });

        var cat = new UserCategory
        {
            TenantId = tenant.TenantId,
            Name = req.Name.Trim(),
            Description = req.Description,
            DefaultQuotaBytes = req.DefaultQuotaBytes,
            DefaultRole = req.DefaultRole,
            CanSendExternal = req.CanSendExternal,
            AutoGroups = req.AutoGroups ?? [],
            Colour = req.Colour ?? "#3563f0",
        };

        db.UserCategories.Add(cat);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("category.created", "category", cat.Id.ToString(),
            after: new { cat.Name, cat.DefaultQuotaBytes }, ct: ct);

        return Results.Created($"/api/org/categories/{cat.Id}", cat);
    }

    // ------------------------------------------------------------------

    private static IEnumerable<Folder> DefaultFolders(Guid tenantId, Guid mailboxId) =>
    [
        new() { TenantId = tenantId, MailboxId = mailboxId, Name = "INBOX",  SpecialUse = @"\Inbox" },
        new() { TenantId = tenantId, MailboxId = mailboxId, Name = "Sent",   SpecialUse = @"\Sent" },
        new() { TenantId = tenantId, MailboxId = mailboxId, Name = "Drafts", SpecialUse = @"\Drafts" },
        new() { TenantId = tenantId, MailboxId = mailboxId, Name = "Junk",   SpecialUse = @"\Junk" },
        new() { TenantId = tenantId, MailboxId = mailboxId, Name = "Trash",  SpecialUse = @"\Trash" },
    ];

    private static bool IsValidLocalPart(string local) =>
        local.Length is > 0 and <= 64 &&
        System.Text.RegularExpressions.Regex.IsMatch(local, @"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$");
}

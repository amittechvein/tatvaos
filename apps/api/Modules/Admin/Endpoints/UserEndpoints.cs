using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Organisation administration — people and categories within one tenant.
///
/// Every query here is scoped by the tenant on the authenticated principal.
/// There is no route parameter for the tenant, deliberately: an id in the URL
/// is an id a client can change.
///
/// ─────────────────────────────────────────────────────────────────────────
///  These endpoints operate on PEOPLE (core.users), not on mailboxes.
///
///  Creating a person may also create a mailbox, but the person is the thing
///  that exists. Suspending one removes every product at once — which is the
///  entire reason identity sits in Core rather than in Mail. If this ever
///  starts taking a mailbox id, the "one suspend" promise is gone and
///  somebody will keep their Payroll access after they leave.
/// ─────────────────────────────────────────────────────────────────────────
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
        users.MapPost("/{id:guid}/reactivate", ReactivateAsync);
        users.MapPost("/{id:guid}/reset-password", ResetPasswordAsync);
        users.MapPost("/{id:guid}/reset-app-password", ResetAppPasswordAsync);

        var cats = app.MapGroup("/api/org/categories")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        cats.MapGet("/", ListCategoriesAsync);
        cats.MapPost("/", CreateCategoryAsync);
    }

    private static async Task<IResult> ListAsync(
        AppDbContext db, Guid? categoryId, string? q, CancellationToken ct)
    {
        // No .Where(u => u.TenantId == ...) here — the global query filter and
        // RLS both apply it. Writing it by hand as well would suggest the
        // filter is optional, and someone would eventually "tidy it away".
        var query = db.Users.AsNoTracking();

        if (categoryId is Guid cid)
            query = query.Where(u => u.CategoryId == cid);

        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = $"%{q.Trim()}%";
            query = query.Where(u =>
                EF.Functions.ILike(u.Email, term) ||
                EF.Functions.ILike(u.DisplayName, term));
        }

        var list = await query
            .OrderBy(u => u.Email)
            .Select(u => new UserResponse(
                u.Id,
                u.Email,
                u.DisplayName,
                db.Mailboxes.Where(m => m.UserId == u.Id)
                            .Select(m => m.Address).FirstOrDefault(),
                u.CategoryId,
                u.Category != null ? u.Category.Name : null,
                u.Role,
                u.Status,
                db.ProductAccess.Where(p => p.UserId == u.Id && p.RevokedAt == null)
                                .Select(p => p.ProductCode).ToArray(),
                db.Mailboxes.Where(m => m.UserId == u.Id)
                            .Select(m => m.QuotaBytes).FirstOrDefault(),
                db.Mailboxes.Where(m => m.UserId == u.Id)
                            .Select(m => m.UsedBytes).FirstOrDefault(),
                u.MfaEnabled,
                u.LastLoginAt,
                u.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok(list);
    }

    private static async Task<IResult> CreateAsync(
        CreateUserRequest req,
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, "mail", ct);
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

        var category = req.CategoryId is Guid cid
            ? await db.UserCategories.FirstOrDefaultAsync(c => c.Id == cid, ct)
            : null;

        var products = req.Products ?? category?.DefaultProducts ?? ["mail"];
        var wantsMailbox = products.Contains("mail");

        // The sign-in identity must be unique platform-wide. So must a mailbox
        // address, and the two share a namespace, so both are checked even when
        // no mailbox is being created.
        if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == address, ct))
            return Results.Conflict(new { error = $"{address} already exists as a sign-in." });

        if (wantsMailbox &&
            (await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct) ||
             await db.Aliases.IgnoreQueryFilters().AnyAsync(a => a.Address == address, ct)))
            return Results.Conflict(new { error = $"{address} already exists." });

        var password = req.Password ?? PasswordGenerator.Generate();

        // ---- Core: the person -------------------------------------------
        var user = new User
        {
            TenantId = tenant.TenantId,
            DomainId = domain.Id,
            Email = address,
            DisplayName = req.DisplayName.Trim(),
            CategoryId = category?.Id,
            Role = category?.DefaultRole ?? "employee",
            Status = "pending",
            PasswordHash = hasher.Hash(password),
        };
        db.Users.Add(user);

        foreach (var code in products.Distinct())
            db.ProductAccess.Add(new ProductAccess
            {
                TenantId = tenant.TenantId,
                UserId = user.Id,
                ProductCode = code,
            });

        // ---- Mail: what Core grants them --------------------------------
        Mailbox? mailbox = null;
        if (wantsMailbox)
        {
            var quota = await storage.ResolveQuotaAsync(
                tenant.TenantId, req.CategoryId, req.QuotaBytes, "mail", ct);

            mailbox = new Mailbox
            {
                TenantId = tenant.TenantId,
                DomainId = domain.Id,
                UserId = user.Id,
                Address = address,
                LocalPart = localPart,
                Type = "user",
                // Same password to start with, so the person has one thing to
                // remember on day one. It diverges the moment either is reset,
                // which is the point of keeping them in separate columns.
                ImapPasswordHash = hasher.Hash(password),
                QuotaBytes = quota,
            };
            db.Mailboxes.Add(mailbox);
        }

        // Default folders are created by the trg_mail_default_folders trigger,
        // not here. One implementation covers the API, the seed and anything
        // that inserts a mailbox later; two would drift.
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("user.created", "user", user.Id.ToString(),
            after: new { user.Email, products, category = category?.Name }, ct: ct);

        // The generated password is returned once and never stored in
        // recoverable form. Losing it means a reset, which is the correct
        // trade — a retrievable password is a stored plaintext password.
        return Results.Created($"/api/org/users/{user.Id}", new
        {
            user.Id,
            user.Email,
            mailboxAddress = mailbox?.Address,
            quotaBytes = mailbox?.QuotaBytes,
            products,
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
        var capacity = await storage.GetCapacityAsync(tenant.TenantId, "mail", ct);
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

        var category = req.CategoryId is Guid cid
            ? await db.UserCategories.FirstOrDefaultAsync(c => c.Id == cid, ct)
            : null;

        var products = category?.DefaultProducts ?? ["mail"];
        var wantsMailbox = products.Contains("mail");
        var quota = await storage.ResolveQuotaAsync(
            tenant.TenantId, req.CategoryId, null, "mail", ct);

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

            if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == address, ct) ||
                await db.Mailboxes.IgnoreQueryFilters().AnyAsync(m => m.Address == address, ct))
            {
                skipped.Add(new { address, reason = "already exists" });
                continue;
            }

            var password = PasswordGenerator.Generate();

            var user = new User
            {
                TenantId = tenant.TenantId,
                DomainId = domain.Id,
                Email = address,
                DisplayName = entry.DisplayName.Trim(),
                CategoryId = category?.Id,
                Role = category?.DefaultRole ?? "employee",
                Status = "pending",
                PasswordHash = hasher.Hash(password),
            };
            db.Users.Add(user);

            foreach (var code in products.Distinct())
                db.ProductAccess.Add(new ProductAccess
                {
                    TenantId = tenant.TenantId,
                    UserId = user.Id,
                    ProductCode = code,
                });

            if (wantsMailbox)
                db.Mailboxes.Add(new Mailbox
                {
                    TenantId = tenant.TenantId,
                    DomainId = domain.Id,
                    UserId = user.Id,
                    Address = address,
                    LocalPart = localPart,
                    Type = "user",
                    ImapPasswordHash = hasher.Hash(password),
                    QuotaBytes = quota,
                });

            created.Add(new { email = address, temporaryPassword = password });
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.bulk_created", "user", null,
            after: new { count = created.Count, skipped = skipped.Count }, ct: ct);

        return Results.Ok(new { created, skipped });
    }

    /// <summary>
    /// Suspend a person — every product at once.
    ///
    /// This is the payoff for putting identity in Core. One action stops them
    /// signing in, stops IMAP, and stops Drive and Payroll the day those ship.
    /// The mailbox is deactivated but NOT deleted: mail addressed to it is
    /// rejected at SMTP time so the sender knows immediately, while the stored
    /// mail is retained for whatever legal window applies.
    /// </summary>
    private static async Task<IResult> SuspendAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        user.Status = "suspended";

        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        foreach (var mb in mailboxes) mb.IsActive = false;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.suspended", "user", id.ToString(),
            after: new { mailboxesDeactivated = mailboxes.Count }, ct: ct);

        return Results.Ok(new { user.Id, user.Status, mailboxesDeactivated = mailboxes.Count });
    }

    private static async Task<IResult> ReactivateAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        user.Status = "active";
        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        foreach (var mb in mailboxes) mb.IsActive = true;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.reactivated", "user", id.ToString(), ct: ct);

        return Results.Ok(new { user.Id, user.Status });
    }

    /// <summary>
    /// Resets the CORE password — the one sign-in that covers every product.
    ///
    /// Deliberately does not touch the mailbox app password. Those are separate
    /// credentials so that revoking a mail client does not lock someone out of
    /// Payroll, and the reverse. Use reset-app-password for that.
    /// </summary>
    private static async Task<IResult> ResetPasswordAsync(
        Guid id, AppDbContext db, AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Results.NotFound();

        var password = PasswordGenerator.Generate();
        user.PasswordHash = hasher.Hash(password);
        await db.SaveChangesAsync(ct);

        // Audited because it is a common step in an account takeover. The
        // record is what makes that detectable afterwards.
        await audit.WriteAsync("user.password_reset", "user", id.ToString(), ct: ct);

        return Results.Ok(new { user.Id, temporaryPassword = password });
    }

    private static async Task<IResult> ResetAppPasswordAsync(
        Guid id, AppDbContext db, AuditWriter audit, IPasswordHasher hasher, CancellationToken ct)
    {
        var mailboxes = await db.Mailboxes.Where(m => m.UserId == id).ToListAsync(ct);
        if (mailboxes.Count == 0) return Results.NotFound(new { error = "No mailbox for this user." });

        var password = PasswordGenerator.Generate();
        foreach (var mb in mailboxes) mb.ImapPasswordHash = hasher.Hash(password);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("mailbox.app_password_reset", "user", id.ToString(), ct: ct);

        return Results.Ok(new
        {
            userId = id,
            temporaryPassword = password,
            note = "Existing mail clients will stop working until reconfigured.",
        });
    }

    private static async Task<IResult> ListCategoriesAsync(AppDbContext db, CancellationToken ct)
    {
        var cats = await db.UserCategories.AsNoTracking()
            .OrderBy(c => c.Name)
            .Select(c => new
            {
                c.Id, c.Name, c.Description, c.DefaultQuotaBytes,
                c.DefaultRole, c.DefaultProducts, c.CanSendExternal,
                c.AutoGroups, c.Colour,
                UserCount = db.Users.Count(u => u.CategoryId == c.Id),
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

        var known = await db.Products.Select(p => p.Code).ToListAsync(ct);
        var products = req.DefaultProducts ?? ["mail"];
        var unknown = products.Except(known).ToArray();
        if (unknown.Length > 0)
            return Results.BadRequest(new { error = $"Unknown product(s): {string.Join(", ", unknown)}" });

        var cat = new UserCategory
        {
            TenantId = tenant.TenantId,
            Name = req.Name.Trim(),
            Description = req.Description,
            DefaultQuotaBytes = req.DefaultQuotaBytes,
            DefaultRole = req.DefaultRole,
            DefaultProducts = products,
            CanSendExternal = req.CanSendExternal,
            AutoGroups = req.AutoGroups ?? [],
            Colour = req.Colour ?? "#3563f0",
        };

        db.UserCategories.Add(cat);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("category.created", "category", cat.Id.ToString(),
            after: new { cat.Name, cat.DefaultQuotaBytes, cat.DefaultProducts }, ct: ct);

        return Results.Created($"/api/org/categories/{cat.Id}", cat);
    }

    // ------------------------------------------------------------------

    private static bool IsValidLocalPart(string local) =>
        local.Length is > 0 and <= 64 &&
        System.Text.RegularExpressions.Regex.IsMatch(local, @"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$");
}

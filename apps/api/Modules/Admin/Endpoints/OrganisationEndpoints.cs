using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Platform administration — onboarding and managing organisations.
///
/// Every route here requires the super_admin role and runs in platform scope.
/// Note what platform scope does NOT do: it does not disable row-level
/// security. It sets the tenant for one operation at a time, so even an
/// operator listing every organisation reads them one tenant at a time.
/// There is deliberately no "see everything" mode, because a bug in one would
/// be unbounded.
/// </summary>
public static class OrganisationEndpoints
{
    public static void MapOrganisationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/admin/organisations")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");

        // The sales queue. Not a report — a work list.
        g.MapGet("/drafts", DraftsAsync);
        g.MapGet("/", ListAsync);
        g.MapGet("/{id:guid}", GetAsync);
        g.MapPost("/", CreateAsync);
        g.MapPost("/{id:guid}/suspend", SuspendAsync);
        g.MapPost("/{id:guid}/activate", ActivateAsync);
    }

    /// <summary>
    /// Signups that started and did not finish.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    ///  This endpoint is the reason gating access on domain verification is
    ///  acceptable. Requiring DNS before console access genuinely loses
    ///  customers — the office manager trialling this at a school often cannot
    ///  reach whoever manages their DNS. What makes it survivable is that they
    ///  are captured with a phone number and called.
    ///
    ///  If nobody works this queue, the design is strictly worse than letting
    ///  people straight in on a free subdomain.
    /// ─────────────────────────────────────────────────────────────────────
    ///
    /// Not tenant-scoped, because a draft has no tenant — that is the point.
    /// SuperAdmin only.
    /// </summary>
    private static async Task<IResult> DraftsAsync(AppDbContext db, CancellationToken ct)
    {
        var drafts = await db.SignupDrafts.AsNoTracking()
            .Where(d => d.CompletedAt == null)
            // Furthest-along first. Someone who reached verification and failed
            // is a call worth making today; someone who typed a name and left
            // is not, and sorting purely by date buries the former under the
            // latter.
            .OrderByDescending(d => d.ReachedStep)
            .ThenByDescending(d => d.UpdatedAt)
            .Select(d => new
            {
                d.Id, d.OrgName, d.OrgType, d.Country,
                d.AdminName, d.AdminEmail, d.AdminPhone,
                d.Fqdn, d.VerificationMethod, d.Attempts,
                d.ReachedStep, d.LastAttemptError, d.LastAttemptAt,
                d.CreatedAt, d.UpdatedAt,
                // Pre-computed so the screen does not re-derive the one thing
                // that decides whether to pick up the phone.
                stalledAtVerification = d.ReachedStep == 4 && d.Attempts > 0,
                resumeUrl = "/signup?draft=" + d.Id,
            })
            .ToListAsync(ct);

        var converted = await db.SignupDrafts.CountAsync(d => d.CompletedAt != null, ct);

        return Results.Ok(new
        {
            drafts,
            // Conversion, stated plainly. A queue with no denominator is a queue
            // nobody can tell is getting better or worse.
            funnel = new
            {
                open = drafts.Count,
                converted,
                stalledAtVerification = drafts.Count(d => d.stalledAtVerification),
            },
        });
    }

    private static async Task<IResult> ListAsync(
        AppDbContext db, StorageAllocator storage, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        // Tenants itself carries no RLS policy — it IS the boundary — so this
        // listing is safe. Everything hanging off it is read per tenant below.
        var orgs = await db.Tenants.AsNoTracking()
            .OrderByDescending(t => t.CreatedAt)
            .ToListAsync(ct);

        var actor = CurrentUserId(http);
        var results = new List<OrganisationResponse>(orgs.Count);

        foreach (var org in orgs)
        {
            // Scope to each organisation in turn. The alternative — one query
            // with RLS off — is exactly the unbounded read this design avoids.
            tenant.EnterPlatformScope(org.Id, actor);
            await db.SyncTenantAsync(ct);

            var cap = await storage.GetCapacityAsync(org.Id, "mail", ct);
            var domain = await db.Domains.AsNoTracking()
                .Where(d => d.Type == "primary")
                .Select(d => d.Fqdn)
                .FirstOrDefaultAsync(ct);
            var domainCount = await db.Domains.CountAsync(ct);

            results.Add(new OrganisationResponse(
                org.Id, org.Name, org.Type, org.Status,
                domain ?? "—", cap.StorageModel, cap.MaxUsers,
                cap.UserCount, cap.TotalBytes, cap.UsedBytes,
                domainCount, org.AdminEmail, org.CreatedAt, org.TrialEndsAt));
        }

        return Results.Ok(results);
    }

    private static async Task<IResult> GetAsync(
        Guid id, AppDbContext db, StorageAllocator storage, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        var cap = await storage.GetCapacityAsync(org.Id, "mail", ct);
        var domain = await db.Domains.AsNoTracking()
            .Where(d => d.Type == "primary").Select(d => d.Fqdn).FirstOrDefaultAsync(ct);

        return Results.Ok(new OrganisationResponse(
            org.Id, org.Name, org.Type, org.Status, domain ?? "—",
            cap.StorageModel, cap.MaxUsers, cap.UserCount,
            cap.TotalBytes, cap.UsedBytes,
            await db.Domains.CountAsync(ct), org.AdminEmail, org.CreatedAt, org.TrialEndsAt));
    }

    /// <summary>
    /// Onboard an organisation.
    ///
    /// The organisation is created in <c>pending</c> and stays there until the
    /// domain's ownership is proven by DNS. Nothing is delivered for an
    /// unverified domain, and no user can send as it. That single rule is what
    /// stops anyone claiming a domain they do not control — and it is the
    /// answer we give providers who ask how abuse is prevented.
    /// </summary>
    private static async Task<IResult> CreateAsync(
        CreateOrganisationRequest req,
        AppDbContext db, TenantContext tenant, AuditWriter audit,
        IConfiguration config, HttpContext http, CancellationToken ct)
    {
        var fqdn = req.PrimaryDomain.Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.BadRequest(new { error = "Organisation name is required." });

        if (!IsPlausibleDomain(fqdn))
            return Results.BadRequest(new { error = "Primary domain is not a valid domain name." });

        if (req.StorageModel is not ("per_user" or "pooled"))
            return Results.BadRequest(new { error = "StorageModel must be 'per_user' or 'pooled'." });

        // Domains are unique platform-wide. Whoever verifies ownership first
        // holds it — checked here for a clear error, and enforced by a unique
        // index so a race cannot slip through.
        if (await db.Domains.IgnoreQueryFilters().AnyAsync(d => d.Fqdn == fqdn, ct))
            return Results.Conflict(new { error = $"The domain {fqdn} is already registered on this platform." });

        if (!await db.Plans.AnyAsync(p => p.Id == req.PlanId, ct))
            return Results.BadRequest(new { error = "Unknown plan." });

        // The tenant row is now identity and contact details only. Commercial
        // terms live in core.subscriptions and core.storage_pools, because they
        // change on a different schedule and for different reasons — an upgrade
        // should not be an UPDATE on the organisation's name row.
        var org = new Tenant
        {
            Name = req.Name.Trim(),
            Type = req.Type,
            Status = "pending",
            AdminName = req.AdminName,
            AdminEmail = req.AdminEmail,
            Phone = req.Phone,
            Country = req.Country,
            Gstin = req.Gstin,
            TrialEndsAt = DateTimeOffset.UtcNow.AddDays(30),
        };

        db.Tenants.Add(org);
        await db.SaveChangesAsync(ct);

        // From here on, act inside the new organisation. SyncTenantAsync
        // pushes the switch down to the database session; without it a write
        // to an RLS-forced table below would still be under the old tenant.
        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        db.Subscriptions.Add(new Subscription
        {
            TenantId = org.Id,
            PlanId = req.PlanId,
            Status = "trial",
            Seats = req.MaxUsers ?? 0,
            RenewsAt = DateTimeOffset.UtcNow.AddDays(30),
        });

        db.StoragePools.Add(new StoragePool
        {
            TenantId = org.Id,
            StorageModel = req.StorageModel,
            TotalBytes = req.StorageModel == "pooled" ? req.PooledStorageBytes ?? 0 : 0,
            PerUserQuotaBytes = req.StorageModel == "per_user" ? req.PerUserQuotaBytes : null,
        });

        // Mail gets an allocation from the start; other products are added when
        // the customer turns them on. A NULL allocation means "whatever is
        // left", so Mail under a pooled plan is not capped before Drive exists.
        db.StorageAllocations.Add(new StorageAllocation
        {
            TenantId = org.Id,
            ProductCode = "mail",
            AllocatedBytes = null,
        });

        // ------------------------------------------------------------------
        //  A working address, immediately.
        //
        //  The organisation gets a subdomain of one WE own, active from the
        //  moment it is created because we control the parent zone. They can
        //  sign in, create people and send mail this afternoon.
        //
        //  Requiring DNS verification before first login is how onboarding
        //  stalls for a week: the person evaluating the product is almost
        //  never the person who can edit DNS. Their own domain is added and
        //  verified later, from their own console, with their existing mail
        //  untouched until they choose to move it.
        // ------------------------------------------------------------------
        var platformFqdn = await AllocateSubdomainAsync(db, config, req.Name, ct);

        db.Domains.Add(new Domain
        {
            TenantId = org.Id,
            Fqdn = platformFqdn,
            Type = "primary",
            IsActive = true,
            IsPlatform = true,
            OwnershipVerifiedAt = DateTimeOffset.UtcNow,
            MxVerifiedAt = DateTimeOffset.UtcNow,
            DkimSelector = $"tv{DateTime.UtcNow:yyyy}a",
        });

        // Their own domain — added now so the record exists, but inactive
        // until they prove ownership.
        var domain = new Domain
        {
            TenantId = org.Id,
            Fqdn = fqdn,
            Type = "alias",
            IsActive = false,
            VerificationToken = GenerateVerificationToken(),
            DkimSelector = $"tv{DateTime.UtcNow:yyyy}a",
        };
        db.Domains.Add(domain);

        // Sensible starting categories by organisation type. An admin facing
        // an empty screen has to invent structure before they can create a
        // single user; these give them something to edit instead.
        foreach (var c in DefaultCategories(req.Type, org.Id))
            db.UserCategories.Add(c);

        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("organisation.created", "tenant", org.Id.ToString(),
            after: new { org.Name, org.Type, storageModel = req.StorageModel, domain = fqdn }, ct: ct);

        return Results.Created($"/api/admin/organisations/{org.Id}", new
        {
            org.Id,
            org.Name,
            org.Status,

            // The address they can use today.
            signInDomain = platformFqdn,
            note = $"They can sign in immediately on {platformFqdn} and start creating people. " +
                   $"No DNS changes are needed for that.",

            // The one they will move to, when they are ready.
            ownDomain = new
            {
                fqdn,
                active = false,
                verification = new
                {
                    type = "TXT",
                    host = "@",
                    value = $"tatvaos-verification={domain.VerificationToken}",
                    note = "Publish this on their own domain, then verify it from their console. " +
                           "Their existing mail is unaffected until they move the MX record.",
                },
            },
        });
    }

    private static async Task<IResult> SuspendAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var before = new { org.Status };
        org.Status = "suspended";
        org.SuspendedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);
        await audit.WriteAsync("organisation.suspended", "tenant", org.Id.ToString(),
            before, new { org.Status }, ct);

        // Suspension stops authentication and delivery immediately, but does
        // not delete anything. Data removal is a separate, deliberate action
        // after the grace period — see the billing policy.
        return Results.Ok(new { org.Id, org.Status });
    }

    private static async Task<IResult> ActivateAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var before = new { org.Status };
        org.Status = "active";
        org.SuspendedAt = null;
        await db.SaveChangesAsync(ct);

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);
        await audit.WriteAsync("organisation.activated", "tenant", org.Id.ToString(),
            before, new { org.Status }, ct);

        return Results.Ok(new { org.Id, org.Status });
    }

    // ------------------------------------------------------------------

    private static Guid CurrentUserId(HttpContext http) =>
        Guid.TryParse(http.User.FindFirst("sub")?.Value, out var id) ? id : Guid.Empty;

    /// <summary>
    /// Turns "ABC School & Co." into abcschool.tatvaos.com, adding a numeric
    /// suffix if that is taken.
    ///
    /// Derived from the name rather than random, because the customer has to
    /// read this address aloud to their staff on day one. "abcschool" is
    /// memorable; "t-7f3a9c" is a support call.
    /// </summary>
    private static async Task<string> AllocateSubdomainAsync(
        AppDbContext db, IConfiguration config, string name, CancellationToken ct)
    {
        // Configured, not hardcoded. The platform zone is an infrastructure
        // decision that has already changed once; baking it into a string
        // literal here means it changes in two places next time.
        var zone = config["Mail:PlatformZone"] ?? "trineetra.com";

        var slug = System.Text.RegularExpressions.Regex
            .Replace(name.ToLowerInvariant(), @"[^a-z0-9]+", "")
            .Trim();

        if (slug.Length < 3) slug = $"org{slug}";
        if (slug.Length > 30) slug = slug[..30];

        // Reserved names would collide with our own hosts. A customer called
        // "Mail Systems Ltd" must not be handed mail.tatvaos.com.
        string[] reserved = ["mail", "www", "api", "app", "admin", "staging", "smtp", "imap", "mx", "ns"];
        if (reserved.Contains(slug)) slug = $"{slug}org";

        var candidate = $"{slug}.{zone}";
        var n = 1;
        while (await db.Domains.IgnoreQueryFilters().AnyAsync(d => d.Fqdn == candidate, ct))
        {
            n++;
            candidate = $"{slug}{n}.{zone}";
        }

        return candidate;
    }

    private static string GenerateVerificationToken() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    private static bool IsPlausibleDomain(string fqdn) =>
        System.Text.RegularExpressions.Regex.IsMatch(
            fqdn, @"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$")
        && fqdn.Length <= 253;

    private static IEnumerable<UserCategory> DefaultCategories(string orgType, Guid tenantId)
    {
        const long GB = 1024L * 1024 * 1024;

        // Products are listed per category rather than per organisation because
        // that is where the difference actually falls: a school buys Drive for
        // its staff and not for its 400 students.
        string[] mail = ["mail"];

        (string Name, long Quota, string Role, bool External, string Colour, string[] Products)[] defs
            = orgType switch
        {
            "school" =>
            [
                ("Leadership",     50 * GB, "org_admin", true,  "#ea580c", mail),
                ("Teachers",       15 * GB, "employee",  true,  "#3563f0", mail),
                ("Administration", 20 * GB, "manager",   true,  "#a855f7", mail),
                // Students blocked from external send by default. A school
                // requirement, and one of the strongest abuse controls we have.
                ("Students",        2 * GB, "employee",  false, "#16a34a", mail),
            ],
            "hospital" =>
            [
                ("Doctors",        30 * GB, "employee", true,  "#3563f0", mail),
                ("Nursing",        15 * GB, "employee", true,  "#16a34a", mail),
                ("Reception",      10 * GB, "employee", true,  "#a855f7", mail),
                ("Administration", 30 * GB, "manager",  true,  "#ea580c", mail),
            ],
            _ =>
            [
                ("Leadership",  50 * GB, "org_admin", true, "#ea580c", mail),
                ("Staff",       30 * GB, "employee",  true, "#3563f0", mail),
                ("Contractors",  5 * GB, "employee",  true, "#a855f7", mail),
            ],
        };

        return defs.Select(d => new UserCategory
        {
            TenantId = tenantId,
            Name = d.Name,
            DefaultQuotaBytes = d.Quota,
            DefaultRole = d.Role,
            DefaultProducts = d.Products,
            CanSendExternal = d.External,
            Colour = d.Colour,
        });
    }
}

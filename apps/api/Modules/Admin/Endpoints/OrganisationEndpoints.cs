using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;
using TatvaOS.Api.Modules.Core;

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
        g.MapPut("/{id:guid}/plan", ChangePlanAsync);
        g.MapPut("/{id:guid}", UpdateAsync);

        // Plans are platform-wide reference data, not tenant data — no RLS,
        // no scope switch, just the catalogue the change-plan dialog offers.
        var plans = app.MapGroup("/api/admin/plans")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        plans.MapGet("/", PlansAsync);
        plans.MapPost("/", CreatePlanAsync);
        plans.MapPut("/{id:guid}", UpdatePlanAsync);
        plans.MapDelete("/{id:guid}", DeletePlanAsync);

        // The product catalogue, served rather than copied. The plans screen
        // kept its own list of what a plan may grant and drifted from
        // core.products twice: once offering people/payroll/sheet/word after
        // 0028 deleted them, once omitting Connect entirely — which is why
        // Connect could not be granted from the console by anyone, on any
        // plan. A list that must match a table, with nothing checking that it
        // does, drifts again. Read-only on purpose: the catalogue is changed
        // by a migration, not by an operator.
        var products = app.MapGroup("/api/admin/products")
            .RequireAuthorization("SuperAdmin")
            .WithTags("Platform administration");
        products.MapGet("/", ProductsAsync);
    }

    private static async Task<IResult> ProductsAsync(AppDbContext db, CancellationToken ct)
    {
        // No tenant filter and no scope switch: core.products is platform-wide
        // reference data, exactly like core.plans above it.
        var products = await db.Products.AsNoTracking()
            .OrderBy(p => p.SortOrder).ThenBy(p => p.Code)
            .Select(p => new { p.Code, p.Name, p.Description, p.IsAvailable, p.SortOrder })
            .ToListAsync(ct);
        return Results.Ok(products);
    }

    private static async Task<IResult> PlansAsync(AppDbContext db, CancellationToken ct)
    {
        var plans = await db.Plans.AsNoTracking()
            .OrderBy(p => p.PricePerUserMonthly ?? p.PriceMonthly ?? 0)
            .Select(p => new
            {
                p.Id, p.Name, p.MaxUsers, p.StorageModel,
                p.PerUserQuotaBytes, p.PooledStorageBytes, p.MaxDomains,
                p.IncludedProducts, p.PricePerUserMonthly, p.PriceMonthly,
            })
            .ToListAsync(ct);
        return Results.Ok(plans);
    }

    private static string? ValidatePlan(UpsertPlanRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name)) return "Plan name is required.";
        if (req.StorageModel is not ("per_user" or "pooled"))
            return "Storage model must be 'per_user' or 'pooled'.";
        if (req.StorageModel == "per_user" && req.PerUserQuotaBytes is null or <= 0)
            return "A per-user plan needs a per-user storage quota.";
        if (req.StorageModel == "pooled" && req.PooledStorageBytes is null or <= 0)
            return "A pooled plan needs a pool size.";
        return null;
    }

    private static async Task<IResult> CreatePlanAsync(
        UpsertPlanRequest req, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        if (ValidatePlan(req) is string err) return Results.BadRequest(new { error = err });

        var plan = new Plan
        {
            Name = req.Name.Trim(),
            MaxUsers = req.MaxUsers,
            StorageModel = req.StorageModel,
            PerUserQuotaBytes = req.StorageModel == "per_user" ? req.PerUserQuotaBytes : null,
            PooledStorageBytes = req.StorageModel == "pooled" ? req.PooledStorageBytes : null,
            MaxDomains = req.MaxDomains,
            IncludedProducts = req.IncludedProducts ?? ["mail"],
            PricePerUserMonthly = req.PricePerUserMonthly,
            PriceMonthly = req.PriceMonthly,
        };
        db.Plans.Add(plan);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("plan.created", "plan", plan.Id.ToString(),
            after: new { plan.Name, plan.StorageModel }, ct: ct);
        return Results.Created($"/api/admin/plans/{plan.Id}", new { plan.Id, plan.Name });
    }

    private static async Task<IResult> UpdatePlanAsync(
        Guid id, UpsertPlanRequest req, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var plan = await db.Plans.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (plan is null) return Results.NotFound();
        if (ValidatePlan(req) is string err) return Results.BadRequest(new { error = err });

        var before = new { plan.Name, plan.MaxUsers, plan.PricePerUserMonthly, plan.PriceMonthly };

        // Editing a plan changes it for GROWTH — the seat/domain/quota limits it
        // imposes on new users and domains. It does NOT retroactively resize the
        // storage pools of organisations already on the plan; that stays a
        // deliberate per-organisation action, same as changing a plan.
        plan.Name = req.Name.Trim();
        plan.MaxUsers = req.MaxUsers;
        plan.StorageModel = req.StorageModel;
        plan.PerUserQuotaBytes = req.StorageModel == "per_user" ? req.PerUserQuotaBytes : null;
        plan.PooledStorageBytes = req.StorageModel == "pooled" ? req.PooledStorageBytes : null;
        plan.MaxDomains = req.MaxDomains;
        if (req.IncludedProducts is not null) plan.IncludedProducts = req.IncludedProducts;
        plan.PricePerUserMonthly = req.PricePerUserMonthly;
        plan.PriceMonthly = req.PriceMonthly;

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("plan.updated", "plan", id.ToString(),
            before: before, after: new { plan.Name, plan.MaxUsers }, ct: ct);
        return Results.Ok(new { plan.Id, plan.Name });
    }

    private static async Task<IResult> DeletePlanAsync(
        Guid id, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var plan = await db.Plans.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (plan is null) return Results.NotFound();

        // Refuse to delete a plan any organisation is on — that would orphan
        // their subscription's foreign key. The operator moves them first.
        var inUse = await db.Subscriptions.IgnoreQueryFilters().AnyAsync(s => s.PlanId == id, ct);
        if (inUse)
            return Results.BadRequest(new
            {
                error = "This plan is assigned to one or more organisations. "
                      + "Move them to another plan before deleting it.",
            });

        db.Plans.Remove(plan);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("plan.deleted", "plan", id.ToString(),
            before: new { plan.Name }, ct: ct);
        return Results.Ok(new { deleted = true });
    }

    /// <summary>
    /// Move an organisation to a different plan.
    ///
    /// Changes the subscription row only. Deliberately does NOT touch the
    /// storage pool or per-user quotas: shrinking storage under a live
    /// organisation is a destructive act that deserves its own screen with its
    /// own warnings, not a side effect of a dropdown. The new plan's limits
    /// apply to growth (new users, new domains) immediately.
    /// </summary>
    private static async Task<IResult> ChangePlanAsync(
        Guid id, ChangePlanRequest req,
        AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var plan = await db.Plans.AsNoTracking().FirstOrDefaultAsync(p => p.Id == req.PlanId, ct);
        if (plan is null) return Results.BadRequest(new { error = "Unknown plan." });

        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);

        var sub = await db.Subscriptions.OrderByDescending(s => s.StartedAt).FirstOrDefaultAsync(ct);
        object before;
        if (sub is null)
        {
            // Early manually-created organisations have no subscription row.
            // Creating one here makes the dropdown work for them too instead
            // of telling the operator to go run SQL.
            before = new { planId = (Guid?)null };
            sub = new Subscription
            {
                TenantId = org.Id,
                PlanId = plan.Id,
                Status = org.Status == "active" ? "active" : "trial",
                Seats = req.Seats ?? plan.MaxUsers ?? 0,
                RenewsAt = DateTimeOffset.UtcNow.AddDays(30),
            };
            db.Subscriptions.Add(sub);
        }
        else
        {
            before = new { planId = sub.PlanId, sub.Seats };
            sub.PlanId = plan.Id;
            if (req.Seats is int seats && seats > 0) sub.Seats = seats;
        }

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("organisation.plan_changed", "tenant", org.Id.ToString(),
            before, new { planId = plan.Id, planName = plan.Name, sub.Seats }, ct);

        return Results.Ok(new { org.Id, planId = plan.Id, planName = plan.Name, sub.Seats, sub.Status });
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
                // that decides whether to pick up the phone. Step 3 is now
                // contact verification — reaching it and burning attempts
                // means the codes are not arriving, which is exactly a call.
                stalledAtVerification = d.ReachedStep >= 3 && d.CodeAttempts > 0,
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

        // One read of the whole catalogue up front — plans carry no RLS, and
        // resolving a name per organisation would be a query per row.
        var planNames = await db.Plans.AsNoTracking()
            .ToDictionaryAsync(p => p.Id, p => p.Name, ct);

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
            var sub = await db.Subscriptions.AsNoTracking()
                .OrderByDescending(s => s.StartedAt)
                .Select(s => new { s.PlanId, s.Status, s.Seats })
                .FirstOrDefaultAsync(ct);

            results.Add(new OrganisationResponse(
                org.Id, org.Name, org.Type, org.Status,
                domain ?? "—", cap.StorageModel, cap.MaxUsers,
                cap.UserCount, cap.TotalBytes, cap.UsedBytes,
                domainCount, org.AdminEmail, org.CreatedAt, org.TrialEndsAt,
                sub?.PlanId,
                sub is null ? null : planNames.GetValueOrDefault(sub.PlanId),
                sub?.Status, sub?.Seats,
                org.AdminName, org.Phone, org.Gstin));
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
        var sub = await db.Subscriptions.AsNoTracking()
            .OrderByDescending(s => s.StartedAt)
            .Select(s => new { s.PlanId, s.Status, s.Seats, PlanName = s.Plan!.Name })
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new OrganisationResponse(
            org.Id, org.Name, org.Type, org.Status, domain ?? "—",
            cap.StorageModel, cap.MaxUsers, cap.UserCount,
            cap.TotalBytes, cap.UsedBytes,
            await db.Domains.CountAsync(ct), org.AdminEmail, org.CreatedAt, org.TrialEndsAt,
            sub?.PlanId, sub?.PlanName, sub?.Status, sub?.Seats,
            org.AdminName, org.Phone, org.Gstin));
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

        // The bounce subdomain must never become a domain row - see
        // ReservedDomains for why a row here would silently stop bounce intake.
        if (ReservedDomains.IsBounceDomain(config, fqdn))
            return Results.BadRequest(new { error = ReservedDomains.Refusal(config) });

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
            db.Departments.Add(c);

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

    /// <summary>
    /// Edit an organisation's identity and owner contact.
    ///
    /// The tenant row is name-and-contact only; commercial terms live in the
    /// subscription and are changed through /plan. Renaming here does NOT touch
    /// the primary domain or any user — a company changing its display name is
    /// not the same as changing where its mail is delivered.
    /// </summary>
    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateOrganisationRequest req,
        AppDbContext db, TenantContext tenant, AuditWriter audit,
        HttpContext http, CancellationToken ct)
    {
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (org is null) return Results.NotFound();

        var before = new { org.Name, org.Type, org.AdminName, org.AdminEmail, org.Phone, org.Gstin };

        if (!string.IsNullOrWhiteSpace(req.Name)) org.Name = req.Name.Trim();
        if (!string.IsNullOrWhiteSpace(req.Type))
        {
            var type = req.Type.Trim().ToLowerInvariant();
            string[] allowed = ["business", "school", "hospital", "nonprofit", "government", "other"];
            if (!allowed.Contains(type))
                return Results.BadRequest(new { error = "Unknown organisation type." });
            org.Type = type;
        }
        if (req.AdminName is not null) org.AdminName = req.AdminName.Trim();
        if (req.AdminEmail is not null)
        {
            var email = req.AdminEmail.Trim();
            if (email.Length > 0 && !email.Contains('@'))
                return Results.BadRequest(new { error = "That does not look like an email address." });
            org.AdminEmail = email.Length == 0 ? null : email;
        }
        if (req.Phone is not null) org.Phone = req.Phone.Trim();
        if (req.Gstin is not null) org.Gstin = req.Gstin.Trim();

        await db.SaveChangesAsync(ct);
        tenant.EnterPlatformScope(org.Id, CurrentUserId(http));
        await db.SyncTenantAsync(ct);
        await audit.WriteAsync("organisation.updated", "tenant", org.Id.ToString(),
            before, new { org.Name, org.Type, org.AdminName, org.AdminEmail, org.Phone, org.Gstin }, ct);

        return Results.Ok(new { org.Id, org.Name, org.Type, org.AdminName, org.AdminEmail });
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
        // Taken, or reserved: the bounce subdomain must never be allocated
        // (see ReservedDomains). "Bounces Pvt Ltd" gets bounces2.<zone>.
        while (ReservedDomains.IsBounceDomain(config, candidate)
               || await db.Domains.IgnoreQueryFilters().AnyAsync(d => d.Fqdn == candidate, ct))
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

    private static IEnumerable<Department> DefaultCategories(string orgType, Guid tenantId)
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

        return defs.Select(d => new Department
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

using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Core.Endpoints;

/// <summary>
/// Self-service signup.
///
/// ─────────────────────────────────────────────────────────────────────────
///  NO TENANT EXISTS UNTIL VERIFICATION PASSES.
///
///  Everything lives in a draft until then. Creating the tenant up front and
///  flagging it incomplete produces organisation rows with no verified domain
///  and no owner who can sign in — indistinguishable from real customers in
///  every count and report anyone will ever run.
///
///  A draft that never converts is not waste. It is a lead: somebody typed
///  their organisation's name, their own name and their phone number because
///  they wanted this, then hit a step needing DNS access they may not have.
///  Techvein calls them.
/// ─────────────────────────────────────────────────────────────────────────
///
/// These endpoints are anonymous. Access is by a 128-bit draft id from a
/// resume link, which cannot be guessed or enumerated.
/// </summary>
public static class SignupEndpoints
{
    public static void MapSignupEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/signup").WithTags("Signup").AllowAnonymous();

        g.MapPost("/", StartAsync);
        g.MapGet("/{id:guid}", ResumeAsync);
        g.MapPut("/{id:guid}", SaveAsync);
        g.MapGet("/{id:guid}/methods", MethodsAsync);
        g.MapPost("/{id:guid}/verify", VerifyAsync);
    }

    // ------------------------------------------------------------------
    /// <summary>Step 1 and 2 — organisation and administrator.</summary>
    private static async Task<IResult> StartAsync(
        StartSignupRequest req, AppDbContext db, CancellationToken ct)
    {
        var email = req.AdminEmail?.Trim().ToLowerInvariant() ?? "";

        if (string.IsNullOrWhiteSpace(req.OrgName) || req.OrgName.Trim().Length < 2)
            return Results.BadRequest(new { error = "An organisation name is required." });

        if (!Regex.IsMatch(email, @"^[^@\s]+@[^@\s]+\.[^@\s]+$"))
            return Results.BadRequest(new { error = "That does not look like an email address." });

        if (string.IsNullOrWhiteSpace(req.AdminName))
            return Results.BadRequest(new { error = "Your name is required." });

        // Already a customer? Say so plainly rather than creating a second
        // draft they will abandon when it collides at the domain step.
        if (await db.Users.IgnoreQueryFilters().AnyAsync(u => u.Email == email, ct))
            return Results.Conflict(new
            {
                error = "That email address already has an account. Sign in instead, or use " +
                        "the forgotten-password link.",
                signIn = true,
            });

        // Resume rather than duplicate. Someone retrying the form should land
        // back where they were, and a dozen rows per person makes the sales
        // queue useless.
        var existing = await db.SignupDrafts
            .FirstOrDefaultAsync(d => d.AdminEmail == email && d.CompletedAt == null, ct);

        if (existing is not null)
        {
            existing.OrgName = req.OrgName.Trim();
            existing.OrgType = req.OrgType ?? existing.OrgType;
            existing.Country = req.Country ?? existing.Country;
            existing.Gstin = req.Gstin;
            existing.AdminName = req.AdminName.Trim();
            existing.AdminPhone = req.AdminPhone;
            existing.UpdatedAt = DateTimeOffset.UtcNow;
            existing.ReachedStep = Math.Max(existing.ReachedStep, 3);
            await db.SaveChangesAsync(ct);

            return Results.Ok(Describe(existing, resumed: true));
        }

        var draft = new SignupDraft
        {
            OrgName = req.OrgName.Trim(),
            OrgType = req.OrgType ?? "business",
            Country = req.Country ?? "India",
            Gstin = req.Gstin,
            AdminName = req.AdminName.Trim(),
            AdminEmail = email,
            AdminPhone = req.AdminPhone,
            VerificationToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            ReachedStep = 3,
        };

        db.SignupDrafts.Add(draft);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/signup/{draft.Id}", Describe(draft, resumed: false));
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ResumeAsync(
        Guid id, AppDbContext db, CancellationToken ct)
    {
        var draft = await db.SignupDrafts.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id, ct);
        if (draft is null) return Results.NotFound();

        if (draft.CompletedAt is not null)
            return Results.Ok(new { completed = true, message = "This signup is already finished. Sign in." });

        return Results.Ok(Describe(draft, resumed: true));
    }

    // ------------------------------------------------------------------
    /// <summary>Step 3 — the domain, and which method they intend to use.</summary>
    private static async Task<IResult> SaveAsync(
        Guid id, SaveSignupRequest req, AppDbContext db, CancellationToken ct)
    {
        var draft = await db.SignupDrafts.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (draft is null) return Results.NotFound();
        if (draft.CompletedAt is not null) return Results.BadRequest(new { error = "Already finished." });

        var fqdn = req.Fqdn?.Trim().ToLowerInvariant().TrimEnd('.') ?? "";

        if (!IsPlausibleDomain(fqdn))
            return Results.BadRequest(new { error = "That does not look like a domain name." });

        // Claimed by a live tenant, or by someone else's open draft. Checking
        // drafts too stops two organisations racing to verify the same name and
        // one of them silently losing the work.
        if (await db.Domains.IgnoreQueryFilters().AnyAsync(d => d.Fqdn == fqdn, ct))
            return Results.Conflict(new
            {
                error = $"{fqdn} is already in use on TatvaOS. If your organisation owns it, " +
                        "contact us — we verify ownership before transferring a domain.",
            });

        if (await db.SignupDrafts.AnyAsync(d =>
                d.Fqdn == fqdn && d.CompletedAt == null && d.Id != id, ct))
            return Results.Conflict(new
            {
                error = $"Someone else is part-way through claiming {fqdn}. If that is your " +
                        "organisation, contact us.",
            });

        draft.Fqdn = fqdn;
        draft.VerificationMethod = req.Method;
        draft.ReachedStep = 4;
        draft.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(Describe(draft, resumed: false));
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> MethodsAsync(
        Guid id, AppDbContext db, SignupVerifier verifier, CancellationToken ct)
    {
        var draft = await db.SignupDrafts.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id, ct);
        if (draft is null) return Results.NotFound();
        if (string.IsNullOrWhiteSpace(draft.Fqdn))
            return Results.BadRequest(new { error = "Add a domain first." });

        return Results.Ok(new
        {
            draft.Fqdn,
            options = verifier.Instructions(draft.Fqdn, draft.VerificationToken),
            note = "Whichever you choose, this only proves you own the domain. It does not " +
                   "change your email — your existing mail keeps arriving exactly as it does now.",
        });
    }

    // ------------------------------------------------------------------
    /// <summary>Step 4 — check, and on success create the real account.</summary>
    private static async Task<IResult> VerifyAsync(
        Guid id, VerifySignupRequest req, AppDbContext db, SignupVerifier verifier,
        IPasswordHasher hasher, TenantContext tenant, IConfiguration config,
        CancellationToken ct)
    {
        var draft = await db.SignupDrafts.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (draft is null) return Results.NotFound();
        if (draft.CompletedAt is not null) return Results.BadRequest(new { error = "Already finished." });
        if (string.IsNullOrWhiteSpace(draft.Fqdn))
            return Results.BadRequest(new { error = "Add a domain first." });

        if (!Enum.TryParse<SignupVerifier.Method>(req.Method, true, out var method))
            return Results.BadRequest(new { error = "Unknown verification method." });

        if (string.IsNullOrEmpty(req.Password) || req.Password.Length < 12)
            return Results.BadRequest(new
            {
                error = "Choose a password of at least 12 characters. A short phrase you will " +
                        "remember beats a short password you will not.",
            });

        var outcome = await verifier.CheckAsync(method, draft.Fqdn, draft.VerificationToken, ct);

        draft.Attempts++;
        draft.LastAttemptAt = DateTimeOffset.UtcNow;
        draft.VerificationMethod = req.Method.ToLowerInvariant();
        draft.UpdatedAt = DateTimeOffset.UtcNow;

        if (!outcome.Verified)
        {
            draft.LastAttemptError = outcome.Detail;
            await db.SaveChangesAsync(ct);

            // Saved, not lost. This is the response the sales queue is built on.
            return Results.Ok(new
            {
                verified = false,
                detail = outcome.Detail,
                draftId = draft.Id,
                attempts = draft.Attempts,
                saved = true,
                message = "Nothing is lost — we have saved your details. Come back to this link " +
                          "once the record is live, or we will get in touch to help.",
            });
        }

        draft.LastAttemptError = null;

        // ---- Verified. Build the real thing. -----------------------------
        var org = new Tenant
        {
            Name = draft.OrgName,
            Type = draft.OrgType,
            // Trial, not pending. They have proven domain ownership, which is
            // more than most trials require — there is nothing further to wait
            // for before they can use the product.
            Status = "trial",
            Origin = "signup",
            AdminName = draft.AdminName,
            AdminEmail = draft.AdminEmail,
            Phone = draft.AdminPhone,
            Country = draft.Country,
            Gstin = draft.Gstin,
            TrialEndsAt = DateTimeOffset.UtcNow.AddDays(30),
        };
        db.Tenants.Add(org);
        await db.SaveChangesAsync(ct);

        tenant.EnterPlatformScope(org.Id, Guid.Empty);
        await db.SyncTenantAsync(ct);

        var domain = new Domain
        {
            TenantId = org.Id,
            Fqdn = draft.Fqdn,
            Type = "primary",
            // Active because ownership is proven. Mail still will not route
            // here until they add MX — a separate, later, reversible step.
            IsActive = true,
            OwnershipVerifiedAt = DateTimeOffset.UtcNow,
            VerificationToken = draft.VerificationToken,
            VerificationMethod = draft.VerificationMethod,
            DkimSelector = $"tv{DateTime.UtcNow:yyyy}a",
        };
        db.Domains.Add(domain);

        var owner = new User
        {
            TenantId = org.Id,
            DomainId = domain.Id,
            Email = draft.AdminEmail,
            DisplayName = draft.AdminName,
            Role = "org_owner",
            Status = "active",
            PasswordHash = hasher.Hash(req.Password),
            // They chose it themselves just now, so there is nothing to force
            // a change of — unlike an admin-generated temporary password.
            MustChangePassword = false,
        };
        db.Users.Add(owner);

        db.ProductAccess.Add(new ProductAccess
        {
            TenantId = org.Id, UserId = owner.Id, ProductCode = "mail",
        });

        db.StoragePools.Add(new StoragePool
        {
            TenantId = org.Id,
            StorageModel = "per_user",
            PerUserQuotaBytes = 15L * 1024 * 1024 * 1024,
        });

        db.StorageAllocations.Add(new StorageAllocation
        {
            TenantId = org.Id, ProductCode = "mail", AllocatedBytes = null,
        });

        foreach (var c in DefaultCategories(draft.OrgType, org.Id))
            db.UserCategories.Add(c);

        draft.CompletedAt = DateTimeOffset.UtcNow;
        draft.ConvertedTenantId = org.Id;

        await db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            verified = true,
            organisationId = org.Id,
            signInAt = config["App:AdminUrl"] ?? "https://admin.tatvaos.com",
            email = owner.Email,
            nextStep = new
            {
                title = "Set up email",
                detail = "Your account is ready. Email for your domain still goes wherever it " +
                         "does today — when you are ready to move it, the records to add are " +
                         "under Domains in your console.",
            },
        });
    }

    // ------------------------------------------------------------------

    private static object Describe(SignupDraft d, bool resumed) => new
    {
        draftId = d.Id,
        d.OrgName, d.OrgType, d.Country, d.Gstin,
        d.AdminName, d.AdminEmail, d.AdminPhone,
        d.Fqdn, d.VerificationMethod, d.VerificationToken,
        step = d.ReachedStep,
        d.Attempts,
        lastError = d.LastAttemptError,
        resumed,
        // The link that makes a failed verification recoverable. Emailed to
        // them, so a signup abandoned on Friday is resumable on Monday.
        resumeUrl = $"/signup?draft={d.Id}",
    };

    private static bool IsPlausibleDomain(string fqdn) =>
        fqdn.Length is > 3 and <= 253 &&
        Regex.IsMatch(fqdn, @"^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$");

    /// <summary>
    /// Starting categories by organisation type. An admin facing an empty
    /// screen has to invent structure before creating a single person; these
    /// give them something to edit instead.
    /// </summary>
    private static IEnumerable<UserCategory> DefaultCategories(string orgType, Guid tenantId)
    {
        const long GB = 1024L * 1024 * 1024;
        string[] mail = ["mail"];

        (string Name, long Quota, string Role, bool External)[] defs = orgType switch
        {
            "school" =>
            [
                ("Leadership", 50 * GB, "org_admin", true),
                ("Teachers", 15 * GB, "employee", true),
                ("Administration", 20 * GB, "manager", true),
                // Students blocked from external send by default — a school
                // requirement and one of the strongest abuse controls we have.
                ("Students", 2 * GB, "employee", false),
            ],
            "hospital" =>
            [
                ("Doctors", 30 * GB, "employee", true),
                ("Nursing", 15 * GB, "employee", true),
                ("Reception", 10 * GB, "employee", true),
                ("Administration", 30 * GB, "manager", true),
            ],
            _ =>
            [
                ("Leadership", 50 * GB, "org_admin", true),
                ("Staff", 30 * GB, "employee", true),
                ("Contractors", 5 * GB, "employee", true),
            ],
        };

        return defs.Select(d => new UserCategory
        {
            TenantId = tenantId,
            Name = d.Name,
            DefaultQuotaBytes = d.Quota,
            DefaultRole = d.Role,
            DefaultProducts = mail,
            CanSendExternal = d.External,
        });
    }
}

public sealed record StartSignupRequest(
    string? OrgName, string? OrgType, string? Country, string? Gstin,
    string? AdminName, string? AdminEmail, string? AdminPhone);

public sealed record SaveSignupRequest(string? Fqdn, string? Method);

public sealed record VerifySignupRequest(string Method, string Password);

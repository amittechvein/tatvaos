using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// The organisation API — a customer's own software acting on their own
/// organisation, authenticated by an organisation API key (Amit, 18 September
/// 2026). Admitting a person lives here; scheduling meetings lives in
/// OrgMeetingApiEndpoints, and both authenticate through OrgApiAuth so the
/// rules below hold once rather than per file.
///
/// THIS IS THE MOST CONSEQUENTIAL PUBLIC SURFACE IN THE PRODUCT. Everything
/// else a key can reach either sends something (mail) or reads something. This
/// creates a sign-in identity inside a customer's organisation. The shape
/// follows from that:
///
///   * the key is resolved through core.resolve_api_key, a SECURITY DEFINER
///     lookup, because row-level security needs a tenant and the tenant is not
///     known until the key is found — the same circle the mail send API and
///     the refresh endpoint break the same way;
///   * a revoked key and an unknown key get the SAME answer, because telling a
///     caller their key once existed tells an attacker their guess was close;
///   * the scope is checked explicitly, and an empty scope list can do nothing;
///   * every rule the console applies is applied here, because this calls the
///     console's own method rather than a copy (UserEndpoints.CreatePersonAsync);
///   * a key cannot create an administrator, at any scope;
///   * every creation is audited, naming the key rather than a person, so the
///     trail says "added by the student system" and not "added by nobody".
/// </summary>
public static class OrgApiEndpoints
{
    public const string AdmitPath = "/api/v1/org/people";

    public static void MapOrgApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost(AdmitPath, AdmitAsync)
            .AllowAnonymous()
            .RequireRateLimiting("org-api")
            .WithTags("Organisation API");
    }

    private static async Task<IResult> AdmitAsync(
        AdmitPersonRequest req, HttpContext http, AppDbContext db, TenantContext tenant,
        StorageAllocator storage, AuditWriter audit, IPasswordHasher hasher,
        SystemMailer mailer, IConfiguration config, CancellationToken ct)
    {
        // ---- 1. The key, and the organisation it names ---------------------
        // Shared with every other endpoint on this surface, so that "revoked
        // and unknown answer alike" cannot drift into two different answers.
        var auth = await OrgApiAuth.AuthenticateAsync(
            http, db, tenant, OrgApiKey.ScopePeopleAdmit,
            "This key is not allowed to add people. Create a key with that ticked, in Organisation then API keys.",
            ct);
        if (auth.Caller is not { } caller) return auth.Refusal!;

        // ---- 2. The same rules the console applies ------------------------
        // Deliberately the console's own method, not a copy: capacity, domain
        // verification, address uniqueness, the invitation channel and the
        // role rules all keep applying, and cannot drift apart from what an
        // administrator sees.
        var domainId = req.DomainId;
        if (domainId is null)
        {
            // One verified domain is the ordinary case, so the caller need not
            // know its id. Two or more and they must choose, rather than us
            // guessing which one a person belongs on.
            var verified = await db.Domains.AsNoTracking()
                .Where(d => d.IsActive && d.OwnershipVerifiedAt != null)
                .Select(d => new { d.Id, d.Fqdn })
                .ToListAsync(ct);
            if (verified.Count == 0)
                return Results.BadRequest(new { error = "No verified domain. Verify one in the console before adding people through the API." });
            if (verified.Count > 1)
                return Results.BadRequest(new
                {
                    error = "This organisation has more than one verified domain, so name the one to use: "
                          + string.Join(", ", verified.Select(v => $"{v.Fqdn} ({v.Id})")),
                });
            domainId = verified[0].Id;
        }

        var result = await UserEndpoints.CreatePersonAsync(
            new CreateUserRequest(
                LocalPart: req.LocalPart ?? "",
                DisplayName: req.DisplayName ?? "",
                DomainId: domainId.Value,
                DepartmentId: req.DepartmentId,
                QuotaBytes: null,               // the plan's default, as the console does
                Password: null,                 // never over an API: the person sets their own
                Products: req.Products,
                Role: req.Role,
                RecoveryEmail: req.RecoveryEmail,
                RecoveryPhone: req.RecoveryPhone),
            db, storage, tenant, audit, hasher, mailer, config,
            allowPrivilegedRoles: false, ct);

        await audit.WriteAsync("org.api_person_admitted", "org_api_key", caller.KeyId.ToString(),
            after: new { localPart = req.LocalPart, req.DisplayName, from = OrgApiAuth.ClientAddress(http) }, ct: ct);

        return result;
    }
}

/// <summary>
/// What a caller sends to admit a person. Deliberately NOT a password: an
/// account created over an API is entered by its own person, through the
/// invitation decision 0005 already specifies, so a key never handles anyone's
/// password.
/// </summary>
public sealed record AdmitPersonRequest(
    string? LocalPart,
    string? DisplayName,
    Guid? DomainId,
    Guid? DepartmentId,
    string? Role,
    string? RecoveryEmail,
    string? RecoveryPhone,
    string[]? Products);

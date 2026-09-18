using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// The organisation API — a customer's own software acting on their own
/// organisation, authenticated by an organisation API key (Amit, 18 September
/// 2026). One call today: admit a person.
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
        // ---- 1. The key ---------------------------------------------------
        var header = http.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
            return Unauthorized("Provide your organisation API key as: Authorization: Bearer tvk_...");

        var hash = OrgApiKeyEndpoints.Sha256(header["Bearer ".Length..].Trim());

        Guid keyId, keyTenantId;
        bool wasRevoked;
        string[] scopes;
        {
            var conn = db.Database.GetDbConnection();
            // Opening the raw connection bypasses TenantConnectionInterceptor,
            // which sets app.tenant_id only when IT opens one. Leaving this
            // open would mean every query afterwards runs on a connection that
            // never got a tenant — zero rows, all request long, for reasons
            // nothing would explain. So it is closed again immediately and EF
            // opens its own through the interceptor once the scope is set.
            var openedHere = conn.State != System.Data.ConnectionState.Open;
            if (openedHere) await conn.OpenAsync(ct);
            try
            {
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT key_id, tenant_id, was_revoked, scopes FROM core.resolve_api_key(@hash)";
                var p = cmd.CreateParameter(); p.ParameterName = "@hash"; p.Value = hash; cmd.Parameters.Add(p);
                await using var reader = await cmd.ExecuteReaderAsync(ct);

                // Revoked and unknown answer identically, on purpose.
                if (!await reader.ReadAsync(ct)) return Unauthorized("That API key is not valid.");
                keyId = reader.GetGuid(0);
                keyTenantId = reader.GetGuid(1);
                wasRevoked = reader.GetBoolean(2);
                scopes = reader.IsDBNull(3) ? [] : reader.GetFieldValue<string[]>(3);
            }
            finally
            {
                if (openedHere) await conn.CloseAsync();
            }
        }
        if (wasRevoked) return Unauthorized("That API key is not valid.");

        if (!scopes.Contains(OrgApiKey.ScopePeopleAdmit))
            return Results.Json(new
            {
                error = "This key is not allowed to add people. Create a key with that ticked, in Organisation then API keys.",
            }, statusCode: 403);

        // ---- 2. Into the organisation's own scope -------------------------
        // The key names the tenant; from here every read and write is ordinary
        // row-level security, as a signed-in request would be. The actor is
        // the key, not a person, so UserId stays null and the audit row says
        // so.
        tenant.EnterAnonymousScope(keyTenantId, "org_api");
        await db.SyncTenantAsync(ct);

        await StampLastUsedAsync(db, keyId, ct);

        // ---- 3. The same rules the console applies ------------------------
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

        await audit.WriteAsync("org.api_person_admitted", "org_api_key", keyId.ToString(),
            after: new { localPart = req.LocalPart, req.DisplayName, from = ClientAddress(http) }, ct: ct);

        return result;
    }

    /// <summary>
    /// At most once an hour per key, for the same reason the OIDC
    /// applications column is: it is a write on every call otherwise. Its
    /// failure can never fail the caller's request — it is bookkeeping about
    /// the key, not part of admitting anyone.
    /// </summary>
    private static async Task StampLastUsedAsync(AppDbContext db, Guid keyId, CancellationToken ct)
    {
        try
        {
            var cutoff = DateTimeOffset.UtcNow.AddHours(-1);
            await db.OrgApiKeys
                .Where(k => k.Id == keyId && (k.LastUsedAt == null || k.LastUsedAt < cutoff))
                .ExecuteUpdateAsync(s => s.SetProperty(k => k.LastUsedAt, DateTimeOffset.UtcNow), ct);
        }
        catch { /* see the summary */ }
    }

    /// <summary>The last X-Forwarded-For entry, the one Caddy wrote — the same rule every limiter here uses.</summary>
    private static string ClientAddress(HttpContext http)
    {
        var xff = http.Request.Headers["X-Forwarded-For"].ToString();
        return string.IsNullOrEmpty(xff)
            ? http.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
    }

    private static IResult Unauthorized(string message) =>
        Results.Json(new { error = message }, statusCode: 401);
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

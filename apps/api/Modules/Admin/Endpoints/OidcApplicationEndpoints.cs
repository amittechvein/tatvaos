using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using OpenIddict.Abstractions;
using OpenIddict.Core;
using TatvaOS.Api.Shared.Auth.Oidc;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Applications — the relying parties an organisation admin registers so
/// their other software can sign people in with TatvaOS (decision 0004).
///
/// Stage 1 of the provider: registration, listing, the consent switch and
/// revocation. The protocol endpoints (authorize, token, userinfo) come in
/// later stages; until they exist an application here can be registered and
/// revoked but nothing can sign in through it.
///
/// What is never returned: a client secret after the one response that
/// creates it. OpenIddict hashes it; the row keeps only a visible prefix so
/// the console can say which secret it is. Revoke, never delete — the
/// mail.api_keys posture — so the audit trail and the list keep the history.
/// </summary>
public static class OidcApplicationEndpoints
{
    public static void MapOidcApplicationEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/org/applications")
            .RequireAuthorization("OrgAdmin")
            .WithTags("Organisation administration");

        g.MapGet("/", ListAsync);
        g.MapPost("/", CreateAsync);
        g.MapPost("/{id:guid}/consent", SetConsentAsync);
        g.MapPost("/{id:guid}/revoke", RevokeAsync);
    }

    // The four scopes v1 offers, and nothing else (0004). offline_access is
    // granted through the refresh-token grant permission, openid needs no
    // permission of its own.
    private static readonly string[] Scopes = ["profile", "email"];

    // ------------------------------------------------------------------
    private static async Task<IResult> ListAsync(
        AppDbContext db, OpenIddictApplicationManager<OidcApplication> manager, CancellationToken ct)
    {
        // The DbSet, not the manager: the manager's finders are for the
        // protocol path and hide revoked applications on purpose; the console
        // shows the history.
        var apps = await db.OidcApplications.AsNoTracking()
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);

        var list = new List<object>(apps.Count);
        foreach (var a in apps)
        {
            var uris = await manager.GetRedirectUrisAsync(a, ct);
            list.Add(Describe(a, uris));
        }
        return Results.Ok(list);
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> CreateAsync(
        CreateApplicationRequest req, AppDbContext db, TenantContext tenant,
        OpenIddictApplicationManager<OidcApplication> manager, AuditWriter audit,
        CancellationToken ct)
    {
        var name = req.Name?.Trim() ?? "";
        if (name.Length is < 2 or > 100)
            return Results.BadRequest(new { error = "Give the application a name of 2 to 100 characters." });

        var uris = new List<Uri>();
        foreach (var raw in req.RedirectUris ?? [])
        {
            var problem = CheckRedirectUri(raw, out var uri);
            if (problem is not null) return Results.BadRequest(new { error = problem });
            if (!uris.Contains(uri!)) uris.Add(uri!);
        }
        if (uris.Count == 0)
            return Results.BadRequest(new { error = "At least one redirect URI is required — the https address the application returns people to." });

        // Random, platform-wide unique, and free of the tenant so it says
        // nothing about who owns it. 32 bytes → 43 URL-safe characters.
        var clientId = "tos_" + RandomToken(24);
        string? secret = req.Confidential ? "toss_" + RandomToken(32) : null;

        var descriptor = new OpenIddictApplicationDescriptor
        {
            ClientId = clientId,
            // NOT set here: PopulateAsync would copy it onto the entity in the
            // clear before CreateAsync hashed it. The secret goes to CreateAsync
            // alone, which stores only the hash.
            ClientSecret = null,
            ClientType = req.Confidential ? ClientTypes.Confidential : ClientTypes.Public,
            ApplicationType = req.Confidential ? ApplicationTypes.Web : ApplicationTypes.Native,
            ConsentType = ConsentTypes.Explicit,
            DisplayName = name,
        };
        foreach (var u in uris) descriptor.RedirectUris.Add(u);
        descriptor.Permissions.UnionWith(
        [
            Permissions.Endpoints.Authorization,
            Permissions.Endpoints.Token,
            Permissions.Endpoints.Revocation,
            Permissions.Endpoints.Introspection,
            Permissions.GrantTypes.AuthorizationCode,
            Permissions.GrantTypes.RefreshToken,
            Permissions.ResponseTypes.Code,
        ]);
        foreach (var s in Scopes) descriptor.Permissions.Add(Permissions.Prefixes.Scope + s);
        // PKCE S256 for every client, confidential ones included (0004).
        descriptor.Requirements.Add(Requirements.Features.ProofKeyForCodeExchange);

        var entity = new OidcApplication
        {
            TenantId = tenant.TenantId,
            CreatedBy = tenant.UserId,
            ClientSecretPrefix = secret is null ? null : secret[..10] + "…",
        };
        await manager.PopulateAsync(entity, descriptor, ct);
        // HOW THE SECRET IS STORED, and why it differs from mail.api_keys.
        // OpenIddict's manager hashes it: PBKDF2-HMAC-SHA256, 10,000
        // iterations, 16-byte salt, 32-byte subkey (the ASP.NET Core Identity
        // V3 layout), and verifies it at the token endpoint with the same
        // code. mail.api_keys stores a plain SHA-256 because that lookup is BY
        // the key and must be indexable; this lookup is by client id, so the
        // salted, slow hash is free. And 10,000 iterations is NOT low here:
        // an iteration count defends low-entropy human passwords by making
        // each guess expensive, and this secret is 32 random bytes, where no
        // guess count is the thing standing between an attacker and success.
        // Do not "fix" the number, and do not swap this for SHA-256 to match
        // the API keys — the two lookups have different shapes (CTO, 17 Sept
        // 2026).
        await manager.CreateAsync(entity, secret, ct);

        await audit.WriteAsync("oidc.application_created", "oidc_application", entity.Id.ToString(),
            after: new { clientId, name, confidential = req.Confidential, redirectUris = uris.Select(u => u.ToString()) },
            ct: ct);

        return Results.Created($"/api/org/applications/{entity.Id}", new
        {
            entity.Id,
            clientId,
            // Once. It is hashed on the row and cannot be shown again; losing it
            // means registering the application again.
            clientSecret = secret,
            secretPrefix = entity.ClientSecretPrefix,
            name,
            clientType = req.Confidential ? "confidential" : "public",
            redirectUris = uris.Select(u => u.ToString()),
            note = secret is null
                ? "A public application has no secret. It proves itself with PKCE on every sign-in."
                : "This secret is shown once. Store it in the application's own configuration now; it cannot be shown again.",
        });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// "Allowed for everyone in the organisation": people are not asked to
    /// consent. Audited both ways, because flipping it changes what personal
    /// data leaves TatvaOS without a question being asked (0004).
    /// </summary>
    private static async Task<IResult> SetConsentAsync(
        Guid id, SetApplicationConsentRequest req, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var app = await db.OidcApplications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (app is null) return Results.NotFound();
        if (app.RevokedAt is not null)
            return Results.BadRequest(new { error = "This application is revoked." });

        var before = app.AllowedForEveryone;
        app.AllowedForEveryone = req.AllowedForEveryone;
        app.ConsentType = req.AllowedForEveryone ? ConsentTypes.Implicit : ConsentTypes.Explicit;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("oidc.application_consent_changed", "oidc_application", id.ToString(),
            before: new { allowedForEveryone = before },
            after: new { allowedForEveryone = req.AllowedForEveryone }, ct: ct);

        return Results.Ok(new { app.Id, app.AllowedForEveryone });
    }

    // ------------------------------------------------------------------
    /// <summary>
    /// Revoke: from this commit the client resolver answers "no such client",
    /// and every authorization and token the application holds is revoked in
    /// the same transaction — authorize refuses it, the token endpoint refuses
    /// its secret and refresh tokens, userinfo and introspection answer
    /// inactive. What this cannot do, said on the screen too: recall an ID
    /// token already delivered, or end the application's own session.
    /// </summary>
    private static async Task<IResult> RevokeAsync(
        Guid id, AppDbContext db,
        OpenIddictAuthorizationManager<OidcAuthorization> authorizations,
        OpenIddictTokenManager<OidcToken> tokens,
        AuditWriter audit, CancellationToken ct)
    {
        var app = await db.OidcApplications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (app is null) return Results.NotFound();
        if (app.RevokedAt is not null) return Results.Ok(new { app.Id, app.RevokedAt, alreadyRevoked = true });

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        app.RevokedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        var appId = app.Id.ToString();
        var revokedAuthorizations = 0;
        await foreach (var auth in authorizations.FindByApplicationIdAsync(appId, ct))
            if (await authorizations.TryRevokeAsync(auth, ct)) revokedAuthorizations++;

        var revokedTokens = 0;
        await foreach (var token in tokens.FindByApplicationIdAsync(appId, ct))
            if (await tokens.TryRevokeAsync(token, ct)) revokedTokens++;

        await tx.CommitAsync(ct);

        await audit.WriteAsync("oidc.application_revoked", "oidc_application", appId,
            after: new { app.ClientId, revokedAuthorizations, revokedTokens }, ct: ct);

        return Results.Ok(new
        {
            app.Id,
            app.RevokedAt,
            revokedAuthorizations,
            revokedTokens,
            note = "New sign-ins, refresh tokens and access tokens for this application are refused from now. "
                 + "People already signed in to it stay signed in there until it signs them out.",
        });
    }

    // ------------------------------------------------------------------
    private static object Describe(OidcApplication a, IReadOnlyCollection<string> redirectUris) => new
    {
        a.Id,
        a.ClientId,
        name = a.DisplayName,
        clientType = a.ClientType,
        redirectUris,
        a.AllowedForEveryone,
        secretPrefix = a.ClientSecretPrefix,
        a.CreatedAt,
        a.RevokedAt,
    };

    /// <summary>
    /// https, absolute, no fragment, no wildcard — and matched by exact string
    /// later (0004). Loopback http is the one exception, for native apps
    /// (RFC 8252 §7.3), and only on 127.0.0.1 or localhost.
    /// </summary>
    private static string? CheckRedirectUri(string? raw, out Uri? uri)
    {
        uri = null;
        var s = raw?.Trim() ?? "";
        if (s.Length == 0) return "A redirect URI is empty.";
        if (s.Contains('*')) return $"'{s}' has a wildcard. Redirect URIs are matched exactly; register each one.";
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u)) return $"'{s}' is not an absolute URL.";
        if (!string.IsNullOrEmpty(u.Fragment)) return $"'{s}' has a fragment; the protocol forbids one on a redirect URI.";
        var loopback = u.Scheme == "http" && (u.Host == "127.0.0.1" || u.Host == "localhost");
        if (u.Scheme != "https" && !loopback)
            return $"'{s}' must be https (http is allowed only on localhost, for an application running on the person's own machine).";
        uri = u;
        return null;
    }

    private static string RandomToken(int bytes) =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed record CreateApplicationRequest(string? Name, string[]? RedirectUris, bool Confidential = true);
public sealed record SetApplicationConsentRequest(bool AllowedForEveryone);

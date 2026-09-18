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
        g.MapPost("/{id:guid}/secret", RegenerateSecretAsync);
    }

    // ------------------------------------------------------------------
    //  WHAT AN APPLICATION MAY RECEIVE — the four scopes of v1 (0004), and
    //  the words an administrator chooses between. Scope names mean nothing
    //  to a school administrator; these labels are what the registration
    //  screen shows, and the consent screen a person reads uses the matching
    //  sentences in OidcEndpoints.ReceivesInWords.
    //
    //  THESE TICKS ARE REAL, which is the only reason they are ticks and not
    //  a list (CTO, 18 Sept 2026: "a person who unticks a box and sees no
    //  effect has been lied to by the interface"). An unticked scope is not
    //  written as a permission, and OpenIddict refuses a request that asks
    //  for it — permission enforcement is on, and Program.cs calls no
    //  IgnoreScopePermissions. Step 13 of tests/oidc/stage3-flow.sh asks for
    //  an unticked scope and expects the refusal.
    //
    //  offline_access is OFF by default and is NOT "keeps you signed in".
    //  It hands the application a refresh token: it can reach the person's
    //  information for fourteen days at a time, while they are elsewhere and
    //  not using it. It is the most powerful item in the list, so it must not
    //  read as the mildest (CTO, 18 Sept 2026).
    // ------------------------------------------------------------------
    public static readonly (string Scope, string Label, bool DefaultOn)[] Offerable =
    [
        ("profile", "View their name", true),
        ("email", "View their work email address", true),
        ("offline_access", "Access their information when they are not using the application", false),
    ];
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
            var permissions = await manager.GetPermissionsAsync(a, ct);
            list.Add(Describe(a, uris, permissions));
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

        // Which of the offerable scopes the administrator ticked. Absent
        // means the defaults, so an older caller keeps working; an unknown
        // name is refused rather than ignored, because silently dropping a
        // scope an admin asked for is the same lie as a decorative tick.
        var chosen = (req.Scopes ?? Offerable.Where(o => o.DefaultOn).Select(o => o.Scope).ToArray())
            .Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToArray();
        foreach (var s in chosen)
            if (!Offerable.Any(o => o.Scope == s))
                return Results.BadRequest(new { error = $"'{s}' is not something an application can be given. Choose from: {string.Join(", ", Offerable.Select(o => o.Scope))}." });

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
            Permissions.ResponseTypes.Code,
        ]);
        // Only what was ticked. The refresh-token grant rides with
        // offline_access: without the scope there is nothing to refresh, and
        // leaving the grant on would let a client ask for one anyway.
        foreach (var s in chosen) descriptor.Permissions.Add(Permissions.Prefixes.Scope + s);
        if (chosen.Contains("offline_access")) descriptor.Permissions.Add(Permissions.GrantTypes.RefreshToken);
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
            after: new { clientId, name, confidential = req.Confidential, scopes = chosen, redirectUris = uris.Select(u => u.ToString()) },
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
            scopes = chosen,
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
    /// <summary>
    /// A new client secret, shown once, replacing the old one.
    ///
    /// THE OLD SECRET STOPS WORKING THE INSTANT THIS COMMITS, and that is an
    /// outage for the customer's integration until someone updates it at the
    /// other end (CTO, 18 Sept 2026). The console says so plainly before the
    /// button is pressed. An overlap — two live secrets for a window, so an
    /// integration can be moved across without downtime — is the better
    /// answer and is the next piece of work on this endpoint; until it
    /// exists, the warning is what stands between an admin and an outage.
    ///
    /// Not offered for a public application: it has no secret to replace.
    /// </summary>
    private static async Task<IResult> RegenerateSecretAsync(
        Guid id, AppDbContext db, OpenIddictApplicationManager<OidcApplication> manager,
        AuditWriter audit, CancellationToken ct)
    {
        var app = await db.OidcApplications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (app is null) return Results.NotFound();
        if (app.RevokedAt is not null)
            return Results.BadRequest(new { error = "This application is revoked. Register it again instead." });
        if (app.ClientType != ClientTypes.Confidential)
            return Results.BadRequest(new { error = "A phone or browser application has no secret. It proves itself with PKCE on every sign-in." });

        var secret = "toss_" + RandomToken(32);
        app.ClientSecretPrefix = secret[..10] + "…";
        // The manager hashes it and clears the old one in the same write.
        await manager.UpdateAsync(app, secret, ct);

        await audit.WriteAsync("oidc.application_secret_regenerated", "oidc_application", id.ToString(),
            after: new { app.ClientId, secretPrefix = app.ClientSecretPrefix }, ct: ct);

        return Results.Ok(new
        {
            app.Id,
            app.ClientId,
            clientSecret = secret,
            secretPrefix = app.ClientSecretPrefix,
            note = "This secret is shown once. The previous secret stopped working just now, so the application "
                 + "cannot sign anyone in until this one is in its configuration.",
        });
    }

    // ------------------------------------------------------------------
    private static object Describe(OidcApplication a, IReadOnlyCollection<string> redirectUris,
                                  IReadOnlyCollection<string> permissions) => new
    {
        a.Id,
        a.ClientId,
        name = a.DisplayName,
        clientType = a.ClientType,
        redirectUris,
        // What it may receive, as scope names for the screen to label.
        scopes = permissions
            .Where(p => p.StartsWith(Permissions.Prefixes.Scope, StringComparison.Ordinal))
            .Select(p => p[Permissions.Prefixes.Scope.Length..])
            .ToArray(),
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

public sealed record CreateApplicationRequest(string? Name, string[]? RedirectUris, bool Confidential = true, string[]? Scopes = null);
public sealed record SetApplicationConsentRequest(bool AllowedForEveryone);

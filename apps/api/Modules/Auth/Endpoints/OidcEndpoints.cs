using System.Collections.Immutable;
using System.Security.Claims;
using Microsoft.AspNetCore;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using OpenIddict.Abstractions;
using OpenIddict.Core;
using OpenIddict.Server.AspNetCore;
using OpenIddict.Validation.AspNetCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Auth.Oidc;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// The OpenID Connect provider's own endpoints — decision 0004, stage 3.
///
/// Three of them are ours to answer after OpenIddict has validated the
/// request (passthrough): authorize, where a PERSON arrives in a browser and
/// must be recognised, checked for consent and sent back with a code; token,
/// where the person's liveness is checked again before anything is minted
/// from a code or a refresh token; and userinfo, where the application's and
/// the person's liveness are checked before a claim is read. Introspection,
/// revocation, discovery and the key set stay OpenIddict's.
///
/// WHERE AUTHORIZE LIVES, AND WHY IT IS TWO ADDRESSES. The session cookies
/// are httpOnly, SameSite=Strict and scoped to Path=/api/auth. Strict means a
/// cross-site navigation — the customer's application sending the person
/// here — carries no cookie at all, so an API endpoint reached directly from
/// the application would never see a session. The advertised endpoint is
/// therefore the WEB page /oauth/authorize (what 0004 says: "the authorize
/// page is a web page"), which loads with no cookie needed and then makes one
/// same-site navigation to this API endpoint under /api/auth/, where the
/// cookie does arrive. Discovery publishes the web address; the API matches
/// the /api/auth/ one. Both are registered in Program.cs.
///
/// CONSENT IS A POST FOR THE SAME REASON. The consent page answers by a form
/// POST to this endpoint with tv_decision=allow or deny. The decision is
/// honoured on POST only: a cross-site page cannot forge it, because a
/// cross-site POST carries no Strict cookie and lands as "not signed in"; and
/// the login redirect it would cause rebuilds a GET without the decision.
///
/// WHAT NEVER APPEARS IN A LOG (0004): the code, the tokens, the verifier,
/// and the redirect's Location. Nothing here writes any of them; test step 9
/// searches the API's output for every value the script used.
/// </summary>
public static class OidcEndpoints
{
    /// <summary>The web page relying parties send people to; advertised in discovery.</summary>
    public const string AuthorizePagePath = "/oauth/authorize";
    /// <summary>The API endpoint the page hops to, under the session cookies' path.</summary>
    public const string AuthorizePath = "/api/auth/oauth/authorize";
    public const string ConsentPagePath = "/oauth/consent";
    public const string ConsentDetailsPath = "/api/auth/oauth/consent";
    /// <summary>The person's own list of applications they have allowed, with Remove (0004: "listed on the person's account page with a Remove button").</summary>
    public const string ConsentsPath = "/api/auth/oauth/consents";
    /// <summary>Our copy of an application's logo. Any signed-in person may read their own organisation's.</summary>
    public const string LogoPath = "/api/auth/oauth/applications/{id:guid}/logo";
    public const string TokenPath = "/api/oauth/token";
    public const string UserInfoPath = "/api/oauth/userinfo";
    public const string IntrospectionPath = "/api/oauth/introspect";
    public const string RevocationPath = "/api/oauth/revoke";
    public const string JwksPath = "/api/oauth/jwks";

    /// <summary>The organisation claim (0004): an application can refuse people from organisations it does not serve.</summary>
    public const string TenantClaim = "tid";

    private const string DecisionParameter = "tv_decision";

    public static void MapOidcEndpoints(this IEndpointRouteBuilder app)
    {
        var tag = "OpenID Connect";

        // Both verbs: GET is how the person arrives, POST is how the consent
        // page answers. OpenIddict has parsed and validated the request —
        // client, exact redirect URI, PKCE S256, scopes — before this runs.
        app.MapMethods(AuthorizePath, ["GET", "POST"], AuthorizeAsync)
            .AllowAnonymous()
            .WithTags(tag);

        app.MapPost(TokenPath, ExchangeAsync)
            .AllowAnonymous()
            .WithTags(tag);

        // The access token is the credential: OpenIddict's validation handler
        // finds the reference token by its hash (the resolver names the
        // tenant), checks status and expiry, and hands us the principal.
        app.MapMethods(UserInfoPath, ["GET", "POST"], UserInfoAsync)
            .RequireAuthorization(new AuthorizeAttribute
            {
                AuthenticationSchemes = OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme,
            })
            .WithTags(tag);

        // What the consent page shows. A signed-in person's own request, on
        // their own session, under their own tenant — an application from
        // another organisation is simply not found.
        app.MapGet(ConsentDetailsPath, ConsentDetailsAsync)
            .RequireAuthorization("User")
            .WithTags(tag);

        // Stage 4: what the person has allowed, and taking it back. Their
        // own rows only — the subject is the signed-in user id, under RLS.
        app.MapGet(ConsentsPath, ListConsentsAsync)
            .RequireAuthorization("User")
            .WithTags(tag);
        app.MapDelete(ConsentsPath + "/{id:guid}", RemoveConsentAsync)
            .RequireAuthorization("User")
            .WithTags(tag);

        // The logo, from OUR store. Signed in, and under RLS, so a person
        // reads their own organisation's applications and no others.
        app.MapGet(LogoPath, LogoAsync)
            .RequireAuthorization("User")
            .WithTags(tag);
    }

    /// <summary>
    /// Serves the logo an administrator uploaded, as the type its own bytes
    /// were sniffed to be, with nosniff beside it. Never a redirect to the
    /// application's own server: that is the whole point of keeping a copy
    /// (CTO, 18 Sept 2026).
    /// </summary>
    private static async Task<IResult> LogoAsync(Guid id, AppDbContext db, CancellationToken ct)
    {
        var row = await db.OidcApplications.AsNoTracking()
            .Where(a => a.Id == id && a.LogoBytes != null)
            .Select(a => new { a.LogoBytes, a.LogoContentType })
            .FirstOrDefaultAsync(ct);
        if (row is null) return Results.NotFound();
        return Results.File(row.LogoBytes!, row.LogoContentType ?? "application/octet-stream");
    }

    // ==================================================================
    //  Authorize
    // ==================================================================
    private static async Task<IResult> AuthorizeAsync(
        HttpContext http, AppDbContext db, TenantContext tenant,
        OpenIddictApplicationManager<OidcApplication> applications,
        OpenIddictAuthorizationManager<OidcAuthorization> authorizations,
        AuditWriter audit, IConfiguration config, CancellationToken ct)
    {
        var request = http.GetOpenIddictServerRequest()
            ?? throw new InvalidOperationException("OpenIddict did not attach the authorization request.");
        var web = WebBase(config);

        // The client store already put this request inside the application's
        // organisation (TenantSafeStores): from here every read is RLS.
        var applicationTenant = tenant.TenantId;

        // 1. Who is here — from the active slot's refresh cookie, read but
        //    NOT rotated: rotation is the refresh endpoint's job, and a peek
        //    that rotated would sign the person out of the tab they came from.
        var session = await SessionPeek.ReadAsync(http, db, ct);
        if (session is { Revoked: true })
        {
            // Audited, not escalated (see SessionPeek). Written under the
            // application's tenant, which is the request's scope; a revoked
            // cookie from ANOTHER organisation is not written, because a row
            // naming a foreign user id inside this tenant would be wrong
            // and switching tenants mid-request is the one thing the stores
            // forbid — that case ends as access_denied a few lines down anyway.
            if (session.TenantId == applicationTenant)
                await audit.WriteAsync("oidc.revoked_session_at_authorize", "user", session.UserId.ToString(),
                    after: new { from = ClientAddress(http), clientId = request.ClientId }, ct: ct);
            session = null;
        }
        if (session is null)
        {
            if (request.HasPromptValue(PromptValues.None))
                return Forbid(Errors.LoginRequired, "The person is not signed in.");

            // To sign-in, then back to the WEB page, which re-enters here
            // same-site. The login page's `next` is a client-side route, so it
            // must be the page and not this endpoint.
            var back = AuthorizePagePath + QueryFrom(request);
            return Results.Redirect(web + "/login?next=" + Uri.EscapeDataString(back));
        }

        // 2. The person's organisation must be the application's. The cookie
        //    named the person's tenant through its own resolver; the client
        //    resolver named the application's; they are compared BEFORE any
        //    row of the person's is read, so nothing crosses (0004 step 4).
        if (session.TenantId != applicationTenant)
            return Forbid(Errors.AccessDenied, "This application belongs to a different organisation.");

        // 3. Liveness — the rule every credential store here applies.
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == session.UserId, ct);
        var org = user is null ? null : await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (user is null || user.Status is not "active" || org is null || org.Status is not ("active" or "trial"))
            return Forbid(Errors.AccessDenied, "This account cannot sign in.");
        tenant.Set(user.TenantId, user.Id, user.Role);

        var application = await applications.FindByClientIdAsync(request.ClientId!, ct)
            ?? throw new InvalidOperationException("OpenIddict validated a client the store cannot find.");
        var applicationId = (await applications.GetIdAsync(application, ct))!;
        var subject = user.Id.ToString();

        // 4. Consent: remembered per person, application and scope set
        //    (0004), or skipped when the admin marked the application
        //    "allowed for everyone", or given just now by the consent page.
        var existing = new List<OidcAuthorization>();
        await foreach (var a in authorizations.FindAsync(subject, applicationId, Statuses.Valid,
                           AuthorizationTypes.Permanent, request.GetScopes(), ct))
            existing.Add(a);

        var decision = http.Request.Method == "POST" ? (string?)request.GetParameter(DecisionParameter) : null;
        if (decision == "deny")
            return Forbid(Errors.AccessDenied, "The person declined.");

        var allowedForEveryone = await applications.GetConsentTypeAsync(application, ct) == ConsentTypes.Implicit;
        if (existing.Count == 0 && !allowedForEveryone && decision != "allow")
        {
            if (request.HasPromptValue(PromptValues.None))
                return Forbid(Errors.ConsentRequired, "The person has not allowed this application.");
            return Results.Redirect(web + ConsentPagePath + QueryFrom(request));
        }

        // 5. The identity the tokens carry. `sub` is the user id, never the
        //    email (0004). `tid` always; name and email by scope.
        var identity = NewIdentity(user, request.GetScopes());

        var authorization = existing.LastOrDefault()
            ?? await authorizations.CreateAsync(identity, subject, applicationId,
                   AuthorizationTypes.Permanent, identity.GetScopes(), ct);
        identity.SetAuthorizationId(await authorizations.GetIdAsync(authorization, ct));
        identity.SetDestinations(Destinations);

        return Results.SignIn(new ClaimsPrincipal(identity),
            authenticationScheme: OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    // ==================================================================
    //  Token — code and refresh grants (0004 v1 allows nothing else)
    // ==================================================================
    private static async Task<IResult> ExchangeAsync(
        HttpContext http, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var request = http.GetOpenIddictServerRequest()
            ?? throw new InvalidOperationException("OpenIddict did not attach the token request.");

        if (!request.IsAuthorizationCodeGrantType() && !request.IsRefreshTokenGrantType())
            return Forbid(Errors.UnsupportedGrantType, "Only the authorization code and refresh token grants exist here.");

        // The principal OpenIddict restored from the code or refresh token —
        // already checked for status, expiry, redemption, PKCE and the client.
        var restored = (await http.AuthenticateAsync(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme)).Principal
            ?? throw new InvalidOperationException("OpenIddict validated a grant without a principal.");

        // LIVENESS AGAIN, at every mint. A refresh token lives fourteen days;
        // a person suspended on day two must be refused on day three (0004
        // step 8), and the ID token must carry today's name and email, not
        // the ones from the first sign-in. The client resolver put this
        // request in the application's tenant; the person's row must be there.
        if (!Guid.TryParse(restored.GetClaim(Claims.Subject), out var userId)
            || restored.GetClaim(TenantClaim) != tenant.TenantId.ToString())
            return Forbid(Errors.InvalidGrant, "The token does not belong to this application's organisation.");

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        var org = user is null ? null : await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (user is null || user.Status is not "active" || org is null || org.Status is not ("active" or "trial"))
            return Forbid(Errors.InvalidGrant, "This account can no longer sign in.");

        // Fresh claims, same scopes and same authorization: the private
        // claims (scopes, authorization id, presenters) come across with the
        // restored principal; the person's claims are rewritten from the row.
        await StampLastUsedAsync(db, request.ClientId, ct);

        var identity = new ClaimsIdentity(restored.Claims,
            TokenValidationParameters.DefaultAuthenticationType, Claims.Name, Claims.Role);
        SetPersonClaims(identity, user);
        identity.SetDestinations(Destinations);

        return Results.SignIn(new ClaimsPrincipal(identity),
            authenticationScheme: OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    /// <summary>
    /// "Last used", at most once an hour per application.
    ///
    /// THE WRITE IS THE COST, not the read. Without the hour, this is a row
    /// update on every code exchange and every refresh — a write per sign-in
    /// on a four-core box that also carries live meetings, which is the shape
    /// mail.api_keys' last_used_at already has (CTO, 18 Sept 2026). The
    /// question people actually ask is "has anything used this in the last
    /// year", so an hour's resolution answers it exactly as well.
    ///
    /// Written outside the tenant's own SaveChanges on purpose: it is
    /// bookkeeping about the application, not part of issuing the token, and
    /// it must never be able to fail the exchange. A lost stamp costs an hour
    /// of resolution on a column nobody reads to the second.
    /// </summary>
    private static async Task StampLastUsedAsync(AppDbContext db, string? clientId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(clientId)) return;
        try
        {
            var cutoff = DateTimeOffset.UtcNow.AddHours(-1);
            await db.OidcApplications
                .Where(a => a.ClientId == clientId && (a.LastUsedAt == null || a.LastUsedAt < cutoff))
                .ExecuteUpdateAsync(s => s.SetProperty(a => a.LastUsedAt, DateTimeOffset.UtcNow), ct);
        }
        catch
        {
            // Deliberately swallowed: see the summary. Nothing a person is
            // waiting for should fail because a usage stamp did.
        }
    }

    // ==================================================================
    //  Userinfo
    // ==================================================================
    private static async Task<IResult> UserInfoAsync(
        HttpContext http, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var principal = http.User;

        // THE LIVENESS CHECK 0004's red-first run names. The token store's
        // resolver put us in the token's tenant; the token row names the
        // application; the application must not be revoked and the person
        // must still be active. Revoking an application also revokes its
        // tokens (OidcApplicationEndpoints), so a revoked application's
        // token is normally refused one layer earlier — this is the check
        // that holds when that layer does not, and it is the ONLY check that
        // refuses a suspended person's still-valid access token.
        if (!Guid.TryParse(principal.GetTokenId(), out var tokenId)
            || !Guid.TryParse(principal.GetClaim(Claims.Subject), out var userId))
            return Challenge(Errors.InvalidToken, "The token names no person.");

        var token = await db.OidcTokens.AsNoTracking()
            .Where(t => t.Id == tokenId)
            .Select(t => new { t.Application!.RevokedAt, ApplicationId = (Guid?)t.Application.Id })
            .FirstOrDefaultAsync(ct);
        if (token is null || token.ApplicationId is null || token.RevokedAt is not null)
            return Challenge(Errors.InvalidToken, "The application this token was issued to is no longer allowed.");

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        var org = user is null ? null : await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (user is null || user.Status is not "active" || org is null || org.Status is not ("active" or "trial"))
            return Challenge(Errors.InvalidToken, "This account can no longer sign in.");

        var claims = new Dictionary<string, object>
        {
            [Claims.Subject] = user.Id.ToString(),
            [TenantClaim] = user.TenantId.ToString(),
        };
        if (principal.HasScope(Scopes.Profile)) claims[Claims.Name] = user.DisplayName;
        if (principal.HasScope(Scopes.Email))
        {
            claims[Claims.Email] = user.Email;
            claims[Claims.EmailVerified] = await EmailVerifiedAsync(db, user, ct);
        }
        return Results.Ok(claims);
    }

    // ==================================================================
    //  Consent details — what the page shows before asking
    // ==================================================================
    private static async Task<IResult> ConsentDetailsAsync(
        string? client_id, string? redirect_uri, string? scope,
        AppDbContext db, TenantContext tenant,
        OpenIddictApplicationManager<OidcApplication> applications, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(client_id))
            return Results.BadRequest(new { error = "client_id is required." });

        // Signed in → the store consults no resolver: another organisation's
        // application is not found, and says nothing about whether it exists.
        var application = await applications.FindByClientIdAsync(client_id, ct);
        if (application is null)
            return Results.NotFound(new { error = "No such application in your organisation." });

        if (string.IsNullOrWhiteSpace(redirect_uri)
            || !await applications.ValidateRedirectUriAsync(application, redirect_uri, ct))
            return Results.BadRequest(new { error = "That return address is not one the application registered." });

        var scopes = (scope ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToImmutableArray();
        var org = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Id == tenant.TenantId, ct);

        var receives = ReceivesInWords(scopes);
        var staysSignedIn = scopes.Contains(Scopes.OfflineAccess);

        // What the application SAYS about itself, kept apart from what we can
        // vouch for. The screen labels this block as the application's own
        // description; "Added by <organisation> administrators" is the fact,
        // and the two must not look alike (CTO, 18 Sept 2026).
        var row = await db.OidcApplications.AsNoTracking()
            .Where(a => a.ClientId == client_id)
            .Select(a => new
            {
                a.Id, a.Description, a.OperatorName, a.ClientUri, a.PolicyUri, a.TosUri, a.Contacts,
                HasLogo = a.LogoBytes != null, a.LogoUpdatedAt,
            })
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            name = await applications.GetDisplayNameAsync(application, ct),
            organisation = org?.Name,
            returnsTo = new Uri(redirect_uri).Host,
            receives,
            staysSignedIn,
            allowedForEveryone = await applications.GetConsentTypeAsync(application, ct) == ConsentTypes.Implicit,
            logoUri = row is { HasLogo: true }
                ? Modules.Admin.Endpoints.OidcApplicationEndpoints.LogoPath(row.Id, row.LogoUpdatedAt)
                : null,
            declared = row is null ? null : new
            {
                row.Description,
                row.OperatorName,
                row.ClientUri,
                row.PolicyUri,
                row.TosUri,
                row.Contacts,
            },
        });
    }

    // ==================================================================
    //  Consents — the person's own list, and Remove (stage 4)
    // ==================================================================
    private static async Task<IResult> ListConsentsAsync(
        AppDbContext db, TenantContext tenant,
        OpenIddictAuthorizationManager<OidcAuthorization> authorizations, CancellationToken ct)
    {
        var subject = tenant.UserId!.Value.ToString();
        var rows = await db.OidcAuthorizations.AsNoTracking()
            .Include(a => a.Application)
            .Where(a => a.Subject == subject
                        && a.Status == Statuses.Valid
                        && a.Type == AuthorizationTypes.Permanent
                        && a.Application != null && a.Application.RevokedAt == null)
            .OrderByDescending(a => a.CreationDate)
            .ToListAsync(ct);

        var list = new List<object>(rows.Count);
        foreach (var a in rows)
        {
            var scopes = await authorizations.GetScopesAsync(a, ct);
            list.Add(new
            {
                a.Id,
                application = a.Application!.DisplayName,
                clientId = a.Application.ClientId,
                receives = ReceivesInWords(scopes),
                staysSignedIn = scopes.Contains(Scopes.OfflineAccess),
                grantedAt = a.CreationDate,
                // "Allowed for everyone" by the organisation: a personal Remove
                // would look like it worked and be undone silently at the next
                // sign-in, so the page shows why instead of a button (CTO, 17
                // Sept 2026), and RemoveConsentAsync refuses it.
                allowedForEveryone = a.Application.AllowedForEveryone,
            });
        }
        return Results.Ok(list);
    }

    /// <summary>
    /// Remove: the authorization is revoked and every token under it with
    /// it, so the application's refresh token stops at its next use and its
    /// access token at its next call — the same posture as revoking the
    /// application, scoped to one person. The next sign-in through that
    /// application asks again. What this cannot do is the same as always:
    /// recall an ID token already delivered, or end the application's own
    /// session.
    /// </summary>
    private static async Task<IResult> RemoveConsentAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        OpenIddictAuthorizationManager<OidcAuthorization> authorizations,
        OpenIddictTokenManager<OidcToken> tokens, AuditWriter audit, CancellationToken ct)
    {
        var subject = tenant.UserId!.Value.ToString();
        // The subject is part of the lookup: another person's consent, even
        // one in the same organisation, is not found rather than refused.
        var a = await db.OidcAuthorizations.Include(x => x.Application)
            .FirstOrDefaultAsync(x => x.Id == id && x.Subject == subject, ct);
        if (a is null) return Results.NotFound(new { error = "No such consent." });

        // A control that appears to work and does not is worse than no control.
        // With the organisation's "allowed for everyone" on, authorize skips
        // the prompt and would re-create this row at the next sign-in, so the
        // removal is refused with the reason rather than granted and undone.
        if (a.Application?.AllowedForEveryone == true)
            return Results.Conflict(new
            {
                error = "Your organisation's administrators have approved this application for everyone. Only an administrator can change that.",
                allowedForEveryone = true,
            });

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await authorizations.TryRevokeAsync(a, ct);
        var revokedTokens = 0;
        await foreach (var t in tokens.FindByAuthorizationIdAsync(id.ToString(), ct))
            if (await tokens.TryRevokeAsync(t, ct)) revokedTokens++;
        await tx.CommitAsync(ct);

        await audit.WriteAsync("oidc.consent_removed", "oidc_authorization", id.ToString(),
            after: new { clientId = a.Application?.ClientId, application = a.Application?.DisplayName, revokedTokens }, ct: ct);

        return Results.Ok(new
        {
            id,
            revokedTokens,
            note = "The application can no longer act for you from now. If you are still signed in to it, that session is its own until it signs you out.",
        });
    }

    // ==================================================================
    //  Helpers
    // ==================================================================
    /// <summary>
    /// In words, not scope names (0004): the person is told what leaves.
    ///
    /// ONE IMPLEMENTATION, used by the consent screen and by the person's own
    /// list on their account page, so the two can never describe the same
    /// grant differently (house rule 10).
    ///
    /// offline_access says what it does. It was "keep you signed in without
    /// asking again" until 18 Sept 2026, which made the most powerful item in
    /// the list read as the mildest: a refresh token lets the application
    /// reach the person's information for fourteen days at a time, while they
    /// are elsewhere and not using it (CTO).
    /// </summary>
    private static List<string> ReceivesInWords(ImmutableArray<string> scopes)
    {
        var receives = new List<string>();
        if (scopes.Contains(Scopes.Profile)) receives.Add("your name");
        if (scopes.Contains(Scopes.Email)) receives.Add("your work email address");
        receives.Add("which organisation you belong to");
        if (scopes.Contains(Scopes.OfflineAccess))
            receives.Add("access to your information when you are not using the application");
        return receives;
    }

    private static ClaimsIdentity NewIdentity(Shared.Data.User user, ImmutableArray<string> scopes)
    {
        var identity = new ClaimsIdentity(TokenValidationParameters.DefaultAuthenticationType, Claims.Name, Claims.Role);
        identity.SetClaim(Claims.Subject, user.Id.ToString());
        SetPersonClaims(identity, user);
        identity.SetScopes(scopes);
        return identity;
    }

    private static void SetPersonClaims(ClaimsIdentity identity, Shared.Data.User user)
    {
        identity.SetClaim(Claims.Name, user.DisplayName);
        identity.SetClaim(Claims.Email, user.Email);
        identity.SetClaim(TenantClaim, user.TenantId.ToString());
    }

    /// <summary>
    /// Which token each claim goes into. The ID token is what the
    /// application reads the person from, so it carries name and email only
    /// when the matching scope was granted; the access token carries them for
    /// userinfo. Everything else — OpenIddict's own private claims — goes to
    /// the access token, which is opaque and never leaves this server's stores.
    /// </summary>
    private static IEnumerable<string> Destinations(Claim claim)
    {
        var identity = claim.Subject!;
        switch (claim.Type)
        {
            case Claims.Subject:
            case TenantClaim:
                yield return OpenIddictConstants.Destinations.AccessToken;
                yield return OpenIddictConstants.Destinations.IdentityToken;
                yield break;
            case Claims.Name:
                yield return OpenIddictConstants.Destinations.AccessToken;
                if (identity.HasScope(Scopes.Profile)) yield return OpenIddictConstants.Destinations.IdentityToken;
                yield break;
            case Claims.Email:
            case Claims.EmailVerified:
                yield return OpenIddictConstants.Destinations.AccessToken;
                if (identity.HasScope(Scopes.Email)) yield return OpenIddictConstants.Destinations.IdentityToken;
                yield break;
            default:
                yield return OpenIddictConstants.Destinations.AccessToken;
                yield break;
        }
    }

    /// <summary>
    /// A work address is verified when its domain is one the organisation
    /// proved it owns (core.domains, ownership verified). Never asserted from
    /// the fact that the person signed in: that proves the password, not the
    /// mailbox.
    /// </summary>
    private static async Task<bool> EmailVerifiedAsync(AppDbContext db, Shared.Data.User user, CancellationToken ct)
    {
        var at = user.Email.LastIndexOf('@');
        if (at < 0) return false;
        var domain = user.Email[(at + 1)..].ToLowerInvariant();
        return await db.Domains.AsNoTracking()
            .AnyAsync(d => d.Fqdn == domain && d.IsActive && d.OwnershipVerifiedAt != null, ct);
    }

    /// <summary>
    /// The original request's parameters as a query string, minus the
    /// decision — so a login or consent detour returns to the same request
    /// and never carries a decision the person did not just make.
    /// </summary>
    private static string QueryFrom(OpenIddictRequest request)
    {
        var parts = new List<string>();
        foreach (var (name, value) in request.GetParameters())
        {
            if (name == DecisionParameter) continue;
            var s = (string?)value;
            if (s is null) continue;
            parts.Add(Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(s));
        }
        return parts.Count == 0 ? "" : "?" + string.Join("&", parts);
    }

    /// <summary>
    /// Where the web pages live, for the two redirects that leave the API:
    /// the issuer's origin, which is the web app's too (one host, Caddy in
    /// front), unless Oidc:WebBaseUrl says otherwise — a laptop running the
    /// web app on :3000 and the API on another port sets it. Absolute, because
    /// a relative Location resolves against the API's origin.
    /// </summary>
    private static string WebBase(IConfiguration config) =>
        (config["Oidc:WebBaseUrl"] ?? config["Oidc:Issuer"] ?? "https://core.tatvaos.com").TrimEnd('/');

    /// <summary>
    /// The address a request came from, for limiting and auditing. Behind
    /// Caddy the connection's address is Caddy's; Caddy appends the real
    /// client to X-Forwarded-For, so the LAST entry is the one Caddy wrote and
    /// the only one not chosen by the client. The same rule as every other
    /// limiter in Program.cs.
    /// </summary>
    public static string ClientAddress(HttpContext http)
    {
        var xff = http.Request.Headers["X-Forwarded-For"].ToString();
        return string.IsNullOrEmpty(xff)
            ? http.Connection.RemoteIpAddress?.ToString() ?? "unknown"
            : xff.Split(',')[^1].Trim();
    }

    /// <summary>
    /// The two public, unauthenticated, database-costing paths (CTO, 17 Sept
    /// 2026): token, where the client secret arrives in the body, and
    /// authorize. The limiter must sit IN FRONT of OpenIddict's client lookup,
    /// which happens inside the authentication middleware, not at the
    /// endpoint — so Program.cs mounts these options on a branch before
    /// UseAuthentication, keyed per client address and per path. Defaults:
    /// 120 token requests and 60 authorize requests a minute per address,
    /// configurable as Oidc:TokenRequestsPerMinute and
    /// Oidc:AuthorizeRequestsPerMinute (the test lowers them to prove the 429).
    /// </summary>
    public static bool IsRateLimitedPath(PathString path) =>
        path.Equals(TokenPath, StringComparison.OrdinalIgnoreCase)
        || path.Equals(AuthorizePath, StringComparison.OrdinalIgnoreCase);

    public static Microsoft.AspNetCore.RateLimiting.RateLimiterOptions RateLimiterOptions(IConfiguration config)
    {
        var tokenPerMinute = config.GetValue<int?>("Oidc:TokenRequestsPerMinute") ?? 120;
        var authorizePerMinute = config.GetValue<int?>("Oidc:AuthorizeRequestsPerMinute") ?? 60;
        return new Microsoft.AspNetCore.RateLimiting.RateLimiterOptions
        {
            RejectionStatusCode = StatusCodes.Status429TooManyRequests,
            GlobalLimiter = System.Threading.RateLimiting.PartitionedRateLimiter.Create<HttpContext, string>(http =>
            {
                var isToken = http.Request.Path.Equals(TokenPath, StringComparison.OrdinalIgnoreCase);
                return System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
                    (isToken ? "oidc-token:" : "oidc-authorize:") + ClientAddress(http),
                    _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions
                    {
                        PermitLimit = isToken ? tokenPerMinute : authorizePerMinute,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    });
            }),
            OnRejected = (ctx, _) =>
            {
                // The protocol's own shape for "not now", so a relying party's
                // client library reads it as an error and not as a token.
                ctx.HttpContext.Response.ContentType = "application/json";
                return new ValueTask(ctx.HttpContext.Response.WriteAsync(
                    "{\"error\":\"temporarily_unavailable\",\"error_description\":\"Too many requests from this address. Try again in a minute.\"}"));
            },
        };
    }

    private static IResult Forbid(string error, string description) =>
        Results.Forbid(
            new AuthenticationProperties(new Dictionary<string, string?>
            {
                [OpenIddictServerAspNetCoreConstants.Properties.Error] = error,
                [OpenIddictServerAspNetCoreConstants.Properties.ErrorDescription] = description,
            }),
            [OpenIddictServerAspNetCoreDefaults.AuthenticationScheme]);

    private static IResult Challenge(string error, string description) =>
        Results.Challenge(
            new AuthenticationProperties(new Dictionary<string, string?>
            {
                [OpenIddictValidationAspNetCoreConstants.Properties.Error] = error,
                [OpenIddictValidationAspNetCoreConstants.Properties.ErrorDescription] = description,
            }),
            [OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme]);
}

/// <summary>
/// Reads who is signed in from the browser's session cookies WITHOUT
/// rotating anything — the peek the authorize endpoint needs. The refresh
/// endpoint owns rotation; this only answers "which person, which
/// organisation, still live?" and never writes.
///
/// The token's tenant comes from the same SECURITY DEFINER resolver the
/// refresh endpoint uses, because at this point the request sits in the
/// APPLICATION's tenant and the person may belong to another one. That is
/// precisely the case the caller has to detect, so the answer carries the
/// tenant for the caller to compare and no row of the person's is read here.
///
/// THE SAME VALIDATION AS SIGN-IN, minus the rotation (CTO's question, 17 Sept
/// 2026): the cookie is hashed, never decoded or trusted; the resolver is the
/// one the refresh endpoint uses and its SQL answers only a token whose
/// expires_at is in the future; a revoked token — its own revocation or its
/// family's, since a reuse kills every token of the family — answers "not
/// signed in"; and the caller then checks the tenant, the person's status
/// and the organisation's before anything is issued.
///
/// WHAT A PEEK DOES NOT DO — a decision, not an omission (CTO, 17 Sept 2026):
/// it does not kill the family when it meets a revoked token. A revoked token
/// at authorize is very often a stale second tab, not theft — someone clicked
/// "sign in with TatvaOS" from a tab whose session was rotated elsewhere —
/// and tearing down their whole session for that would be hostile.
/// Escalation belongs to the write path (the refresh endpoint), which the
/// next refresh in that browser reaches. What the peek DOES do is hand the
/// revoked outcome back so the caller writes it to the audit log: the first
/// time anyone investigates a suspected session theft, "a revoked cookie was
/// presented at authorize, from this address, at this time" is the line they
/// will want and cannot reconstruct later.
/// </summary>
public static class SessionPeek
{
    /// <summary>Revoked: the cookie named a real person but its token is dead — not signed in, and worth a line in the audit log.</summary>
    public sealed record Session(Guid TenantId, Guid UserId, bool Revoked);

    public static async Task<Session?> ReadAsync(HttpContext http, AppDbContext db, CancellationToken ct)
    {
        var presented = http.Request.Cookies[AuthEndpoints.RefreshCookie(AuthEndpoints.ActiveSlot(http))];
        if (string.IsNullOrWhiteSpace(presented))
            for (var i = 0; i < AuthEndpoints.MaxAccounts && string.IsNullOrWhiteSpace(presented); i++)
                presented = http.Request.Cookies[AuthEndpoints.RefreshCookie(i)];
        if (string.IsNullOrWhiteSpace(presented)) return null;

        var conn = db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT tenant_id, user_id, was_revoked FROM core.resolve_refresh_token(@hash)";
        var p = cmd.CreateParameter(); p.ParameterName = "@hash"; p.Value = TokenIssuer.HashRefreshToken(presented);
        cmd.Parameters.Add(p);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new Session(r.GetGuid(0), r.GetGuid(1), Revoked: r.GetBoolean(2));
    }
}

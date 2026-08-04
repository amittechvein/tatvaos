using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Auth.Endpoints;

/// <summary>
/// Core sign-in. ONE login for every TatvaOS product.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Two things here are worth understanding before changing anything.
///
///  1. LOGIN IS THE ONE CROSS-TENANT LOOKUP IN THE SYSTEM.
///     A sign-in request carries an email address and nothing else — we
///     cannot know the tenant until we have found the user. So this is the
///     only place that queries core.users with the tenant filter off. It is
///     safe because core.users carries no RLS by design (the mail edge must
///     resolve recipients before any tenant is known), and because the query
///     is by exact email, which returns one row or none.
///
///  2. FAILURES ARE DELIBERATELY INDISTINGUISHABLE.
///     Wrong password, unknown address, suspended account and suspended
///     organisation all return the same message. Telling an attacker which
///     addresses exist on the platform is a free customer list, and telling
///     them an account is merely suspended tells them it is worth pursuing.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AuthEndpoints
{
    // Five is enough for someone genuinely mistyping; far too few to guess a
    // password. The lockout expires on its own, because the common cause is a
    // person fumbling their own credentials and an admin ticket for that helps
    // nobody.
    private const int MaxFailedAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    private const string GenericFailure =
        "That email address and password combination was not recognised.";

    // ---------------------------------------------------------------------
    //  The refresh token also goes out as an httpOnly cookie.
    //
    //  This is a mail product: it renders HTML written by strangers. Assume a
    //  cross-site scripting bug will happen one day, and design so that it is
    //  survivable. A token in localStorage is readable by any script on the
    //  page; an httpOnly cookie is not readable by script at all.
    //
    //  Web clients should therefore ignore the refreshToken in the response
    //  body entirely and let the browser handle the cookie. It stays in the
    //  body for the mobile apps, which have no cookie jar to rely on and put
    //  it in the Keychain or Keystore — storage that XSS cannot reach either.
    //
    //  Path is scoped to /api/auth so the token is not attached to every
    //  ordinary API call, and SameSite=Strict because there is no legitimate
    //  cross-site request that should carry it.
    // ---------------------------------------------------------------------
    private const string RefreshCookie = "tv_refresh";

    private static void SetRefreshCookie(HttpContext http, string token) =>
        http.Response.Cookies.Append(RefreshCookie, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/api/auth",
            Expires = DateTimeOffset.UtcNow.Add(TokenIssuer.RefreshTokenLifetime),
        });

    private static void ClearRefreshCookie(HttpContext http) =>
        http.Response.Cookies.Delete(RefreshCookie, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/api/auth",
        });

    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/auth").WithTags("Authentication");

        g.MapPost("/login", LoginAsync).AllowAnonymous();
        g.MapPost("/refresh", RefreshAsync).AllowAnonymous();
        g.MapPost("/logout", LogoutAsync).RequireAuthorization("User");
        g.MapGet("/me", MeAsync).RequireAuthorization("User");
        g.MapPost("/change-password", ChangePasswordAsync).RequireAuthorization("User");
        g.MapGet("/sessions", SessionsAsync).RequireAuthorization("User");
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> LoginAsync(
        LoginRequest req, AppDbContext db, TokenIssuer tokens, IPasswordHasher hasher,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        var email = req.Email?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrEmpty(req.Password))
            return Results.BadRequest(new { error = "Email and password are required." });

        // IgnoreQueryFilters is required, not a shortcut: the global filter
        // reads TenantContext.TenantId, which THROWS when no tenant is set —
        // and on an anonymous login there is none.
        var user = await db.Users.IgnoreQueryFilters()
            .FirstOrDefaultAsync(u => u.Email == email, ct);

        if (user is null)
        {
            // Hash anyway. Returning immediately makes an unknown address
            // measurably faster than a wrong password, which turns response
            // time into an account-enumeration oracle.
            hasher.Verify(req.Password, DummyHash);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        if (user.LockedUntil is DateTimeOffset until && until > DateTimeOffset.UtcNow)
        {
            var minutes = Math.Max(1, (int)(until - DateTimeOffset.UtcNow).TotalMinutes);
            return Results.Json(new
            {
                error = $"Too many failed attempts. Try again in {minutes} minute(s).",
            }, statusCode: 429);
        }

        // From here the tenant is known, so the rest of the request can use
        // normal scoped queries — and the refresh token INSERT below needs the
        // database session set, because core.refresh_tokens is RLS-forced.
        tenant.Set(user.TenantId, user.Id, user.Role);
        await db.SyncTenantAsync(ct);

        var valid = user.PasswordHash is not null && hasher.Verify(req.Password, user.PasswordHash);

        if (!valid)
        {
            user.FailedLoginCount++;
            if (user.FailedLoginCount >= MaxFailedAttempts)
            {
                user.LockedUntil = DateTimeOffset.UtcNow.Add(LockoutDuration);
                user.FailedLoginCount = 0;
            }
            await db.SaveChangesAsync(ct);
            return Results.Json(new { error = GenericFailure }, statusCode: 401);
        }

        // Checked AFTER the password, on purpose. Checking first would let
        // anyone discover which accounts are suspended without a credential.
        var org = await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);
        if (user.Status is "suspended" or "deleted" || org?.Status is "suspended" or "deleted")
            return Results.Json(new { error = GenericFailure }, statusCode: 401);

        user.FailedLoginCount = 0;
        user.LockedUntil = null;
        user.LastLoginAt = DateTimeOffset.UtcNow;
        if (user.Status == "pending") user.Status = "active";

        var (refresh, _) = await IssueRefreshAsync(db, user, Guid.NewGuid(), http, ct);
        var access = tokens.IssueAccessToken(user);
        await db.SaveChangesAsync(ct);
        SetRefreshCookie(http, refresh);

        return Results.Ok(new AuthResponse(
            AccessToken: access.Value,
            ExpiresAt: access.ExpiresAt,
            RefreshToken: refresh,
            MustChangePassword: user.MustChangePassword,
            User: Describe(user)));
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> RefreshAsync(
        RefreshRequest req, AppDbContext db, TokenIssuer tokens,
        TenantContext tenant, HttpContext http, CancellationToken ct)
    {
        // Cookie first. A browser sends it automatically and never exposes it
        // to script; the body is the mobile path.
        var presented = http.Request.Cookies[RefreshCookie];
        if (string.IsNullOrWhiteSpace(presented)) presented = req.RefreshToken;

        if (string.IsNullOrWhiteSpace(presented))
            return Results.BadRequest(new { error = "A refresh token is required." });

        var hash = TokenIssuer.HashRefreshToken(presented);

        // core.refresh_tokens is RLS-forced and we do not yet know the tenant,
        // so this goes through the SECURITY DEFINER function that exists for
        // exactly this one lookup. See 04-auth.sql.
        //
        // Raw ADO rather than EF's SqlQuery<T>: that only maps scalar types
        // unless the result type is registered as a keyless entity, and a
        // multi-column projection through it compiles fine and then fails at
        // runtime. Not a place to find out.
        var resolved = await ResolveTokenAsync(db, hash, ct);

        if (resolved is null)
            return Results.Json(new { error = "Session expired. Sign in again." }, statusCode: 401);

        tenant.Set(resolved.TenantId, resolved.UserId, "employee");
        await db.SyncTenantAsync(ct);

        // A revoked token being presented means someone is replaying one that
        // was already spent — either a thief, or the real user after a thief.
        // There is no way to tell which, so both are stopped: kill the family.
        // The legitimate user signs in again; the thief has nothing.
        if (resolved.WasRevoked)
        {
            await db.RefreshTokens
                .Where(t => t.FamilyId == resolved.FamilyId && t.RevokedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                    .SetProperty(t => t.RevokeReason, (string?)"reuse detected"), ct);

            return Results.Json(new
            {
                error = "This session was already used elsewhere and has been ended. Sign in again.",
            }, statusCode: 401);
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == resolved.UserId, ct);
        var org = user is null ? null
            : await db.Tenants.FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);

        // THE check that makes suspension real. An access token cannot be
        // withdrawn, but it only lasts fifteen minutes — and it is renewed
        // here, where the database gets a say.
        if (user is null || user.Status is "suspended" or "deleted"
            || org?.Status is "suspended" or "deleted")
        {
            await db.RefreshTokens
                .Where(t => t.FamilyId == resolved.FamilyId && t.RevokedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                    .SetProperty(t => t.RevokeReason, (string?)"account or organisation suspended"), ct);

            return Results.Json(new { error = "This account is no longer active." }, statusCode: 401);
        }

        var old = await db.RefreshTokens.FirstAsync(t => t.Id == resolved.TokenId, ct);
        var (newToken, newRow) = await IssueRefreshAsync(db, user, resolved.FamilyId, http, ct);

        old.RevokedAt = DateTimeOffset.UtcNow;
        old.RevokeReason = "rotated";
        old.ReplacedBy = newRow.Id;

        var access = tokens.IssueAccessToken(user);
        await db.SaveChangesAsync(ct);
        SetRefreshCookie(http, newToken);

        return Results.Ok(new AuthResponse(
            access.Value, access.ExpiresAt, newToken, user.MustChangePassword, Describe(user)));
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> LogoutAsync(
        RefreshRequest? req, AppDbContext db, TenantContext tenant,
        HttpContext http, CancellationToken ct)
    {
        var presented = http.Request.Cookies[RefreshCookie] ?? req?.RefreshToken;

        // Revokes the whole family, so "sign out" means signed out — not
        // "signed out until the refresh token is used again".
        if (!string.IsNullOrWhiteSpace(presented))
        {
            var hash = TokenIssuer.HashRefreshToken(presented);
            var row = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
            if (row is not null)
            {
                await db.RefreshTokens
                    .Where(t => t.FamilyId == row.FamilyId && t.RevokedAt == null)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                        .SetProperty(t => t.RevokeReason, (string?)"signed out"), ct);
            }
        }

        ClearRefreshCookie(http);
        return Results.Ok(new { signedOut = true });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> MeAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        var org = await db.Tenants.AsNoTracking()
            .FirstOrDefaultAsync(t => t.Id == user.TenantId, ct);

        var products = await db.ProductAccess.AsNoTracking()
            .Where(p => p.UserId == user.Id && p.RevokedAt == null)
            .Select(p => p.ProductCode)
            .ToListAsync(ct);

        var mailbox = await db.Mailboxes.AsNoTracking()
            .Where(m => m.UserId == user.Id)
            .Select(m => m.Address)
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            user = Describe(user),
            organisation = org is null ? null : new { org.Id, org.Name, org.Type, org.Status },
            products,
            mailboxAddress = mailbox,
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> ChangePasswordAsync(
        ChangePasswordRequest req, AppDbContext db, IPasswordHasher hasher,
        TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(req.CurrentPassword) || string.IsNullOrEmpty(req.NewPassword))
            return Results.BadRequest(new { error = "Both the current and new password are required." });

        // Twelve, with no composition rules. Length beats character classes:
        // "Password1!" satisfies every rule most systems impose and is on
        // every wordlist, while a four-word phrase is stronger and memorable.
        if (req.NewPassword.Length < 12)
            return Results.BadRequest(new
            {
                error = "Use at least 12 characters. A short phrase you can remember beats a short password you cannot.",
            });

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == tenant.UserId, ct);
        if (user is null) return Results.NotFound();

        if (user.PasswordHash is null || !hasher.Verify(req.CurrentPassword, user.PasswordHash))
            return Results.Json(new { error = "Current password is incorrect." }, statusCode: 401);

        if (req.NewPassword == req.CurrentPassword)
            return Results.BadRequest(new { error = "The new password must be different." });

        user.PasswordHash = hasher.Hash(req.NewPassword);
        user.PasswordChangedAt = DateTimeOffset.UtcNow;
        user.MustChangePassword = false;

        // Every other session ends. If the reason for changing the password is
        // that someone else knows it, leaving their session alive defeats the
        // entire exercise.
        await db.RefreshTokens
            .Where(t => t.UserId == user.Id && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(t => t.RevokedAt, (DateTimeOffset?)DateTimeOffset.UtcNow)
                .SetProperty(t => t.RevokeReason, (string?)"password changed"), ct);

        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("user.password_changed", "user", user.Id.ToString(), ct: ct);

        return Results.Ok(new
        {
            changed = true,
            note = "All other sessions have been signed out. Sign in again on your other devices.",
        });
    }

    // ------------------------------------------------------------------
    private static async Task<IResult> SessionsAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var sessions = await db.RefreshTokens.AsNoTracking()
            .Where(t => t.UserId == tenant.UserId && t.RevokedAt == null
                        && t.ExpiresAt > DateTimeOffset.UtcNow)
            .OrderByDescending(t => t.IssuedAt)
            .Select(t => new { t.Id, t.IssuedAt, t.ExpiresAt, t.UserAgent, t.IpAddress })
            .ToListAsync(ct);

        return Results.Ok(sessions);
    }

    // ------------------------------------------------------------------

    private static async Task<ResolvedToken?> ResolveTokenAsync(
        AppDbContext db, string hash, CancellationToken ct)
    {
        var conn = db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open)
            await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT tenant_id, user_id, token_id, family_id, was_revoked " +
            "FROM core.resolve_refresh_token(@hash)";

        var p = cmd.CreateParameter();
        p.ParameterName = "@hash";
        p.Value = hash;
        cmd.Parameters.Add(p);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;

        return new ResolvedToken(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2),
            reader.GetGuid(3), reader.GetBoolean(4));
    }

    private static async Task<(string Token, RefreshToken Row)> IssueRefreshAsync(
        AppDbContext db, User user, Guid familyId, HttpContext http, CancellationToken ct)
    {
        var token = TokenIssuer.GenerateRefreshToken();

        var row = new RefreshToken
        {
            TenantId = user.TenantId,
            UserId = user.Id,
            TokenHash = TokenIssuer.HashRefreshToken(token),
            FamilyId = familyId,
            ExpiresAt = DateTimeOffset.UtcNow.Add(TokenIssuer.RefreshTokenLifetime),
            UserAgent = Truncate(http.Request.Headers.UserAgent.ToString(), 512),
            IpAddress = http.Connection.RemoteIpAddress?.ToString(),
        };

        db.RefreshTokens.Add(row);
        await Task.CompletedTask;
        return (token, row);
    }

    private static object Describe(User u) => new
    {
        u.Id, u.Email, u.DisplayName, u.Role, u.Status, u.MfaEnabled, u.CategoryId,
    };

    private static string? Truncate(string? s, int max) =>
        string.IsNullOrEmpty(s) ? null : s.Length <= max ? s : s[..max];

    /// <summary>
    /// A real Argon2id hash of a value nobody knows, so the unknown-address
    /// path costs the same as the wrong-password path.
    /// </summary>
    private const string DummyHash =
        "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA==$" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    private sealed record ResolvedToken(
        Guid TenantId, Guid UserId, Guid TokenId, Guid FamilyId, bool WasRevoked);
}

public sealed record LoginRequest(string? Email, string? Password);
public sealed record RefreshRequest(string? RefreshToken);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);

public sealed record AuthResponse(
    string AccessToken,
    DateTimeOffset ExpiresAt,
    string RefreshToken,
    bool MustChangePassword,
    object User);

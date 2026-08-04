using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Shared.Auth;

/// <summary>
/// Issues access tokens, and generates and hashes refresh tokens.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY ACCESS TOKENS ARE SHORT
///
///  An access token is not checked against the database — that is the whole
///  point of a JWT, and it is why the API can answer without a round trip.
///  It also means the token cannot be withdrawn: once signed, it is valid
///  until it expires, whatever happens to the account.
///
///  Core promises that suspending a person removes their access to every
///  product at once. Fifteen minutes is the price of that promise. Make this
///  eight hours and a departed employee keeps working until dinner.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class TokenIssuer(IConfiguration config)
{
    public static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan RefreshTokenLifetime = TimeSpan.FromDays(14);

    private readonly string _key =
        config["Jwt:SigningKey"]
        ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
        ?? throw new InvalidOperationException("JWT signing key is not configured.");

    public sealed record AccessToken(string Value, DateTimeOffset ExpiresAt);

    public AccessToken IssueAccessToken(User user)
    {
        var expires = DateTimeOffset.UtcNow.Add(AccessTokenLifetime);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
            new(ClaimTypes.Role, user.Role),

            // TenantMiddleware reads this and nothing else. It is the reason a
            // client cannot choose its own tenant: the value is inside a
            // signature they cannot forge.
            new("tenant_id", user.TenantId.ToString()),

            // Distinguishes two tokens issued in the same second, and gives
            // something to log without logging the token itself.
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };

        // JsonWebTokenHandler, not JwtSecurityTokenHandler. The latter lives in
        // System.IdentityModel.Tokens.Jwt, which is only a transitive
        // dependency here and is being phased out; this one ships with the
        // JwtBearer package we already depend on directly.
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = config["Jwt:Issuer"],
            Audience = config["Jwt:Audience"],
            Subject = new ClaimsIdentity(claims),
            NotBefore = DateTime.UtcNow,
            Expires = expires.UtcDateTime,
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_key)),
                SecurityAlgorithms.HmacSha256),
        };

        return new AccessToken(new JsonWebTokenHandler().CreateToken(descriptor), expires);
    }

    /// <summary>
    /// 256 bits from a cryptographic RNG. Not a GUID: GUIDs are unique, which
    /// is not the same as unguessable, and several versions encode a timestamp.
    /// </summary>
    public static string GenerateRefreshToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
               .Replace('+', '-').Replace('/', '_').TrimEnd('=');

    /// <summary>
    /// SHA-256, deliberately not Argon2.
    ///
    /// Argon2 is slow on purpose, to make guessing a human-chosen password
    /// expensive. A refresh token is 256 random bits — there is nothing to
    /// guess, so a slow hash would only add latency to every renewal.
    /// </summary>
    public static string HashRefreshToken(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
}

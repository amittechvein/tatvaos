using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Tests.TokenTypes;

/// <summary>
/// Usage:  dotnet run --project tests/token-types
/// Exit:   0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    // Test values only.
    private const string Key = "token-types-test-key-at-least-32-characters";
    private const string Issuer = "https://core.tatvaos.test";
    private const string Audience = "tatvaos-test";

    private static int passed, failed;

    private static async Task<int> Main()
    {
        // No Mfa:EncryptionKey: MFA falls back to Jwt:SigningKey, so all three
        // share one key - the case the rule is about.
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:SigningKey"] = Key,
            ["Jwt:Issuer"] = Issuer,
            ["Jwt:Audience"] = Audience,
        }).Build();

        var issuer = new TokenIssuer(config);
        var tickets = new ConnectDownloadTicket(config);
        var totp = new TotpService(config);
        var user = new User { Email = "someone@example.test", DisplayName = "Someone", Role = "user", TenantId = Guid.NewGuid() };

        var access = issuer.IssueAccessToken(user).Value;
        var ticket = tickets.Issue(new ConnectDownloadTicket.Claim(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), user.Id));
        var challenge = totp.IssueChallenge(user.Id);

        // Correctly SIGNED with the shared key, but not carrying the right type.
        var jwtNoType = Jwt(typ: null);
        var jwtPlainType = Jwt(typ: "JWT");          // what every access token said before PR 346
        var jwtOtherType = Jwt(typ: "something-else+jwt");
        var ticketNoType = Ticket(type: null);        // what every ticket said before PR 346
        var ticketOtherType = Ticket(type: "some-other-use");
        var challengeOld = OldChallenge(user.Id);     // three segments, before PR 346
        var challengeOtherType = "other-type." + challenge["mfa-challenge.".Length..];

        Console.WriteLine();
        Console.WriteLine("  Token types — every verifier accepts its own type and nothing else");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════════");

        Section("each verifier accepts its own, current token");
        Ok("an access token is accepted as an access token", await IsAccessToken(access));
        Ok("...and says typ at+jwt in its header", new JsonWebToken(access).Typ == TokenIssuer.AccessTokenType);
        Ok("a download ticket is accepted as a ticket", tickets.Verify(ticket) is not null);
        Ok("an MFA challenge is accepted as a challenge", totp.ReadChallenge(challenge) == user.Id);
        Ok("...and starts with its type", challenge.StartsWith(TotpService.ChallengeType + ".", StringComparison.Ordinal));

        Section("no verifier accepts another type's token");
        Ok("the access verifier refuses a ticket", !await IsAccessToken(ticket));
        Ok("the access verifier refuses a challenge", !await IsAccessToken(challenge));
        Ok("the ticket verifier refuses an access token", tickets.Verify(access) is null);
        Ok("the ticket verifier refuses a challenge", tickets.Verify(challenge) is null);
        Ok("the challenge reader refuses an access token", totp.ReadChallenge(access) is null);
        Ok("the challenge reader refuses a ticket", totp.ReadChallenge(ticket) is null);

        Section("signed with the right key, wrong or missing type: refused (a fourth use of the key)");
        Ok("control: the hand-built JWT is accepted when it says at+jwt", await IsAccessToken(Jwt(typ: TokenIssuer.AccessTokenType)));
        Ok("a JWT with no typ is refused", !await IsAccessToken(jwtNoType));
        Ok("a JWT saying typ JWT (every token before PR 346) is refused", !await IsAccessToken(jwtPlainType));
        Ok("a JWT saying another +jwt type is refused", !await IsAccessToken(jwtOtherType));
        Ok("control: the hand-built ticket is accepted when it carries the ticket type", tickets.Verify(Ticket(type: ConnectDownloadTicket.Type)) is not null);
        Ok("a ticket body with no type is refused (every ticket before PR 346)", tickets.Verify(ticketNoType) is null);
        Ok("a ticket body with another type is refused", tickets.Verify(ticketOtherType) is null);
        Ok("a three-segment challenge (before PR 346) is refused", totp.ReadChallenge(challengeOld) is null);
        Ok("a challenge naming another type is refused", totp.ReadChallenge(challengeOtherType) is null);

        Console.WriteLine();
        Console.WriteLine("  ═════════════════════════════════════════════════════════════════");
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} checks" : $"  FAIL  {failed} of {passed + failed} checks");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;

        // ── the API's own validation, exactly as Program.cs configures it ──
        static async Task<bool> IsAccessToken(string token)
        {
            var r = await new JsonWebTokenHandler().ValidateTokenAsync(token,
                TokenIssuer.ValidationParameters(Key, Issuer, Audience));
            return r.IsValid;
        }

        // A JWT signed with the shared key, with the given typ header (null = none).
        string Jwt(string? typ)
        {
            var d = new SecurityTokenDescriptor
            {
                Issuer = Issuer,
                Audience = Audience,
                Claims = new Dictionary<string, object> { ["sub"] = user.Id.ToString(), ["tenant_id"] = user.TenantId.ToString() },
                Expires = DateTime.UtcNow.AddMinutes(5),
                SigningCredentials = new SigningCredentials(
                    new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Key)), SecurityAlgorithms.HmacSha256),
            };
            var h = new JsonWebTokenHandler();
            if (typ is not null) { d.TokenType = typ; return h.CreateToken(d); }
            // No typ at all: the handler always writes one, so build it by hand.
            var header = B64(JsonSerializer.SerializeToUtf8Bytes(new { alg = "HS256" }));
            var payload = B64(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
            {
                ["sub"] = user.Id.ToString(), ["tenant_id"] = user.TenantId.ToString(),
                ["iss"] = Issuer, ["aud"] = Audience,
                ["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(),
            }));
            var sig = B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Key), Encoding.ASCII.GetBytes($"{header}.{payload}")));
            return $"{header}.{payload}.{sig}";
        }

        // A ticket built exactly as ConnectDownloadTicket.Issue builds one, with
        // the given type field (null = absent, as before PR 346).
        static string Ticket(string? type)
        {
            var body = new Dictionary<string, object>
            {
                ["T"] = Guid.NewGuid(), ["M"] = Guid.NewGuid(), ["R"] = Guid.NewGuid(), ["U"] = Guid.NewGuid(),
                ["E"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(),
            };
            if (type is not null) body["Y"] = type;
            var b = B64(JsonSerializer.SerializeToUtf8Bytes(body));
            return $"{b}.{B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Key), Encoding.ASCII.GetBytes(b)))}";
        }

        // The challenge format before PR 346: {user}.{expiry}.{mac}, MAC as today.
        static string OldChallenge(Guid userId)
        {
            var bodyPart = $"{userId:N}.{DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds()}";
            var macKey = SHA256.HashData(Encoding.UTF8.GetBytes(Key));
            var mac = Convert.ToHexString(HMACSHA256.HashData(macKey, Encoding.UTF8.GetBytes($"mfa-challenge:{bodyPart}"))).ToLowerInvariant();
            return $"{bodyPart}.{mac}";
        }
    }

    private static string B64(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static void Section(string name)
    {
        Console.WriteLine();
        Console.WriteLine($"  {name}");
    }

    private static void Ok(string what, bool ok)
    {
        if (ok) { passed++; Console.WriteLine($"    ✓ {what}"); }
        else { failed++; Console.WriteLine($"    ✗ {what}"); }
    }
}

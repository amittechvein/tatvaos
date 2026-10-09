using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Access tokens for a service account acting AS one person in the customer's
/// domain (domain-wide delegation: the JWT's "sub").
///
/// ─────────────────────────────────────────────────────────────────────────
///  HOW. Google's two-legged flow for service accounts, by hand rather than
///  through a Google SDK (CONTRIBUTING: "does this need to exist?" - it is a
///  signed JWT and one POST):
///    1. a JWT: iss = the service account, sub = the person, scope = what we
///       ask for, aud = the token endpoint, valid one hour; RS256-signed
///    2. POSTed as grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
///    3. Google answers with an access token valid about an hour
///
///  SCOPES ARE CHECKED BEFORE ANYTHING IS SIGNED. A scope not in
///  GoogleScopes.Allowed (read-only, all of them) throws here; nothing
///  writable can be asked for, by mistake or otherwise.
///
///  CACHED per (account, person, scopes) until five minutes before expiry.
///  A large mailbox makes thousands of calls; one token request per call
///  would spend Google's quota on paperwork.
///
///  NEVER LOGGED, NEVER IN AN EXCEPTION. Neither the assertion nor the token
///  appears in any message this class produces. The one failure everybody
///  will meet - "unauthorized_client", delegation not granted for these
///  scopes - is turned into a sentence saying what the admin has to do.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GoogleTokenSource(HttpClient http, TimeProvider? clock = null)
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(1);
    private static readonly TimeSpan RenewBefore = TimeSpan.FromMinutes(5);

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly ConcurrentDictionary<(string, string, string), (string Token, DateTimeOffset Expires)> _cache = new();

    /// <summary>How many tokens were requested from Google. For tests and for the estimate's report.</summary>
    public int Requests => _requests;
    private int _requests;

    public async Task<string> GetTokenAsync(
        GoogleServiceAccount account, string subject, IReadOnlyCollection<string> scopes, CancellationToken ct)
    {
        if (scopes.Count == 0) throw new ArgumentException("at least one scope is needed", nameof(scopes));
        var refused = scopes.Where(s => !GoogleScopes.Allowed.Contains(s)).ToList();
        if (refused.Count > 0)
            throw new GoogleScopeRefusedException(
                $"refusing to ask Google for scope(s) not in GoogleScopes.Allowed (read-only only): {string.Join(", ", refused)}");
        if (string.IsNullOrWhiteSpace(subject)) throw new ArgumentException("the person to act as is required", nameof(subject));

        var scopeKey = string.Join(' ', scopes.Distinct().Order(StringComparer.Ordinal));
        var key = (account.ClientEmail, subject.Trim().ToLowerInvariant(), scopeKey);
        var now = _clock.GetUtcNow();
        if (_cache.TryGetValue(key, out var hit) && hit.Expires - RenewBefore > now) return hit.Token;

        var assertion = BuildAssertion(account, subject.Trim(), scopeKey, now);
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ["assertion"] = assertion,
        });

        Interlocked.Increment(ref _requests);
        using var resp = await http.PostAsync(account.TokenUri, form, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
            throw GoogleAuthException.From((int)resp.StatusCode, body, subject.Trim());

        TokenResponse? parsed;
        try { parsed = JsonSerializer.Deserialize<TokenResponse>(body); }
        catch (JsonException) { parsed = null; }
        if (parsed?.AccessToken is not { Length: > 0 } token)
            throw new GoogleAuthException((int)resp.StatusCode, "no_token", "Google's token answer had no access token in it");

        var expires = now + TimeSpan.FromSeconds(parsed.ExpiresIn is > 0 ? parsed.ExpiresIn.Value : 3600);
        _cache[key] = (token, expires);
        return token;
    }

    /// <summary>Forget a person's token - after a 401, when Google has revoked it early.</summary>
    public void Forget(GoogleServiceAccount account, string subject)
    {
        var s = subject.Trim().ToLowerInvariant();
        foreach (var k in _cache.Keys.Where(k => k.Item1 == account.ClientEmail && k.Item2 == s).ToList())
            _cache.TryRemove(k, out _);
    }

    private static string BuildAssertion(GoogleServiceAccount account, string subject, string scope, DateTimeOffset now)
    {
        var header = new Dictionary<string, string> { ["alg"] = "RS256", ["typ"] = "JWT" };
        if (account.KeyId is { Length: > 0 } kid) header["kid"] = kid;
        var iat = now.ToUnixTimeSeconds();
        var claims = new Dictionary<string, object>
        {
            ["iss"] = account.ClientEmail,
            ["sub"] = subject,
            ["scope"] = scope,
            ["aud"] = account.TokenUri,
            ["iat"] = iat,
            ["exp"] = iat + (long)Lifetime.TotalSeconds,
        };
        var signingInput = $"{B64(JsonSerializer.SerializeToUtf8Bytes(header))}.{B64(JsonSerializer.SerializeToUtf8Bytes(claims))}";
        return $"{signingInput}.{B64(account.SignRs256(Encoding.ASCII.GetBytes(signingInput)))}";
    }

    private static string B64(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed class TokenResponse
    {
        [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
        [JsonPropertyName("expires_in")] public int? ExpiresIn { get; set; }
    }
}

public sealed class GoogleScopeRefusedException(string message) : Exception(message);

/// <summary>
/// Google refused to issue a token. Carries Google's error CODE and a sentence
/// of our own - never the assertion, never Google's raw body.
/// </summary>
public sealed class GoogleAuthException(int status, string error, string message) : Exception(message)
{
    public int Status { get; } = status;
    /// <summary>Google's OAuth error code, e.g. unauthorized_client, invalid_grant.</summary>
    public string Error { get; } = error;

    internal static GoogleAuthException From(int status, string body, string subject)
    {
        string error = "unknown";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String)
                error = e.GetString() ?? "unknown";
        }
        catch (JsonException) { }

        // Our own words for the codes people will actually meet. Google's
        // error_description is deliberately not echoed: it is free text we do
        // not control, in a message that ends up in logs and on screens.
        var why = error switch
        {
            "unauthorized_client" =>
                "domain-wide delegation is not granted to this service account for these scopes. " +
                "In the Google Admin console: Security > Access and data control > API controls > " +
                "Manage domain-wide delegation, add the service account's client ID with exactly the scopes in GoogleScopes",
            "invalid_grant" =>
                $"Google would not act as {subject}: the person may not exist in this domain, may be suspended, " +
                "or the server's clock may be wrong",
            "invalid_client" => "Google does not recognise this service account or key; it may have been deleted or rotated",
            _ => $"Google refused a token (HTTP {status}, {error})",
        };
        return new GoogleAuthException(status, error, why);
    }
}

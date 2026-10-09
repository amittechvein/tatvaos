// ============================================================================
//  THE GOOGLE CLIENT, AGAINST A FAKE GOOGLE THAT CHECKS WHAT IT IS SENT
// ============================================================================
//
//  apps/api/Shared/Google (migration design, section 3.1). There is no
//  Google test account yet, and a test that needs the internet is a test that
//  does not run in CI. So this puts a fake Google behind the client's own
//  HttpClient (an HttpMessageHandler: every byte the client would send, it
//  receives) and asserts on what the client DID:
//
//    token       the JWT verifies against the key's PUBLIC half; iss, sub,
//                aud, scope and an hour's lifetime are right; the grant type
//                is the jwt-bearer one
//    cache       a second call for the same person and scopes asks Google
//                for nothing; another person does
//    scopes      a writable scope is refused BEFORE anything is signed or sent
//    refusal     "unauthorized_client" becomes a sentence naming the Admin
//                console, and carries neither the assertion nor Google's text
//    throttling  429 with Retry-After waits what Google said, then succeeds;
//                403 rateLimitExceeded is retried; 500 forever gives up after
//                GoogleApi.MaxAttempts; 404 is not retried at all
//    401         one fresh token, then a real refusal
//    no token    an error page echoing the bearer token does not put the
//                token into the exception message
//    key file    an OAuth client secret is refused by name; ToString() of an
//                account never shows the key
//    Gmail       profile and labels-with-counts parse, as phase 0 needs
//
//  No test framework, like tests/tenant-filters: `dotnet run` and read the
//  last line; the exit code is the verdict. TATVAOS_ROOT is not needed: to
//  see it fail (house rule 6), build it against a copy of apps/api with a
//  guard removed - the PR that added this test records that run.
// ============================================================================

using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TatvaOS.Api.Shared.Google;

var passed = 0; var failed = 0;
void Ok(string what) { passed++; Console.WriteLine($"  ok    {what}"); }
void Fail(string what) { failed++; Console.WriteLine($"  FAIL  {what}"); }
void Same<T>(string what, T got, T want)
{
    if (EqualityComparer<T>.Default.Equals(got, want)) Ok($"{what}  [got {got}]");
    else Fail($"{what} - got [{got}], wanted [{want}]");
}
void Check(string what, bool cond, string detail = "") { if (cond) Ok(what); else Fail($"{what}{(detail.Length > 0 ? " - " + detail : "")}"); }
async Task<Exception?> Throws(Func<Task> f) { try { await f(); return null; } catch (Exception ex) { return ex; } }

Console.WriteLine("\n  Google client");

// ---- A key made for this run, and the account built from it ------------------
using var rsa = RSA.Create(2048);
var keyJson = JsonSerializer.Serialize(new Dictionary<string, string>
{
    ["type"] = "service_account",
    ["client_email"] = "migration@tatvaos-test.iam.gserviceaccount.com",
    ["private_key_id"] = "kid-test-1",
    ["private_key"] = rsa.ExportPkcs8PrivateKeyPem(),
    ["token_uri"] = "https://fake-google.test/token",
});
var fake = new FakeGoogle(rsa);
var http = new HttpClient(fake);
var waits = new List<TimeSpan>();
var tokens = new GoogleTokenSource(http);
var api = new GoogleApi(http, tokens,
    new GoogleEndpoints { Gmail = new Uri("https://fake-google.test/gmail/v1/") },
    (d, _) => { waits.Add(d); return Task.CompletedTask; });
var gmail = new GmailClient(api);
using var account = GoogleServiceAccount.FromJson(keyJson);
string[] read = [GoogleScopes.GmailReadOnly];

Console.WriteLine("\n>> key file");
Check("ToString() names the account and shows no key",
    account.ToString() == "Google service account migration@tatvaos-test.iam.gserviceaccount.com"
    && !account.ToString().Contains("PRIVATE"));
var oauthSecret = """{"installed":{"client_id":"x.apps.googleusercontent.com","client_secret":"GOCSPX-notreal"}}""";
var notSa = Record(() => GoogleServiceAccount.FromJson(oauthSecret));
Check("an OAuth client secret is refused, by name",
    notSa is GoogleKeyFormatException && notSa.Message.Contains("OAuth client secret") && !notSa.Message.Contains("GOCSPX"),
    notSa?.Message ?? "no exception");
Check("a file that is not JSON is refused without quoting it",
    Record(() => GoogleServiceAccount.FromJson("-----BEGIN NOT JSON")) is GoogleKeyFormatException { Message: "the key is not JSON" });

Console.WriteLine("\n>> token");
var t1 = await Throws(async () => await tokens.GetTokenAsync(account, "alice@customer.test", read, CancellationToken.None));
Check("a read-only scope gets a token", t1 is null, t1?.Message ?? "");
Same("Google was asked once", fake.TokenRequests, 1);
var jwt = fake.LastAssertion;
Check("the assertion's signature verifies against the PUBLIC key", jwt is not null && fake.Verify(jwt));
var claims = jwt is null ? default : JsonDocument.Parse(FakeGoogle.Unb64(jwt.Split('.')[1])).RootElement;
Same("iss is the service account", claims.ValueKind == JsonValueKind.Object ? claims.GetProperty("iss").GetString() : null, "migration@tatvaos-test.iam.gserviceaccount.com");
Same("sub is the person acted as", claims.ValueKind == JsonValueKind.Object ? claims.GetProperty("sub").GetString() : null, "alice@customer.test");
Same("aud is the token endpoint", claims.ValueKind == JsonValueKind.Object ? claims.GetProperty("aud").GetString() : null, "https://fake-google.test/token");
Same("scope is exactly what was asked", claims.ValueKind == JsonValueKind.Object ? claims.GetProperty("scope").GetString() : null, GoogleScopes.GmailReadOnly);
Same("valid for one hour", claims.ValueKind == JsonValueKind.Object ? claims.GetProperty("exp").GetInt64() - claims.GetProperty("iat").GetInt64() : 0, 3600L);
Same("the grant type is jwt-bearer", fake.LastGrantType, "urn:ietf:params:oauth:grant-type:jwt-bearer");

await tokens.GetTokenAsync(account, "Alice@Customer.test", [GoogleScopes.GmailReadOnly], CancellationToken.None);
Same("the same person again (any case) is served from the cache", fake.TokenRequests, 1);
await tokens.GetTokenAsync(account, "bob@customer.test", [GoogleScopes.GmailReadOnly], CancellationToken.None);
Same("another person asks Google again", fake.TokenRequests, 2);

Console.WriteLine("\n>> scopes");
var before = fake.TokenRequests;
var w = await Throws(() => tokens.GetTokenAsync(account, "alice@customer.test",
    ["https://www.googleapis.com/auth/gmail.modify"], CancellationToken.None));
Check("a writable scope is refused", w is GoogleScopeRefusedException, w?.GetType().Name ?? "no exception");
Same("...before anything was sent to Google", fake.TokenRequests, before);

Console.WriteLine("\n>> refusal");
var nd = await Throws(() => tokens.GetTokenAsync(account, "nodelegation@customer.test", [GoogleScopes.GmailReadOnly], CancellationToken.None));
Check("unauthorized_client is a GoogleAuthException naming the Admin console",
    nd is GoogleAuthException { Error: "unauthorized_client" } && nd.Message.Contains("Admin console"), nd?.Message ?? "no exception");
Check("...and carries neither the assertion nor Google's own text",
    nd is not null && !nd.Message.Contains("eyJ") && !nd.Message.Contains(FakeGoogle.GoogleOwnText));

Console.WriteLine("\n>> throttling");
waits.Clear(); fake.Calls.Clear();
var labels = await gmail.ListLabelsAsync(account, "alice@customer.test", CancellationToken.None);
Same("429 then OK: labels.list asked twice", fake.Calls.Count(c => c.EndsWith("/labels")), 2);
Same("...and waited what Retry-After said", waits.FirstOrDefault(), TimeSpan.FromSeconds(7));
Same("403 rateLimitExceeded then OK: the INBOX label asked twice", fake.Calls.Count(c => c.EndsWith("/labels/INBOX")), 2);

waits.Clear(); fake.Calls.Clear();
var down = await Throws(() => api.GetJsonAsync(account, "alice@customer.test", [GoogleScopes.GmailReadOnly],
    new Uri("https://fake-google.test/gmail/v1/always500"), CancellationToken.None));
Check("500 forever fails as GoogleApiException 500", down is GoogleApiException { Status: 500 }, down?.Message ?? "");
Same("...after exactly MaxAttempts calls", fake.Calls.Count, GoogleApi.MaxAttempts);
Same("...with a wait between each", waits.Count, GoogleApi.MaxAttempts - 1);
Check("...growing, and never above 65 s", waits.Count > 1 && waits[^1] > waits[0] && waits.All(x => x <= TimeSpan.FromSeconds(65)),
    string.Join(", ", waits.Select(x => x.TotalSeconds.ToString("0.0"))));

fake.Calls.Clear();
var nf = await Throws(() => api.GetJsonAsync(account, "alice@customer.test", [GoogleScopes.GmailReadOnly],
    new Uri("https://fake-google.test/gmail/v1/missing"), CancellationToken.None));
Check("404 fails at once", nf is GoogleApiException { Status: 404, Reason: "notFound", Attempts: 1 }, nf?.Message ?? "");
Same("...after one call", fake.Calls.Count, 1);

Console.WriteLine("\n>> 401 and tokens in errors");
fake.Calls.Clear(); before = fake.TokenRequests;
var revoked = await Throws(() => api.GetJsonAsync(account, "alice@customer.test", [GoogleScopes.GmailReadOnly],
    new Uri("https://fake-google.test/gmail/v1/always401"), CancellationToken.None));
Check("401 twice is a refusal", revoked is GoogleApiException { Status: 401 }, revoked?.Message ?? "");
Same("...after one fresh token", fake.TokenRequests - before, 1);
var echo = await Throws(() => api.GetJsonAsync(account, "alice@customer.test", [GoogleScopes.GmailReadOnly],
    new Uri("https://fake-google.test/gmail/v1/echo-token"), CancellationToken.None));
Check("an error page echoing the bearer token: the exception does not carry it",
    echo is GoogleApiException && !echo.Message.Contains("ya29.") && echo.Message.Contains("[redacted]"), echo?.Message ?? "");

Console.WriteLine("\n>> Gmail");
var profile = await gmail.GetProfileAsync(account, "alice@customer.test", CancellationToken.None);
Same("profile: messages", profile.MessagesTotal, 4321L);
Same("labels: how many", labels.Count, 3);
Same("labels: INBOX count", labels.FirstOrDefault(l => l.Id == "INBOX")?.MessagesTotal, 120L);
Same("labels: a user label keeps its name and type",
    labels.FirstOrDefault(l => l.Id == "Label_7") is { } l7 ? $"{l7.Name}/{l7.Type}/{l7.MessagesTotal}" : null, "Invoices/user/42");

Console.WriteLine($"\n  -----------------------------------------------");
if (failed == 0) { Console.WriteLine($"  PASS  {passed} checks\n"); return 0; }
Console.WriteLine($"  FAIL  {failed} of {passed + failed} checks\n"); return 1;

static Exception? Record(Action a) { try { a(); return null; } catch (Exception ex) { return ex; } }

// ============================================================================
//  The fake. Answers like Google for what the client asks, checks the token
//  request's signature, and records every call.
// ============================================================================
sealed class FakeGoogle(RSA key) : HttpMessageHandler
{
    public const string GoogleOwnText = "Client is unauthorized to retrieve access tokens using this method";
    public int TokenRequests;
    public string? LastAssertion, LastGrantType;
    public readonly List<string> Calls = [];
    private readonly Dictionary<string, int> _seen = [];

    public bool Verify(string jwt)
    {
        var p = jwt.Split('.');
        return p.Length == 3 && key.VerifyData(Encoding.ASCII.GetBytes($"{p[0]}.{p[1]}"), Unb64(p[2]),
            HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    }

    public static byte[] Unb64(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s + new string('=', (4 - s.Length % 4) % 4));
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var path = req.RequestUri!.AbsolutePath;
        if (path == "/token")
        {
            TokenRequests++;
            var form = (await req.Content!.ReadAsStringAsync(ct)).Split('&')
                .Select(kv => kv.Split('=', 2)).ToDictionary(kv => kv[0], kv => Uri.UnescapeDataString(kv[1]));
            LastGrantType = form.GetValueOrDefault("grant_type");
            LastAssertion = form.GetValueOrDefault("assertion");
            if (LastAssertion is null || !Verify(LastAssertion)) return Json(400, """{"error":"invalid_grant"}""");
            var sub = JsonDocument.Parse(Unb64(LastAssertion.Split('.')[1])).RootElement.GetProperty("sub").GetString();
            if (sub == "nodelegation@customer.test")
                return Json(401, $$"""{"error":"unauthorized_client","error_description":"{{GoogleOwnText}}"}""");
            return Json(200, $$"""{"access_token":"ya29.fake-{{sub}}-{{TokenRequests}}","expires_in":3599,"token_type":"Bearer"}""");
        }

        Calls.Add(path);
        var auth = req.Headers.Authorization?.Parameter ?? "";
        if (!auth.StartsWith("ya29.fake-")) return Json(401, """{"error":{"code":401,"message":"no token"}}""");
        int Seen() { _seen[path] = _seen.GetValueOrDefault(path) + 1; return _seen[path]; }

        switch (path)
        {
            case "/gmail/v1/users/alice%40customer.test/profile":
            case "/gmail/v1/users/alice@customer.test/profile":
                return Json(200, """{"emailAddress":"alice@customer.test","messagesTotal":4321,"threadsTotal":3000,"historyId":"99"}""");
            case var p when p.EndsWith("/labels"):
                if (Seen() == 1)
                {
                    var r = Json(429, """{"error":{"code":429,"message":"Too many requests","errors":[{"reason":"rateLimitExceeded"}]}}""");
                    r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
                    return r;
                }
                return Json(200, """{"labels":[{"id":"INBOX","name":"INBOX","type":"system"},{"id":"IMPORTANT","name":"IMPORTANT","type":"system"},{"id":"Label_7","name":"Invoices","type":"user"}]}""");
            case var p when p.EndsWith("/labels/INBOX"):
                if (Seen() == 1)
                    return Json(403, """{"error":{"code":403,"message":"User rate limit exceeded","errors":[{"reason":"rateLimitExceeded"}]}}""");
                return Json(200, """{"id":"INBOX","messagesTotal":120,"threadsTotal":100}""");
            case var p when p.EndsWith("/labels/IMPORTANT"):
                return Json(200, """{"id":"IMPORTANT","messagesTotal":30,"threadsTotal":25}""");
            case var p when p.EndsWith("/labels/Label_7"):
                return Json(200, """{"id":"Label_7","messagesTotal":42,"threadsTotal":40}""");
            case "/gmail/v1/always500":
                return Json(500, """{"error":{"code":500,"message":"Backend Error","errors":[{"reason":"backendError"}]}}""");
            case "/gmail/v1/always401":
                return Json(401, """{"error":{"code":401,"message":"Invalid Credentials","errors":[{"reason":"authError"}]}}""");
            case "/gmail/v1/echo-token":
                return Json(403, $$$"""{"error":{"code":403,"message":"proxy refused Authorization: Bearer {{{auth}}}","errors":[{"reason":"forbidden"}]}}""");
            default:
                return Json(404, """{"error":{"code":404,"message":"Requested entity was not found.","errors":[{"reason":"notFound"}]}}""");
        }
    }

    private static HttpResponseMessage Json(int status, string body) =>
        new((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
}

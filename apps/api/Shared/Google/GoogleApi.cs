using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Shared.Google;

/// <summary>
/// Every call TatvaOS makes to a Google API goes through here: ONE
/// implementation of retry, backoff and rate-limit handling, not one per API
/// (migration design, section 3.1).
///
/// ─────────────────────────────────────────────────────────────────────────
///  BEING THROTTLED IS THE NORMAL CASE, NOT AN ERROR. On a large mailbox
///  Google will say 429, or 403 with reason rateLimitExceeded /
///  userRateLimitExceeded, many times. Those, and 500/502/503/504, are
///  retried: Retry-After when Google sends one (capped), otherwise
///  exponential backoff with jitter. After MaxAttempts the call fails with
///  the last status, and the job runner's own retry takes over from there.
///
///  Everything else - 400, 401, 404, a 403 that is a real refusal - is not
///  retried: asking again gets the same answer and spends quota doing it.
///
///  The limits themselves (how many calls, how many bytes a day) are NOT
///  written down here. Design 3.1: "read Google's current rate and size limits
///  at build time, not from any document including this one". This class
///  reacts to what Google says rather than predicting it.
///
///  NO TOKEN IN ANY MESSAGE. GoogleApiException carries the status, Google's
///  error reason and a clipped message, with anything token-shaped blanked -
///  a proxy or an error page could echo the Authorization header back, and
///  these messages reach logs and migration.jobs.last_error.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class GoogleApi(HttpClient http, GoogleTokenSource tokens, GoogleEndpoints? endpoints = null,
    Func<TimeSpan, CancellationToken, Task>? delay = null)
{
    public const int MaxAttempts = 6;
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(64);

    private readonly Func<TimeSpan, CancellationToken, Task> _delay = delay ?? Task.Delay;

    public GoogleEndpoints Endpoints { get; } = endpoints ?? new GoogleEndpoints();
    public GoogleTokenSource Tokens => tokens;

    /// <summary>
    /// GET a Google JSON resource, acting as <paramref name="subject"/> with
    /// <paramref name="scopes"/>. Returns the parsed body; the caller disposes it.
    /// </summary>
    public async Task<JsonDocument> GetJsonAsync(
        GoogleServiceAccount account, string subject, IReadOnlyCollection<string> scopes, Uri url, CancellationToken ct)
    {
        var refreshedOnce = false;
        for (var attempt = 1; ; attempt++)
        {
            var token = await tokens.GetTokenAsync(account, subject, scopes, ct);
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (resp.IsSuccessStatusCode)
                return await JsonDocument.ParseAsync(await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);

            var status = (int)resp.StatusCode;
            var body = await resp.Content.ReadAsStringAsync(ct);
            var (reason, message) = ReadError(body);

            // A token Google revoked before its hour was up: get a new one,
            // once. A second 401 is a real refusal.
            if (resp.StatusCode == HttpStatusCode.Unauthorized && !refreshedOnce)
            {
                refreshedOnce = true;
                tokens.Forget(account, subject);
                attempt--;
                continue;
            }

            if (!Retryable(status, reason) || attempt >= MaxAttempts)
                throw new GoogleApiException(status, reason, message, attempt);

            await _delay(WaitBefore(attempt, resp.Headers.RetryAfter), ct);
        }
    }

    internal static bool Retryable(int status, string? reason) =>
        status is 429 or 500 or 502 or 503 or 504
        || (status == 403 && reason is "rateLimitExceeded" or "userRateLimitExceeded");

    internal static TimeSpan WaitBefore(int attempt, RetryConditionHeaderValue? retryAfter)
    {
        var said = retryAfter?.Delta
                   ?? (retryAfter?.Date is DateTimeOffset at ? at - DateTimeOffset.UtcNow : null);
        if (said is TimeSpan s && s > TimeSpan.Zero) return s < MaxRetryAfter ? s : MaxRetryAfter;

        // 1 s, 2 s, 4 s ... capped, plus up to a second of jitter so many
        // jobs throttled together do not all come back on the same tick.
        var exp = TimeSpan.FromSeconds(Math.Pow(2, attempt - 1));
        if (exp > MaxBackoff) exp = MaxBackoff;
        return exp + TimeSpan.FromMilliseconds(Random.Shared.Next(0, 1000));
    }

    /// <summary>Google's error body: {"error": {"code", "message", "errors": [{"reason"}], "status"}}.</summary>
    private static (string? Reason, string? Message) ReadError(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("error", out var e) || e.ValueKind != JsonValueKind.Object)
                return (null, null);
            string? reason = null;
            if (e.TryGetProperty("errors", out var errs) && errs.ValueKind == JsonValueKind.Array && errs.GetArrayLength() > 0
                && errs[0].TryGetProperty("reason", out var r) && r.ValueKind == JsonValueKind.String)
                reason = r.GetString();
            else if (e.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
                reason = st.GetString();
            var message = e.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : null;
            return (reason, message);
        }
        catch (JsonException) { return (null, null); }
    }
}

/// <summary>Where the Google APIs are. Google's own, unless a test points them at a fake.</summary>
public sealed class GoogleEndpoints
{
    public Uri Gmail { get; init; } = new("https://gmail.googleapis.com/gmail/v1/");
    public Uri Drive { get; init; } = new("https://www.googleapis.com/drive/v3/");
    public Uri Directory { get; init; } = new("https://admin.googleapis.com/admin/directory/v1/");
    public Uri People { get; init; } = new("https://people.googleapis.com/v1/");
    public Uri Calendar { get; init; } = new("https://www.googleapis.com/calendar/v3/");
}

/// <summary>A Google API call that failed for good. Never carries a token.</summary>
public sealed class GoogleApiException(int status, string? reason, string? googleMessage, int attempts)
    : Exception(Compose(status, reason, googleMessage, attempts))
{
    public int Status { get; } = status;
    /// <summary>Google's reason, e.g. notFound, rateLimitExceeded, failedPrecondition.</summary>
    public string? Reason { get; } = reason;
    public int Attempts { get; } = attempts;

    private static readonly Regex Tokenish = new(
        @"ya29\.[A-Za-z0-9_\-\.]+|Bearer\s+\S+|[A-Za-z0-9+/=_\-]{40,}", RegexOptions.Compiled);

    private static string Compose(int status, string? reason, string? message, int attempts)
    {
        var said = message is null ? "" : Tokenish.Replace(message, "[redacted]");
        if (said.Length > 300) said = said[..300];
        return $"Google API HTTP {status}{(reason is null ? "" : $" ({reason})")}" +
               $"{(attempts > 1 ? $" after {attempts} attempts" : "")}{(said.Length > 0 ? $": {said}" : "")}";
    }
}

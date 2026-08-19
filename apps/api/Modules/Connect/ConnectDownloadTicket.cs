using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// A short-lived, signed permission to fetch ONE recording.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS: A BROWSER CANNOT PUT A HEADER ON A DOWNLOAD.
///
///  This platform holds the access token in memory and sends it as
///  `Authorization: Bearer` — deliberately, and lib/auth.tsx says so at the
///  top: "Not localStorage, not sessionStorage, not a readable cookie."
///
///  The consequence was missed when the download button was written. A plain
///  <a href> is a NAVIGATION: the browser sends cookies and nothing else, so
///  the request arrived with no Authorization header at a route requiring
///  one, and answered 401 every time. The button could never have worked, and
///  the comment beside it asserted that a session cookie would carry it —
///  which was never checked against the file that says the opposite.
///
///  The two obvious repairs are both worse:
///
///    • fetch it with authedFetch and hand the browser a blob. Fine for an
///      hour of audio at ~30 MB; hopeless for video, which is ~500 MB an
///      hour, and it gives up range requests, so nobody can skip to the last
///      five minutes of a two-hour recording without downloading all of it.
///
///    • put the access token in a cookie. That is the design decision this
///      product made in the other direction, on purpose.
///
///  So: a signed ticket in the query string, which is what every object store
///  does for exactly this problem. VERIFICATION IS THE CONTROL, NOT
///  REACHABILITY — the same sentence already written at the top of
///  ConnectWebhookEndpoints, for the same reason.
///
///  WHAT THE TICKET IS NOT: it is not the authorisation. It names a subject
///  and a tenant, both signed, and the download route then re-checks
///  everything through ordinary RLS-scoped queries — that the recording still
///  exists, is still ready, still belongs to that meeting, and that the person
///  named was actually in it. A stolen ticket therefore buys what its holder
///  could already have had, for five minutes, on one recording.
///
///  NOT SINGLE-USE, and that is deliberate rather than an oversight: a range
///  request is several GETs with the same URL, so a one-shot ticket would
///  break seeking — the exact thing it was introduced to preserve. The
///  control is the five-minute expiry.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ConnectDownloadTicket(IConfiguration config)
{
    /// <summary>
    /// Long enough to start a download on a slow connection, short enough that
    /// a URL in somebody's browser history is worthless by the time they get
    /// back to it. An already-started transfer is unaffected by expiry.
    /// </summary>
    private static readonly TimeSpan Life = TimeSpan.FromMinutes(5);

    private readonly byte[] _key = Encoding.UTF8.GetBytes(
        config["Jwt:SigningKey"] ?? throw new InvalidOperationException(
            "Jwt:SigningKey is required to sign recording downloads."));

    public sealed record Claim(Guid TenantId, Guid MeetingId, Guid RecordingId, Guid UserId);

    public string Issue(Claim claim)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new Body
        {
            T = claim.TenantId,
            M = claim.MeetingId,
            R = claim.RecordingId,
            U = claim.UserId,
            E = DateTimeOffset.UtcNow.Add(Life).ToUnixTimeSeconds(),
        });

        var body = ToBase64Url(payload);
        return $"{body}.{ToBase64Url(Sign(body))}";
    }

    public Claim? Verify(string? ticket)
    {
        if (string.IsNullOrWhiteSpace(ticket)) return null;

        var dot = ticket.IndexOf('.');
        if (dot <= 0 || dot == ticket.Length - 1) return null;

        var body = ticket[..dot];
        byte[] provided;
        try { provided = FromBase64Url(ticket[(dot + 1)..]); }
        catch (FormatException) { return null; }

        // Constant time, so a wrong signature cannot be narrowed down by
        // measuring how long the comparison took.
        if (!CryptographicOperations.FixedTimeEquals(Sign(body), provided)) return null;

        Body? parsed;
        try { parsed = JsonSerializer.Deserialize<Body>(FromBase64Url(body)); }
        catch (Exception e) when (e is JsonException or FormatException) { return null; }
        if (parsed is null) return null;

        // Signature checked BEFORE expiry, and expiry before anything is
        // returned: an unsigned payload's expiry claim is worth nothing.
        if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > parsed.E) return null;
        if (parsed.T == Guid.Empty || parsed.M == Guid.Empty || parsed.R == Guid.Empty) return null;

        return new Claim(parsed.T, parsed.M, parsed.R, parsed.U);
    }

    private byte[] Sign(string body)
    {
        using var hmac = new HMACSHA256(_key);
        return hmac.ComputeHash(Encoding.ASCII.GetBytes(body));
    }

    // Base64url without padding, so the ticket survives a query string
    // untouched — '+' in a URL is a space, and '=' has to be escaped.
    private static string ToBase64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    /// <summary>One-letter names: this goes in a URL, and every byte of it is
    /// base64 of this JSON.</summary>
    private sealed class Body
    {
        public Guid T { get; set; }
        public Guid M { get; set; }
        public Guid R { get; set; }
        public Guid U { get; set; }
        public long E { get; set; }
    }
}

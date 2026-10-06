using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// The Download my data link (build plan §4.2; Mr. Singh's conditions on PR
/// 319, 26 Sept 2026: "the download needs the person signed in, and the link
/// expires").
///
/// BOTH. The person must be signed in to GET a link (POST /api/me/export/link);
/// the link is then a signed, ten-minute, ONE-USE ticket the browser follows
/// as a plain navigation — so a 10 GB zip streams straight to their disk
/// instead of being collected in the page's memory, which a bearer-token
/// fetch would force (the recording ticket's reasoning, ConnectDownloadTicket).
///
/// One use, unlike the recording ticket: a zip built on the fly cannot be
/// resumed or ranged, so there is nothing a second GET is for. The nonce's
/// hash lives on the account (personal_accounts.export_nonce_hash); using the
/// link clears it, and asking for a new link replaces it — so an old link in
/// someone's history is dead the moment it is used or superseded.
///
/// One export a day, counted when a download STARTS (last_export_at), so a
/// link that was never followed does not cost the person their day.
/// </summary>
public sealed class PersonalExportLink(IConfiguration config)
{
    public static readonly TimeSpan Life = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan OncePer = TimeSpan.FromDays(1);

    private readonly byte[] _key = Encoding.UTF8.GetBytes(
        config["Jwt:SigningKey"] ?? throw new InvalidOperationException("Jwt:SigningKey is required to sign export links."));

    public sealed record Claim(Guid UserId, string Nonce, DateTimeOffset ExpiresAt);

    /// <summary>A new ticket and the hash of its nonce (to store on the account).</summary>
    public (string Ticket, string NonceHash, DateTimeOffset ExpiresAt) Issue(Guid userId)
    {
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var exp = DateTimeOffset.UtcNow.Add(Life);
        var body = B64(JsonSerializer.SerializeToUtf8Bytes(new Body { U = userId, N = nonce, E = exp.ToUnixTimeSeconds() }));
        return ($"{body}.{B64(Sign(body))}", HashNonce(nonce), exp);
    }

    /// <summary>Null if forged, malformed or expired. Whether it is still UNUSED is the caller's check.</summary>
    public Claim? Verify(string? ticket)
    {
        if (string.IsNullOrWhiteSpace(ticket)) return null;
        var dot = ticket.IndexOf('.');
        if (dot <= 0 || dot == ticket.Length - 1) return null;
        var body = ticket[..dot];
        byte[] sig;
        try { sig = UnB64(ticket[(dot + 1)..]); } catch (FormatException) { return null; }
        if (!CryptographicOperations.FixedTimeEquals(Sign(body), sig)) return null;
        Body? b;
        try { b = JsonSerializer.Deserialize<Body>(UnB64(body)); } catch (Exception e) when (e is JsonException or FormatException) { return null; }
        if (b is null || b.U == Guid.Empty || string.IsNullOrEmpty(b.N)) return null;
        var exp = DateTimeOffset.FromUnixTimeSeconds(b.E);
        return DateTimeOffset.UtcNow > exp ? null : new Claim(b.U, b.N, exp);
    }

    public static string HashNonce(string nonce) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("export:" + nonce))).ToLowerInvariant();

    private byte[] Sign(string body)
    {
        using var h = new HMACSHA256(_key);
        return h.ComputeHash(Encoding.ASCII.GetBytes("personal-export:" + body));
    }

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] UnB64(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    private sealed class Body { public Guid U { get; set; } public string N { get; set; } = ""; public long E { get; set; } }
}

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// The VERP bounce-address format, in ONE place.
///
/// A bounce address is:  &lt;idHex&gt;.&lt;keyId&gt;.&lt;ts&gt;.&lt;sig&gt;@&lt;domain&gt;
///   idHex : api_sends row id as 32 lowercase hex (Guid "N") — the correlation key
///   keyId : which secret in the keyset signed it (Bounce:KeyId names the current one)
///   ts    : send-day stamp — whole days since the Unix epoch — for expiry
///   sig   : first 8 bytes of HMAC-SHA256(secret, "idHex.keyId.ts"), 16 lowercase hex
///
/// Build() signs; Verify() checks. Three callers used to each carry their own
/// copy of this arithmetic — the send API (signs), the RCPT-time policy gate
/// (verifies), and now the intake (verifies again, defence in depth). Three
/// copies of one HMAC construction is exactly how a signer and a verifier drift
/// and every bounce in flight starts failing — the keyset bug was one such
/// drift, caught in review. This type is the single definition all three share:
/// change the format here and every caller changes with it, or none does.
/// </summary>
public static class BounceAddress
{
    // sig is the first 8 bytes of the HMAC → 16 hex chars in the address.
    private const int SigBytes = 8;

    // Expiry window enforced by Verify(). 30 days is generous against the
    // ~5-day DSN retry reality; a captured address is long dead before it could
    // be replayed at leisure. Up to 1 day of skew INTO THE FUTURE is tolerated
    // (a receiver's clock, or a send that straddles midnight UTC).
    private const long MaxAgeDays = 30;
    private const long MaxFutureDays = 1;

    /// <summary>
    /// Shape gate: 32-hex id . keyid . ts . 16-hex sig. Compiled because every
    /// inbound RCPT on a public catch-all reaches it. It is the CHEAP first
    /// check — anything not this shape is refused before a byte is hashed.
    /// keyId is [A-Za-z0-9]{1,16}, which also keeps it from escaping the
    /// Bounce:Keys:&lt;keyId&gt; config path it is looked up through.
    /// </summary>
    public static readonly Regex LocalPart =
        new(@"^([0-9a-f]{32})\.([A-Za-z0-9]{1,16})\.([0-9]{1,7})\.([0-9a-f]{16})$",
            RegexOptions.Compiled);

    /// <summary>The outcome of Verify(). Only Valid may be let through.</summary>
    public enum Verdict
    {
        Valid,        // shape, key, age and signature all good
        Malformed,    // not the bounce-address shape at all
        UnknownKey,   // well-formed, but this server holds no secret for its keyId
        Expired,      // signed too long ago (or too far in the future)
        BadSignature, // shape and key good, but the HMAC does not match
    }

    /// <summary>
    /// A Verify() result. Id and KeyId are filled in as soon as the shape
    /// parses (i.e. for everything but Malformed), so a caller can log WHICH
    /// row/key a rejected address named without re-parsing it.
    /// </summary>
    public readonly record struct Result(Verdict Verdict, Guid Id, string KeyId);

    /// <summary>
    /// Build the full VERP address the send API stamps as the envelope sender.
    /// Signs "idHex.keyId.ts" — the exact string Verify() recomputes.
    /// </summary>
    public static string Build(Guid id, string keyId, string secret, string domain, DateTimeOffset now)
    {
        var idHex = id.ToString("N");                 // 32 lowercase hex, no hyphens
        var ts = DaysSinceEpoch(now).ToString(CultureInfo.InvariantCulture);
        var sigHex = Convert.ToHexString(HmacBytes(idHex, keyId, ts, secret)).ToLowerInvariant();
        return $"{idHex}.{keyId}.{ts}.{sigHex}@{domain}";
    }

    /// <summary>
    /// Verify a full recipient address ("local@domain" — the domain itself is
    /// not checked here; the caller has already matched it against Bounce:Domain).
    /// keyLookup returns the secret for a keyId, or null/empty when this server
    /// holds none (an unset keyset, or a key retired beyond its window). Either
    /// way the address is REJECTED, never accepted: a missing key is loudly
    /// wrong, not silently allowed — once the domain is a live relay, "can't
    /// check, so allow" would turn the whole subdomain into an open catch-all
    /// that looked healthy while doing it.
    /// </summary>
    public static Result Verify(string recipient, Func<string, string?> keyLookup, DateTimeOffset now)
    {
        var at = recipient.LastIndexOf('@');
        var local = at > 0 ? recipient[..at] : recipient;

        var m = LocalPart.Match(local);
        if (!m.Success)
            return new Result(Verdict.Malformed, Guid.Empty, string.Empty);

        var idHex = m.Groups[1].Value;
        var keyId = m.Groups[2].Value;
        var ts    = m.Groups[3].Value;
        var sig   = m.Groups[4].Value;

        // idHex is 32 hex from the shape gate, so this always parses.
        var id = Guid.ParseExact(idHex, "N");

        // KEYSET, not a single secret. The address names WHICH key signed it,
        // and a RETIRED key must still verify bounces already in flight — a DSN
        // can arrive days after a rotation, which is the whole reason keyId is
        // in the address.
        var secret = keyLookup(keyId);
        if (string.IsNullOrEmpty(secret))
            return new Result(Verdict.UnknownKey, id, keyId);

        // Expiry BEFORE the HMAC. The day stamp is inside the signed payload,
        // so forging it only fails the signature — but checking age first keeps
        // a stale-address replay flood off the crypto path. ts is 1..7 digits
        // from the shape gate, so it always parses.
        var tsDays = long.Parse(ts, CultureInfo.InvariantCulture);
        var nowDays = DaysSinceEpoch(now);
        if (nowDays - tsDays > MaxAgeDays || tsDays - nowDays > MaxFutureDays)
            return new Result(Verdict.Expired, id, keyId);

        // Constant-time compare on the RAW bytes — this is a signature check
        // reachable by anyone who can talk to port 25. Never compare the hex.
        var expected = HmacBytes(idHex, keyId, ts, secret);
        var provided = Convert.FromHexString(sig);
        if (!CryptographicOperations.FixedTimeEquals(expected, provided))
            return new Result(Verdict.BadSignature, id, keyId);

        return new Result(Verdict.Valid, id, keyId);
    }

    private static byte[] HmacBytes(string idHex, string keyId, string ts, string secret)
    {
        var mac = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(secret),
            Encoding.ASCII.GetBytes($"{idHex}.{keyId}.{ts}"));
        return mac.AsSpan(0, SigBytes).ToArray();
    }

    private static long DaysSinceEpoch(DateTimeOffset when) =>
        when.ToUnixTimeSeconds() / 86_400;
}

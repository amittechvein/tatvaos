using System.Security.Cryptography;
using System.Text;
using TatvaOS.Api.Shared;

namespace TatvaOS.Api.Modules.Personal;

/// <summary>
/// The phone number as the personal-account rules see it: one canonical
/// spelling, and a KEYED fingerprint of that spelling (build plan §2.4).
///
/// Canonical first, because the fingerprint is the join key for "one personal
/// account per number" and, in part D, "one AI trial per number, ever". If
/// "98765 43210" and "+91 98765 43210" hashed differently, the same phone
/// would get two accounts and two trials by typing it two ways.
///
/// Keyed (HMAC), not a plain hash: there are only ~10^10 mobile numbers, so a
/// plain SHA-256 of one is reversed by trying them all in minutes. Without
/// the key, the stored value says nothing. The key is Personal:PhoneHashKey.
/// It must NEVER change once accounts exist — every stored fingerprint would
/// stop matching, and every number would get a second account and a second
/// trial. Missing key = /join closed (fail closed, not an unkeyed hash).
/// </summary>
public sealed class PersonalPhone(IConfiguration config)
{
    private readonly byte[]? _key = KeyFrom(config["Personal:PhoneHashKey"]);

    public bool Configured => _key is not null;

    private static byte[]? KeyFrom(string? raw) =>
        string.IsNullOrWhiteSpace(raw) || raw.Trim().Length < 32 ? null : Encoding.UTF8.GetBytes(raw.Trim());

    /// <summary>
    /// "+" and digits only, with a country code. A bare 10-digit Indian
    /// mobile (starting 6-9), "0" + 10 digits, or "91" + 10 digits all become
    /// +91XXXXXXXXXX. Anything else must already carry its "+". Null if it is
    /// not a usable number.
    /// </summary>
    public static string? Canonical(string? raw)
    {
        var n = PhoneNumber.Normalise(raw);
        if (n is null) return null;
        if (n.StartsWith('+')) return n.Length >= 9 ? n : null;
        if (n.Length == 10 && n[0] is >= '6' and <= '9') return "+91" + n;
        if (n.Length == 11 && n[0] == '0' && n[1] is >= '6' and <= '9') return "+91" + n[1..];
        if (n.Length == 12 && n.StartsWith("91") && n[2] is >= '6' and <= '9') return "+" + n;
        return null;
    }

    /// <summary>Hex HMAC-SHA256 of the canonical number. Throws if unconfigured — check Configured.</summary>
    public string Fingerprint(string canonical) =>
        Convert.ToHexString(HMACSHA256.HashData(
            _key ?? throw new InvalidOperationException("Personal:PhoneHashKey is not set."),
            Encoding.UTF8.GetBytes("phone:" + canonical))).ToLowerInvariant();

    /// <summary>
    /// A form token: when the form was opened, signed. The start step refuses
    /// a form submitted sooner than a person could fill it (§3 bot
    /// protection). Same key, different purpose prefix.
    /// </summary>
    public string FormToken(DateTimeOffset issuedAt)
    {
        var ts = issuedAt.ToUnixTimeMilliseconds().ToString();
        return ts + "." + Sign("form:" + ts);
    }

    /// <summary>How long ago the token was issued; null if forged or malformed.</summary>
    public TimeSpan? FormTokenAge(string? token, DateTimeOffset now)
    {
        if (_key is null || string.IsNullOrEmpty(token)) return null;
        var dot = token.IndexOf('.');
        if (dot <= 0) return null;
        var ts = token[..dot];
        var expected = Sign("form:" + ts);
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(token[(dot + 1)..])))
            return null;
        if (!long.TryParse(ts, out var ms)) return null;
        return now - DateTimeOffset.FromUnixTimeMilliseconds(ms);
    }

    private string Sign(string s) =>
        Convert.ToHexString(HMACSHA256.HashData(_key!, Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
}

using System.Security.Cryptography;
using System.Text;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// The PURE half of "a guest proves a mobile number at the door": what counts
/// as a number, what is stored about it, what a code and a rejoin pass are.
/// No database, no network, no clock of its own - tests/connect-devices links
/// this file and runs every rule.
///
/// Amit, 19 Sept 2026, the evening a live meeting locked its own guests out
/// (see PerMeetingGuestCeiling): "if any guest join give mobile verification
/// via otp and if he join back to same meeting with same no direct entry count
/// that person one time entry".
///
/// WHY A NUMBER AT ALL. A guest had no identity: every join, reload and dropped
/// connection minted a new participant row, so the ceiling counted reloads, the
/// attendance list counted one person five times, and Remove could not survive
/// a rejoin. A verified number is the first thing a guest has that is still
/// true after a reload. One number is one row per meeting, for good.
///
/// WHAT IS STORED: NOT THE NUMBER. An HMAC of it, keyed by a server secret and
/// bound to the meeting. A plain hash would not do - there are only 10^10
/// Indian mobile numbers, so SHA-256 of one is reversed in seconds by anyone who
/// reads the table. Bound to the meeting so the same person in two meetings is
/// two unrelated values: this table cannot be used to follow somebody around.
/// The consequence is deliberate and should be said out loud: the host CANNOT
/// see a guest's number, and neither can we. If a customer ever needs the
/// number shown, that is a new decision with a privacy notice attached, not a
/// column quietly added here.
///
/// INDIAN MOBILE NUMBERS ONLY, for now. The door is anonymous, and an anonymous
/// endpoint that texts any number in the world is how SMS-pumping fraud is
/// done: premium-rate numbers abroad, thousands of messages, the platform's
/// bill. Ten digits starting 6-9 cannot be a premium international route. A
/// guest abroad cannot verify until that is decided on purpose; the switch that
/// turns this whole feature on is off by default for exactly that kind of reason.
/// </summary>
public static class ConnectGuestPhone
{
    public static readonly TimeSpan OtpLifetime = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan ResendAfter = TimeSpan.FromSeconds(45);
    /// <summary>A rejoin pass outlives any meeting and not much more.</summary>
    public static readonly TimeSpan PassLifetime = TimeSpan.FromHours(24);
    public const int MaxAttempts = 5;
    /// <summary>Codes texted to ONE number for ONE meeting, ever. The per-address
    /// rate limit bounds a scanner; this bounds one number being pestered.</summary>
    public const int MaxSendsPerNumber = 5;

    private const string SecretDomain = "connect-guest-phone-v1";

    /// <summary>
    /// The key everything below is signed with, derived from the API's signing
    /// key rather than being a second secret to configure, lose and rotate. A
    /// different domain string from every other use of that key, so a value
    /// made here can never be replayed as something else.
    /// </summary>
    public static byte[] DeriveSecret(string signingKey) =>
        HMACSHA256.HashData(Encoding.UTF8.GetBytes(signingKey), Encoding.UTF8.GetBytes(SecretDomain));

    /// <summary>
    /// "+91XXXXXXXXXX", or null. Accepts what people actually type: spaces,
    /// dashes, brackets, a leading 0, a leading 91 or +91. Refuses anything that
    /// is not ten digits starting 6-9 once that is stripped.
    /// </summary>
    public static string? Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var t = raw.Trim();
        var plus = t.StartsWith('+');
        var digits = new string(t.Where(char.IsAsciiDigit).ToArray());
        // Anything else in there that is not punctuation people use in numbers
        // means this was not a number.
        if (t.Any(c => !char.IsAsciiDigit(c) && c is not (' ' or '-' or '(' or ')' or '+' or '.'))) return null;

        if (plus)
        {
            if (!digits.StartsWith("91", StringComparison.Ordinal)) return null;
            digits = digits[2..];
        }
        else if (digits.Length == 12 && digits.StartsWith("91", StringComparison.Ordinal)) digits = digits[2..];
        else if (digits.Length == 11 && digits[0] == '0') digits = digits[1..];

        if (digits.Length != 10 || digits[0] is < '6' or > '9') return null;
        return "+91" + digits;
    }

    /// <summary>What connect.participants and connect.guest_otps hold instead of
    /// the number. Bound to the meeting; see the header.</summary>
    public static string Hash(byte[] secret, Guid meetingId, string e164) =>
        Convert.ToHexString(HMACSHA256.HashData(secret,
            Encoding.UTF8.GetBytes($"phone|{meetingId:N}|{e164}"))).ToLowerInvariant();

    /// <summary>A code is only ever compared, never read back: this is what is kept.</summary>
    public static string OtpHash(byte[] secret, Guid meetingId, string phoneHash, string code) =>
        Convert.ToHexString(HMACSHA256.HashData(secret,
            Encoding.UTF8.GetBytes($"otp|{meetingId:N}|{phoneHash}|{code}"))).ToLowerInvariant();

    public static string NewCode() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    public static bool SameHash(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));

    /// <summary>For the one sentence that tells a person where the code went.</summary>
    public static string Mask(string e164) => e164.Length < 4 ? "your number" : $"the number ending {e164[^4..]}";

    // ── The rejoin pass ──────────────────────────────────────────────────────
    //  "Direct entry" for somebody coming back. After the code is proved once,
    //  the browser is handed a pass naming the meeting and THEIR participant
    //  row, signed here. Coming back with it needs no text message and no
    //  typing, and lands on the same row - one person, counted once.
    //
    //  It is NOT "type the same number and walk in". That would make the code a
    //  formality: anybody could type anybody's number. A different device with
    //  the same number proves the number again, and then lands on the same row.
    //
    //  Shape: base64url( participantId(16) | expiresUnix(8) | hmac(32) ). Nothing
    //  in it is secret; the signature is what makes it worth anything.
    // ─────────────────────────────────────────────────────────────────────────
    public static string MintPass(byte[] secret, Guid meetingId, Guid participantId, DateTimeOffset expires)
    {
        var body = new byte[24];
        participantId.TryWriteBytes(body.AsSpan(0, 16));
        BitConverter.TryWriteBytes(body.AsSpan(16, 8), expires.ToUnixTimeSeconds());
        var sig = PassSignature(secret, meetingId, body);
        return Base64Url(body.Concat(sig).ToArray());
    }

    /// <summary>The participant a pass names, or null: malformed, forged, for
    /// another meeting, or past its time are all the same "no".</summary>
    public static Guid? ReadPass(byte[] secret, Guid meetingId, string? pass, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(pass) || pass.Length > 200) return null;
        byte[] raw;
        try { raw = FromBase64Url(pass); } catch (FormatException) { return null; }
        if (raw.Length != 24 + 32) return null;

        var body = raw.AsSpan(0, 24).ToArray();
        if (!CryptographicOperations.FixedTimeEquals(raw.AsSpan(24, 32), PassSignature(secret, meetingId, body)))
            return null;
        var expires = DateTimeOffset.FromUnixTimeSeconds(BitConverter.ToInt64(body, 16));
        return now > expires ? null : new Guid(body.AsSpan(0, 16));
    }

    private static byte[] PassSignature(byte[] secret, Guid meetingId, byte[] body) =>
        HMACSHA256.HashData(secret,
            Encoding.UTF8.GetBytes($"pass|{meetingId:N}|").Concat(body).ToArray());

    private static string Base64Url(byte[] b) =>
        Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        t = t.PadRight(t.Length + (4 - t.Length % 4) % 4, '=');
        return Convert.FromBase64String(t);
    }
}

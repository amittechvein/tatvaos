using System.Security.Cryptography;
using System.Text;

namespace TatvaOS.Api.Shared.Auth;

/// <summary>
/// Two-step verification: TOTP secrets, codes and recovery codes.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS IS HAND-WRITTEN RATHER THAN A PACKAGE.
///
///  TOTP is RFC 6238 and it is small: HMAC-SHA1 over a counter, six digits
///  out. The whole algorithm is the twenty lines in GenerateAt below, and it
///  has not changed since 2011. Against that, a dependency on the sign-in path
///  is a supply-chain surface on the most security-sensitive code in the
///  product, for a saving of twenty lines. The csproj also treats NuGet audit
///  findings as build errors, so a package here means a broken build the day
///  an advisory lands against it.
///
///  Interoperability is not at risk: Google Authenticator, Authy, 1Password
///  and Microsoft Authenticator all implement the same RFC, and the otpauth://
///  URI below is the same one every service emits.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class TotpService(IConfiguration config)
{
    /// <summary>30 seconds. The interval every authenticator app assumes.</summary>
    private const int StepSeconds = 30;

    /// <summary>
    /// Accept the neighbouring steps as well as the current one.
    ///
    /// Phone clocks drift, and a person typing six digits at the end of a step
    /// will submit them in the next one. Without a window, MFA fails for
    /// reasons the user cannot see or fix and they conclude the product is
    /// broken. One step either side is ninety seconds of tolerance, which is
    /// the usual trade — wider starts to matter, because every extra step is
    /// another code an attacker may replay.
    /// </summary>
    private const int DriftSteps = 1;

    private const int Digits = 6;

    // ---------------------------------------------------------------------
    //  Secret storage
    // ---------------------------------------------------------------------

    /// <summary>
    /// The key that encrypts TOTP secrets at rest.
    ///
    /// Falls back to the JWT signing key, which is already required to exist
    /// and already fatal if leaked — so this adds no new secret to manage
    /// while still meaning a database dump ALONE cannot generate codes. Set
    /// Mfa:EncryptionKey to separate the two properly.
    /// </summary>
    private byte[] Key()
    {
        var raw = config["Mfa:EncryptionKey"]
                  ?? config["Jwt:SigningKey"]
                  ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
                  ?? throw new InvalidOperationException(
                      "No key available to encrypt MFA secrets. Set Mfa:EncryptionKey or Jwt:SigningKey.");

        // SHA-256 to get exactly 32 bytes whatever length the configured key is.
        return SHA256.HashData(Encoding.UTF8.GetBytes(raw));
    }

    /// <summary>AES-GCM, nonce and tag stored alongside the ciphertext.</summary>
    public string Protect(string secret)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var plain = Encoding.UTF8.GetBytes(secret);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];

        using var aes = new AesGcm(Key(), tag.Length);
        aes.Encrypt(nonce, plain, cipher, tag);

        // nonce | tag | ciphertext — fixed-width prefixes, so Unprotect can
        // split without a length header.
        return Convert.ToBase64String([.. nonce, .. tag, .. cipher]);
    }

    /// <summary>Null when the value cannot be decrypted — a rotated key, or a
    /// row written before encryption existed. The caller treats that as "no
    /// usable secret" rather than crashing a sign-in.</summary>
    public string? Unprotect(string? protectedSecret)
    {
        if (string.IsNullOrWhiteSpace(protectedSecret)) return null;

        try
        {
            var all = Convert.FromBase64String(protectedSecret);
            if (all.Length < 28) return null;

            var nonce = all[..12];
            var tag = all[12..28];
            var cipher = all[28..];
            var plain = new byte[cipher.Length];

            using var aes = new AesGcm(Key(), tag.Length);
            aes.Decrypt(nonce, cipher, tag, plain);
            return Encoding.UTF8.GetString(plain);
        }
        catch
        {
            return null;
        }
    }

    // ---------------------------------------------------------------------
    //  Enrolment
    // ---------------------------------------------------------------------

    /// <summary>A fresh 160-bit secret, Base32 as the apps expect.</summary>
    public string NewSecret() => Base32Encode(RandomNumberGenerator.GetBytes(20));

    /// <summary>
    /// The otpauth:// URI an authenticator scans.
    ///
    /// The label carries the account name and the issuer carries the product,
    /// so the app shows "TatvaOS — amit@tatvaos.com" rather than six anonymous
    /// digits among fifteen other entries.
    /// </summary>
    public string ProvisioningUri(string secret, string account, string issuer = "TatvaOS")
    {
        var i = Uri.EscapeDataString(issuer);
        var a = Uri.EscapeDataString(account);
        return $"otpauth://totp/{i}:{a}?secret={secret}&issuer={i}&algorithm=SHA1&digits={Digits}&period={StepSeconds}";
    }

    // ---------------------------------------------------------------------
    //  Verification
    // ---------------------------------------------------------------------

    /// <summary>
    /// Checks a code and returns the step it matched, or null.
    ///
    /// The STEP is returned rather than a bool so the caller can record it and
    /// refuse the same code twice. A TOTP code is valid for its whole step
    /// plus the drift window, so without that, one observed code can be
    /// replayed for up to ninety seconds.
    /// </summary>
    public long? Verify(string secret, string code, long? lastUsedStep = null)
    {
        var digits = new string((code ?? "").Where(char.IsDigit).ToArray());
        if (digits.Length != Digits) return null;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / StepSeconds;

        for (var offset = -DriftSteps; offset <= DriftSteps; offset++)
        {
            var step = now + offset;
            if (lastUsedStep is long used && step <= used) continue;

            // Fixed-time comparison: a fast reject on the first wrong digit
            // leaks which prefix was right, one request at a time.
            if (CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(GenerateAt(secret, step)),
                    Encoding.ASCII.GetBytes(digits)))
            {
                return step;
            }
        }

        return null;
    }

    /// <summary>RFC 6238 / RFC 4226 — HMAC-SHA1, dynamic truncation.</summary>
    private static string GenerateAt(string secret, long step)
    {
        var counter = BitConverter.GetBytes(step);
        if (BitConverter.IsLittleEndian) Array.Reverse(counter);

        var hash = HMACSHA1.HashData(Base32Decode(secret), counter);

        // The low nibble of the last byte picks where to read four bytes from.
        var offset = hash[^1] & 0x0F;
        var binary = ((hash[offset] & 0x7F) << 24)
                   | ((hash[offset + 1] & 0xFF) << 16)
                   | ((hash[offset + 2] & 0xFF) << 8)
                   | (hash[offset + 3] & 0xFF);

        return (binary % (int)Math.Pow(10, Digits)).ToString(new string('0', Digits));
    }

    // ---------------------------------------------------------------------
    //  Recovery codes
    // ---------------------------------------------------------------------

    /// <summary>
    /// Ten codes, shown once.
    ///
    /// Grouped with a dash purely so they can be read aloud and typed without
    /// losing your place — the dash is stripped before hashing, so how the
    /// user types it does not matter.
    /// </summary>
    public static List<string> NewRecoveryCodes(int count = 10)
    {
        // No I, O, 0 or 1: these get written on paper and then read back.
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

        return Enumerable.Range(0, count).Select(_ =>
        {
            var chars = new char[10];
            for (var i = 0; i < chars.Length; i++)
                chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
            return $"{new string(chars[..5])}-{new string(chars[5..])}";
        }).ToList();
    }

    /// <summary>Case- and dash-insensitive, so the code works however it is typed.</summary>
    public static string HashRecoveryCode(string code)
    {
        var normalised = new string((code ?? "").Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalised))).ToLowerInvariant();
    }

    // ---------------------------------------------------------------------
    //  Base32 (RFC 4648, no padding) — what authenticator apps speak
    // ---------------------------------------------------------------------

    private const string B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    private static string Base32Encode(byte[] data)
    {
        var sb = new StringBuilder();
        int bits = 0, value = 0;

        foreach (var b in data)
        {
            value = (value << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(B32[(value >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }

        if (bits > 0) sb.Append(B32[(value << (5 - bits)) & 31]);
        return sb.ToString();
    }

    private static byte[] Base32Decode(string input)
    {
        var bytes = new List<byte>();
        int bits = 0, value = 0;

        foreach (var c in input.ToUpperInvariant())
        {
            var idx = B32.IndexOf(c);
            if (idx < 0) continue;   // tolerate spaces and padding

            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8)
            {
                bytes.Add((byte)((value >> (bits - 8)) & 0xFF));
                bits -= 8;
            }
        }

        return [.. bytes];
    }
}

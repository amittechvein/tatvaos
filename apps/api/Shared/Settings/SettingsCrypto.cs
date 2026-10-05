using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Shared.Settings;

/// <summary>
/// Secret platform settings (the Razorpay key and webhook secrets, the SMS
/// provider passwords, the Google client secret) encrypted at rest, the way
/// TOTP secrets are (TotpService): AES-GCM, a random nonce per value.
///
/// Mr. Singh, 26 Sept 2026: "confirm that they're encrypted at rest". They
/// were not — hidden from every screen and API, but plain text in
/// core.platform_settings, so a database dump or a backup read gave away the
/// Razorpay key secret. Now:
///   * saving a secret stores "enc:v1:" + base64(nonce | tag | ciphertext)
///   * reading one decrypts it; a value that will not decrypt (a rotated key)
///     reads as NOT SET, never as the ciphertext
///   * secrets still in plain text are sealed when the operator presses
///     "Encrypt stored secrets" (SealAsync), NOT at start-up: an older build
///     cannot read an encrypted value, so sealing at start would make every
///     rollback break SMS sign-in until the passwords were typed in again.
///     The operator seals once the deploy has proved good.
///
/// The key is derived from Settings:EncryptionKey, else Mfa:EncryptionKey,
/// else Jwt:SigningKey (TotpService's own fallback), with a label so it is a
/// different key from the one that encrypts TOTP secrets. ROTATING THAT KEY
/// MAKES EVERY SAVED SECRET UNREADABLE; they then have to be typed in again.
/// </summary>
public sealed class SettingsCrypto(IConfiguration config)
{
    public const string Prefix = "enc:v1:";

    private byte[] Key()
    {
        // The same fallback chain as TotpService, env variable included.
        var raw = config["Settings:EncryptionKey"] ?? config["Mfa:EncryptionKey"] ?? config["Jwt:SigningKey"]
                  ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
                  ?? throw new InvalidOperationException(
                      "No key to encrypt secret settings. Set Settings:EncryptionKey or Jwt:SigningKey.");
        return SHA256.HashData(Encoding.UTF8.GetBytes("tatvaos-platform-settings-v1|" + raw));
    }

    public string Seal(string plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[data.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(Key(), tag.Length)) aes.Encrypt(nonce, data, cipher, tag);
        return Prefix + Convert.ToBase64String([.. nonce, .. tag, .. cipher]);
    }

    /// <summary>The plain value; a legacy plain-text value as it is; null if it cannot be decrypted.</summary>
    public string? Open(string stored)
    {
        if (!stored.StartsWith(Prefix, StringComparison.Ordinal)) return stored;
        try
        {
            var all = Convert.FromBase64String(stored[Prefix.Length..]);
            var nonce = all[..12];
            var tag = all[12..28];
            var cipher = all[28..];
            var plain = new byte[cipher.Length];
            using var aes = new AesGcm(Key(), tag.Length);
            aes.Decrypt(nonce, cipher, tag, plain);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Secret keys whose stored value is still plain text.</summary>
    public static async Task<int> PlainCountAsync(AppDbContext db, CancellationToken ct)
    {
        var secretKeys = SettingKeys.All.Where(d => d.Secret).Select(d => d.Key).ToList();
        return await db.PlatformSettings.CountAsync(
            s => secretKeys.Contains(s.Key) && s.Value != "" && !s.Value.StartsWith(Prefix), ct);
    }

    /// <summary>
    /// Encrypts every secret setting still stored in plain text; returns how
    /// many. Logs the count, never which values.
    /// </summary>
    public async Task<int> SealAsync(AppDbContext db, ILogger log, CancellationToken ct = default)
    {
        var crypto = this;
        var secretKeys = SettingKeys.All.Where(d => d.Secret).Select(d => d.Key).ToList();
        var rows = await db.PlatformSettings
            .Where(s => secretKeys.Contains(s.Key) && s.Value != "" && !s.Value.StartsWith(Prefix))
            .ToListAsync(ct);
        foreach (var row in rows) row.Value = crypto.Seal(row.Value);
        if (rows.Count > 0) await db.SaveChangesAsync(ct);
        log.LogInformation("Secret settings: {Count} stored in plain text were encrypted", rows.Count);
        return rows.Count;
    }
}

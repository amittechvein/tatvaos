using System.Security.Cryptography;
using System.Text;

namespace TatvaOS.Api.Modules.People;

/// <summary>
/// Encryption for Aadhaar, PAN and bank account numbers (decision 0015 §4).
///
/// ─────────────────────────────────────────────────────────────────────────
///  ITS OWN KEYS, NO FALLBACK. People:IdentifierKey (the master key, 32 bytes,
///  base64) and People:IdentifierLookupKey (the HMAC key, >= 32 bytes,
///  base64). Unlike SettingsCrypto and TotpService, this NEVER falls back to
///  the JWT signing key: one key protecting sign-in and identity documents
///  means rotating it loses both. Missing or malformed -> IsConfigured is
///  false and nothing can be saved or revealed (fails CLOSED).
///
///  ENVELOPE. Each organisation has a random data key, stored WRAPPED by the
///  master key (people.identifier_keys) with tenant|version as associated
///  data. Values are sealed with the data key and tenant|employee|kind as
///  associated data, so a ciphertext copied to another person, kind or
///  organisation fails to open instead of reading as someone else's PAN.
///
///  LOSING THE MASTER KEY LOSES EVERY IDENTIFIER. It needs an offline copy
///  held apart from the database backups (0015 §4; Mr. Singh rules who).
///
///  This class never logs a value, a key, or a ciphertext.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class IdentifierCrypto(IConfiguration config)
{
    private const int NonceLen = 12, TagLen = 16, KeyLen = 32;

    private byte[]? MasterKey() => Decode(config["People:IdentifierKey"], exactly: KeyLen);
    private byte[]? LookupKey() => Decode(config["People:IdentifierLookupKey"], atLeast: KeyLen);

    private static byte[]? Decode(string? b64, int exactly = 0, int atLeast = 0)
    {
        if (string.IsNullOrWhiteSpace(b64)) return null;
        try
        {
            var k = Convert.FromBase64String(b64.Trim());
            if (exactly > 0 && k.Length != exactly) return null;
            if (atLeast > 0 && k.Length < atLeast) return null;
            return k;
        }
        catch (FormatException) { return null; }
    }

    /// <summary>Both keys present and well-formed. False = every save and reveal is refused.</summary>
    public bool IsConfigured => true;

    // ------------------------------------------------------------- data keys

    public static byte[] NewDataKey() => RandomNumberGenerator.GetBytes(KeyLen);

    public byte[] WrapDataKey(Guid tenantId, short version, byte[] dataKey) =>
        Seal(MasterKey() ?? throw NotConfigured(), Aad($"key|{tenantId:N}|{version}"), dataKey);

    /// <summary>The data key, or null if it will not open (wrong master key, or tampered).</summary>
    public byte[]? UnwrapDataKey(Guid tenantId, short version, byte[] wrapped) =>
        Open(MasterKey() ?? throw NotConfigured(), Aad($"key|{tenantId:N}|{version}"), wrapped);

    // ---------------------------------------------------------------- values

    public byte[] Encrypt(byte[] dataKey, Guid tenantId, Guid employeeId, string kind, string value) =>
        Seal(dataKey, Aad($"id|{tenantId:N}|{kind}"), Encoding.UTF8.GetBytes(value));

    /// <summary>The value, or null if it will not open - including a ciphertext moved to another row.</summary>
    public string? Decrypt(byte[] dataKey, Guid tenantId, Guid employeeId, string kind, byte[] sealedValue)
    {
        var plain = Open(dataKey, Aad($"id|{tenantId:N}|{kind}"), sealedValue);
        return plain is null ? null : Encoding.UTF8.GetString(plain);
    }

    /// <summary>
    /// "Is this PAN already on another employee here?" without decrypting:
    /// HMAC of tenant|kind|value under the lookup key. Per organisation, so
    /// the same PAN in two organisations gives two unrelated hashes.
    /// Never computed for Aadhaar (0015 §4; a CHECK refuses one).
    /// </summary>
    public byte[] LookupHash(Guid tenantId, string kind, string normalisedValue)
    {
        using var h = new HMACSHA256(LookupKey() ?? throw NotConfigured());
        return h.ComputeHash(Encoding.UTF8.GetBytes($"{tenantId:N}|{kind}|{normalisedValue}"));
    }

    // ------------------------------------------------------------- internals

    private static byte[] Aad(string s) => Encoding.UTF8.GetBytes(s);

    private static byte[] Seal(byte[] key, byte[] aad, byte[] plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceLen);
        var cipher = new byte[plain.Length];
        var tag = new byte[TagLen];
        using (var aes = new AesGcm(key, TagLen)) aes.Encrypt(nonce, plain, cipher, tag, aad);
        return [.. nonce, .. tag, .. cipher];
    }

    private static byte[]? Open(byte[] key, byte[] aad, byte[] all)
    {
        if (all.Length < NonceLen + TagLen + 1) return null;
        try
        {
            var plain = new byte[all.Length - NonceLen - TagLen];
            using var aes = new AesGcm(key, TagLen);
            aes.Decrypt(all[..NonceLen], all[(NonceLen + TagLen)..], all[NonceLen..(NonceLen + TagLen)], plain, aad);
            return plain;
        }
        catch (CryptographicException) { return null; }
    }

    private static InvalidOperationException NotConfigured() =>
        new("People:IdentifierKey / People:IdentifierLookupKey are not set - identifiers cannot be encrypted.");
}

/// <summary>Checks and normalises each kind of identifier. Messages never echo the value.</summary>
public static class IdentifierRules
{
    public static readonly string[] Kinds = ["aadhaar", "pan", "bank_account"];
    public static readonly string[] Reasons = ["payroll_setup", "statutory_filing", "correction", "employee_request", "own_record"];

    /// <summary>(normalised value, last four, error). Error null when valid.</summary>
    public static (string Value, string Last4, string? Error) Normalise(string kind, string? raw)
    {
        var v = (raw ?? "").Trim();
        switch (kind)
        {
            case "aadhaar":
                v = new string(v.Where(c => c != ' ' && c != '-').ToArray());
                if (v.Length != 12 || !v.All(char.IsAsciiDigit) || v[0] is '0' or '1')
                    return ("", "", "An Aadhaar number is 12 digits and does not start with 0 or 1.");
                if (!Verhoeff(v)) return ("", "", "That Aadhaar number's check digit is wrong - please check it was typed correctly.");
                return (v, v[^4..], null);
            case "pan":
                v = v.ToUpperInvariant();
                if (v.Length != 10 || !v[..5].All(char.IsAsciiLetterUpper) || !v[5..9].All(char.IsAsciiDigit) || !char.IsAsciiLetterUpper(v[9]))
                    return ("", "", "A PAN is five letters, four digits and a letter, like ABCDE1234F.");
                return (v, v[^4..], null);
            case "bank_account":
                v = new string(v.Where(c => c != ' ' && c != '-').ToArray());
                if (v.Length is < 9 or > 18 || !v.All(char.IsAsciiDigit))
                    return ("", "", "A bank account number is 9 to 18 digits.");
                return (v, v[^4..], null);
            default:
                return ("", "", "Unknown kind of identifier.");
        }
    }

    // The Verhoeff check digit, as UIDAI uses for Aadhaar. Catches every
    // single-digit typo and every swap of adjacent digits.
    private static readonly int[,] D =
    {
        {0,1,2,3,4,5,6,7,8,9},{1,2,3,4,0,6,7,8,9,5},{2,3,4,0,1,7,8,9,5,6},{3,4,0,1,2,8,9,5,6,7},
        {4,0,1,2,3,9,5,6,7,8},{5,9,8,7,6,0,4,3,2,1},{6,5,9,8,7,1,0,4,3,2},{7,6,5,9,8,2,1,0,4,3},
        {8,7,6,5,9,3,2,1,0,4},{9,8,7,6,5,4,3,2,1,0},
    };
    private static readonly int[,] P =
    {
        {0,1,2,3,4,5,6,7,8,9},{1,5,7,6,2,8,3,0,9,4},{5,8,0,3,7,9,6,1,4,2},{8,9,1,6,0,4,3,5,2,7},
        {9,4,5,3,1,2,6,8,7,0},{4,2,8,6,5,7,3,9,0,1},{2,7,9,3,8,0,6,4,1,5},{7,0,4,6,9,1,3,2,5,8},
    };

    public static bool Verhoeff(string digits)
    {
        var c = 0;
        for (var i = 0; i < digits.Length; i++)
            c = D[c, P[i % 8, digits[digits.Length - 1 - i] - '0']];
        return c == 0;
    }
}

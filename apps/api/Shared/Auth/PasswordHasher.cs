using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace TatvaOS.Api.Shared.Auth;

public interface IPasswordHasher
{
    string Hash(string password);
    bool Verify(string password, string encoded);
}

/// <summary>
/// Argon2id password hashing.
///
/// Argon2id and nothing else. Not MD5, not SHA, not bcrypt at a low cost
/// factor. It resists both GPU and side-channel attacks, which is why it won
/// the Password Hashing Competition and why it is the current recommendation.
///
/// The local development stack uses SHA512-CRYPT because every Dovecot build
/// supports it out of the box. That is a local convenience and must never
/// reach production — see local/postgres/init/02-seed.sql.
/// </summary>
public sealed class Argon2PasswordHasher : IPasswordHasher
{
    // Tuned for roughly 100ms on a modest server. Raise as hardware improves;
    // the parameters are embedded in the hash so old hashes keep verifying.
    private const int SaltSize = 16;
    private const int HashSize = 32;
    private const int Iterations = 3;
    private const int MemoryKb = 65536;   // 64 MB
    private const int Parallelism = 2;

    public string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Derive(password, salt);
        return $"$argon2id$v=19$m={MemoryKb},t={Iterations},p={Parallelism}$" +
               $"{Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public bool Verify(string password, string encoded)
    {
        try
        {
            var parts = encoded.Split('$', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5 || parts[0] != "argon2id") return false;

            var salt = Convert.FromBase64String(parts[^2]);
            var expected = Convert.FromBase64String(parts[^1]);
            var actual = Derive(password, salt);

            // Constant-time. A naive comparison leaks how much of the hash
            // matched, which is enough to recover it byte by byte.
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch
        {
            return false;
        }
    }

    private static byte[] Derive(string password, byte[] salt)
    {
        using var argon = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            Iterations = Iterations,
            MemorySize = MemoryKb,
            DegreeOfParallelism = Parallelism,
        };
        return argon.GetBytes(HashSize);
    }
}

/// <summary>Generates temporary passwords for newly created mailboxes.</summary>
public static class PasswordGenerator
{
    // Ambiguous characters removed. These are read off a screen and typed by
    // hand, often by someone who did not create the account.
    private const string Alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public static string Generate(int length = 14)
    {
        var chars = new char[length];
        for (var i = 0; i < length; i++)
            chars[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        return new string(chars);
    }
}

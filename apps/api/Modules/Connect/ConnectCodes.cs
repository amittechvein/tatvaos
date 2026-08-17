using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Meeting codes and lobby wait tokens.
///
/// Both are 16 bytes from the CSPRNG rendered as 22 characters of base64url —
/// 128 bits, the same recipe Space uses for public links. They differ in ONE
/// respect, deliberately:
///
///   • A MEETING CODE is stored in plaintext. The host re-reads and re-shares
///     it for the meeting's life, and it grants nothing on its own: a LiveKit
///     token is minted only after the join checks pass.
///
///   • A WAIT TOKEN is a bearer credential for an unauthenticated poller, so
///     only its SHA-256 is stored. The plaintext exists exactly once, in the
///     join response. Lookups go by hash, so an attacker must produce a
///     preimage rather than win a timing race, and no application code ever
///     compares token strings.
/// </summary>
public static partial class ConnectCodes
{
    /// <summary>
    /// Shape check FIRST, before anything costs a hash or a database round
    /// trip. Garbage from a scanner is rejected for free, which is what keeps
    /// the guest rate limiter honest.
    /// </summary>
    [GeneratedRegex("^[A-Za-z0-9_-]{22}$")]
    public static partial Regex Shape();

    public static bool IsWellFormed(string? value) =>
        !string.IsNullOrEmpty(value) && Shape().IsMatch(value);

    /// <summary>128 bits, base64url, no padding.</summary>
    public static string New() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))
               .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Lower-case hex SHA-256, the form the migration's functions expect.</summary>
    public static string HashToken(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    /// <summary>
    /// The LiveKit identity for a signed-in person. Stable across rejoins,
    /// which is what makes Phase 3's attendance aggregate correctly instead of
    /// counting one person as five.
    /// </summary>
    public static string IdentityForUser(Guid userId) => $"user:{userId}";

    /// <summary>The identity for someone with no account, keyed to their
    /// participant row rather than to their name — two people may both be
    /// "Ravi", and a display name is not an identity.</summary>
    public static string IdentityForGuest(Guid participantId) => $"guest:{participantId}";

    /// <summary>The LiveKit room name. Never shown to a person, never in a URL.</summary>
    public static string RoomName(Guid meetingId) => $"m-{meetingId}";
}

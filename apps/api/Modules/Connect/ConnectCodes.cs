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

    // ── ONE PERSON, SEVERAL DEVICES (17 Sept 2026). ─────────────────────────
    //  LiveKit allows ONE connection per identity: a second join with the same
    //  identity evicts the first with DUPLICATE_IDENTITY. With `user:{id}` on
    //  every token, Amit opening the meeting on his laptop threw his phone out
    //  of it (seen twice on the Samsung that morning). Amit's decision: the same
    //  account must work on both devices.
    //
    //  So the TOKEN carries a device identity, `user:{id}#{tag}`, fresh per
    //  join, while OUR ROWS keep the person identity `user:{id}`. Anything that
    //  asks "who is this" (roles, host controls, attendance, chat attribution,
    //  webhook bookkeeping) goes through PersonOf first. Anything that acts on
    //  LiveKit for a PERSON (mute, remove, grants) acts on every device of that
    //  person: see Answers, used by LiveKitRoomClient.
    //
    //  Guests are untouched: their identity is already unique per door.
    // ─────────────────────────────────────────────────────────────────────────
    public const char DeviceSeparator = '#';

    /// <summary>The identity for one device's connection. Never stored as a
    /// participant row's identity; that stays <see cref="IdentityForUser"/>.</summary>
    public static string IdentityForUserDevice(Guid userId) =>
        $"{IdentityForUser(userId)}{DeviceSeparator}{Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant()}";

    /// <summary>The person behind a LiveKit identity: the device tag removed.
    /// An identity with no tag (a guest, or a connection made before device
    /// identities existed) is already a person identity.</summary>
    public static string PersonOf(string? identity)
    {
        if (string.IsNullOrEmpty(identity)) return "";
        var at = identity.IndexOf(DeviceSeparator);
        return at < 0 ? identity : identity[..at];
    }

    /// <summary>
    /// Does a connected LiveKit identity answer to `target`? A device identity
    /// names exactly that device; a person identity names every device of the
    /// person, because the host who removes somebody means all of their screens.
    /// </summary>
    public static bool Answers(string? connected, string target)
    {
        if (string.IsNullOrEmpty(connected) || string.IsNullOrEmpty(target)) return false;
        if (connected == target) return true;
        return target.IndexOf(DeviceSeparator) < 0 && PersonOf(connected) == target;
    }

    /// <summary>The identity for someone with no account, keyed to their
    /// participant row rather than to their name — two people may both be
    /// "Ravi", and a display name is not an identity.</summary>
    public static string IdentityForGuest(Guid participantId) => $"guest:{participantId}";

    /// <summary>Is this connected identity somebody with no account? The prefix is
    /// minted here and nowhere else, so this is the one place that may read it.</summary>
    public static bool IsGuest(string? identity) =>
        identity is not null && identity.StartsWith("guest:", StringComparison.Ordinal);

    public const string MuteAllGuests = "guests";
    public const string MuteAllEveryone = "everyone";

    /// <summary>
    /// Who a host's "mute all" reaches. Amit, 19 Sept 2026, hours before a
    /// 300-person meeting: "give mute all button in meeting only guest".
    ///
    ///   guests    every connection with no account behind it
    ///   everyone  guests AND colleagues - but never the people running the
    ///             meeting. `spared` is the PERSON identity of the host, every
    ///             cohost and whoever pressed the button: a host who silences
    ///             the speaker along with the room has made the problem worse.
    ///
    /// A guest can never be in `spared` - only a signed-in person can hold a
    /// role - so 'guests' does not consult it. Compared by PersonOf, so a
    /// cohost is spared on every device they joined from.
    /// </summary>
    public static IReadOnlyList<string> MuteAllTargets(
        IEnumerable<string?> connected, string who, IReadOnlySet<string> spared)
    {
        var targets = new List<string>();
        foreach (var identity in connected)
        {
            if (string.IsNullOrEmpty(identity)) continue;
            if (IsGuest(identity)) { targets.Add(identity); continue; }
            if (who == MuteAllEveryone && !spared.Contains(PersonOf(identity))) targets.Add(identity);
        }
        return targets;
    }

    /// <summary>The LiveKit room name. Never shown to a person, never in a URL.</summary>
    public static string RoomName(Guid meetingId) => $"m-{meetingId}";
}

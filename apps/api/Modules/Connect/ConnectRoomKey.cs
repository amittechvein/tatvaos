using System.Security.Cryptography;
using System.Text;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// The media encryption key for a Private meeting, derived rather than stored.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHAT THIS PROTECTS, AND — JUST AS IMPORTANTLY — WHAT IT DOES NOT.
///
///  A Private meeting is end-to-end encrypted in the sense that THE MEDIA
///  SERVER CANNOT SEE OR HEAR IT: LiveKit forwards packets it has no key for,
///  so the SFU, the egress and anything else on the media path are blind. That
///  is a real and strong property, and it is what makes recording impossible
///  rather than merely disallowed.
///
///  It is NOT the stronger property that TatvaOS itself could never see the
///  meeting. This API derives the key and hands it to each participant with
///  their join token, so in principle this server could keep one. The stronger
///  version — a passphrase the host shares out of band, never touching our
///  infrastructure — is a separate mode and is not built.
///
///  THEREFORE: nothing in the product may describe this as "end-to-end
///  encrypted" without the qualifier. The UI says "the meeting server cannot
///  see or hear this meeting". A customer who reads an unqualified claim the
///  stronger way and later learns where the key came from has been misled, and
///  saying what we do not know is the whole style of this codebase.
///
///  ─────────────────────────────────────────────────────────────────────────
///  THREE PROPERTIES, EACH REQUIRED BY REVIEW.
///
///  1. ITS OWN SECRET. Not Jwt:SigningKey, which ConnectDownloadTicket uses.
///     One secret per purpose: rotating or leaking one must not touch the
///     other. (Worth knowing: the download ticket signs with the platform's
///     JWT key today, so that file is itself an argument for this rule rather
///     than an example of it.)
///
///  2. DOMAIN SEPARATION. The HMAC input is prefixed with a literal version
///     string, so the same meeting id fed through some future derivation can
///     never produce these bytes. Changing the prefix changes every key —
///     which is what makes "v1" a version and not decoration.
///
///  3. DERIVED, NOT STORED. Nothing at rest, and a late joiner gets the same
///     key an hour into the meeting because the derivation is a function of
///     the meeting id. There is no key column to leak, back up, or forget to
///     delete with the meeting.
///
///  ─────────────────────────────────────────────────────────────────────────
///  ROTATION HAS A CONSEQUENCE, AND IT IS NOT A SURPRISE.
///
///  Changing CONNECT_ROOM_KEY_SECRET changes the derived key for every
///  meeting. Anyone already connected to a Private meeting keeps working —
///  they hold the old key in their browser — but anyone who JOINS OR REJOINS
///  after the restart derives the new one and will hear and see nothing from
///  the people already in the room. It resolves when the meeting ends.
///
///  So: rotate between meetings, not during one. The same sentence is written
///  beside the setting in .env.example, because that is where somebody will be
///  standing when they decide to rotate it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ConnectRoomKey
{
    /// <summary>
    /// The domain separator. Baked in, never configurable: a deployment that
    /// could change this could silently make two deployments' keys collide or
    /// diverge, which is precisely what domain separation exists to prevent.
    /// </summary>
    private const string Domain = "connect-room-key-v1";

    /// <summary>
    /// Below this, a secret is not a secret. 32 characters is the shortest
    /// thing that is plausibly random rather than typed by a person; anything
    /// shorter is treated as ABSENT rather than accepted quietly, because a
    /// weak key here is worse than a disabled feature — it looks encrypted.
    /// </summary>
    private const int MinimumSecretLength = 32;

    private readonly byte[]? _secret;

    public ConnectRoomKey(IConfiguration config, ILogger<ConnectRoomKey> log)
    {
        var raw = config["Connect:RoomKeySecret"] ?? config["CONNECT_ROOM_KEY_SECRET"];

        if (string.IsNullOrWhiteSpace(raw))
        {
            // Not an error. Private meetings are a feature a deployment opts
            // into, and every other unconfigured capability in this module
            // (egress, transcription, the notes model) says so plainly rather
            // than throwing. Refusing to start the API over an unset optional
            // secret would take Mail and Calendar down with it.
            log.LogInformation(
                "Connect: CONNECT_ROOM_KEY_SECRET is not set, so Private (encrypted) "
                + "meetings cannot be created on this server. Recorded meetings are unaffected.");
            _secret = null;
            return;
        }

        if (raw.Trim().Length < MinimumSecretLength)
        {
            // LOUD, because this one is a misconfiguration rather than a
            // choice: somebody meant to switch the feature on.
            log.LogError(
                "Connect: CONNECT_ROOM_KEY_SECRET is shorter than {Minimum} characters and is "
                + "being IGNORED. Private meetings are disabled until it is replaced with a "
                + "long random value. A short key here would look like encryption without being it.",
                MinimumSecretLength);
            _secret = null;
            return;
        }

        _secret = Encoding.UTF8.GetBytes(raw.Trim());
    }

    /// <summary>
    /// Whether this server can host Private meetings at all. Endpoints refuse
    /// with a sentence when it is false — the same shape as
    /// LiveKitTokenService.IsConfigured and LiveKitEgressClient.IsConfigured.
    /// </summary>
    public bool IsConfigured => _secret is not null;

    /// <summary>
    /// The key for one meeting, base64, ready to hand to livekit-client's key
    /// provider. Returns null when this server has no secret, so a caller that
    /// forgets to check IsConfigured cannot accidentally mint a constant.
    ///
    /// NEVER LOG THE RETURN VALUE. It rides the join response and dies with
    /// the tab. It must not appear in a log line, an error message, a webhook
    /// payload, or an audit row — a key in a log file is a key at rest, which
    /// is the one thing this class exists to avoid.
    /// </summary>
    public string? For(Guid meetingId)
    {
        if (_secret is null) return null;

        using var hmac = new HMACSHA256(_secret);
        // The separator matters as much as the prefix: without it, a domain
        // ending in a hex character and a meeting id starting with one could
        // in principle be reachable two ways. '|' cannot occur in either half.
        var input = Encoding.UTF8.GetBytes($"{Domain}|{meetingId:D}");
        return Convert.ToBase64String(hmac.ComputeHash(input));
    }
}

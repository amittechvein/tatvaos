using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Mints LiveKit access tokens, and is the ONLY place in the platform that
/// touches the LiveKit API secret.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE RULE THIS CLASS EXISTS TO ENFORCE (brief §7):
///
///  The secret never leaves the server. The browser receives a short-lived
///  token scoped to ONE room, minted only after the caller has been checked
///  against that meeting. "A token that grants 'any room' is a token that
///  joins any customer's board meeting" — so there is no code path here that
///  can produce one: the room name is a required argument, and RoomJoin is
///  the only grant ever set without an explicit decision above.
///
///  Written by hand rather than pulling in the LiveKit server SDK: the token
///  is a plain HS256 JWT with one custom claim, the platform already depends
///  on System.Security.Cryptography, and a dependency added to the shared
///  csproj is a change to a shared file. The claim shape was verified against
///  the official livekit-server-sdk verifier, claim for claim.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class LiveKitOptions
{
    /// <summary>LIVEKIT_API_KEY. Public half; appears as the JWT issuer.</summary>
    public string ApiKey { get; set; } = "";

    /// <summary>LIVEKIT_API_SECRET. Signs tokens and verifies webhooks. Never logged,
    /// never serialised, never sent anywhere.</summary>
    public string ApiSecret { get; set; } = "";

    /// <summary>What the browser connects to — the ORIGIN only. livekit-client
    /// appends the signalling path itself, so a value ending in /rtc produces
    /// /rtc/rtc/v1 and a 401. Learned the hard way on 2026-08-17.</summary>
    public string PublicUrl { get; set; } = "wss://connect.tatvaos.com";

    /// <summary>Where the API reaches LiveKit's server API, inside the compose
    /// network. Not public, and not the same value as PublicUrl.</summary>
    public string InternalUrl { get; set; } = "http://livekit:7880";

    /// <summary>How long a minted join token is valid. A JOIN WINDOW, not a
    /// session limit: LiveKit keeps an established session alive past expiry,
    /// and a rejoin simply asks for a fresh one.</summary>
    public int TokenMinutes { get; set; } = 10;
}

/// <summary>
/// What one token is allowed to do. RoomAdmin is for host and cohost only,
/// and lets their client call room-admin APIs directly — the server-side host
/// controls in ConnectEndpoints do NOT rely on it, so a client that lies about
/// its role still cannot mute anyone.
/// </summary>
public sealed record LiveKitGrantOptions(
    string RoomName,
    string Identity,
    string DisplayName,
    bool CanPublish = true,
    bool CanSubscribe = true,
    bool RoomAdmin = false);

public sealed class LiveKitTokenService(IConfiguration config, ILogger<LiveKitTokenService> log)
{
    private readonly LiveKitOptions _options = Read(config);

    private static LiveKitOptions Read(IConfiguration config)
    {
        var o = new LiveKitOptions
        {
            ApiKey = config["LiveKit:ApiKey"] ?? config["LIVEKIT_API_KEY"] ?? "",
            ApiSecret = config["LiveKit:ApiSecret"] ?? config["LIVEKIT_API_SECRET"] ?? "",
            PublicUrl = config["LiveKit:PublicUrl"] ?? "wss://connect.tatvaos.com",
            InternalUrl = config["LiveKit:InternalUrl"] ?? "http://livekit:7880",
        };
        if (int.TryParse(config["LiveKit:TokenMinutes"], out var m) && m > 0) o.TokenMinutes = m;
        return o;
    }

    /// <summary>
    /// True when Connect is configured at all. Endpoints refuse with a plain
    /// sentence rather than throwing a 500 when it is false — a half-configured
    /// deploy should say so, not fail mysteriously.
    /// </summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_options.ApiKey) && !string.IsNullOrWhiteSpace(_options.ApiSecret);

    /// <summary>What the browser should connect to. Safe to send to a client.</summary>
    public string PublicUrl => _options.PublicUrl;

    internal string InternalUrl => _options.InternalUrl;
    internal string ApiKey => _options.ApiKey;
    internal string ApiSecret => _options.ApiSecret;

    /// <summary>
    /// Mint a join token for ONE room. There is deliberately no overload that
    /// omits the room.
    /// </summary>
    public string MintJoinToken(LiveKitGrantOptions grant)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("LiveKit is not configured; refusing to mint a token.");
        if (string.IsNullOrWhiteSpace(grant.RoomName))
            throw new ArgumentException("A LiveKit token must name exactly one room.", nameof(grant));

        var now = DateTimeOffset.UtcNow;
        var video = new VideoGrant
        {
            RoomJoin = true,
            Room = grant.RoomName,
            CanPublish = grant.CanPublish,
            CanSubscribe = grant.CanSubscribe,
            CanPublishData = true,          // in-meeting chat rides the data channel
            RoomAdmin = grant.RoomAdmin ? true : null,
        };

        var claims = new TokenClaims
        {
            Issuer = _options.ApiKey,
            Subject = grant.Identity,
            Name = grant.DisplayName,
            // 10 seconds of leeway: clock skew between this box and a laptop is
            // normal, and a token that is "not yet valid" fails with a message
            // nobody can act on.
            NotBefore = now.AddSeconds(-10).ToUnixTimeSeconds(),
            Expires = now.AddMinutes(_options.TokenMinutes).ToUnixTimeSeconds(),
            Video = video,
        };

        log.LogDebug("Minting LiveKit token for {Identity} in {Room}", grant.Identity, grant.RoomName);
        return Sign(claims);
    }

    /// <summary>
    /// Mint the token the API uses to command LiveKit's EGRESS service.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    ///  THIS ONE IS NOT ROOM-SCOPED, AND IT CANNOT BE.
    ///
    ///  Every other token this class produces names exactly one room, because
    ///  "a token that grants 'any room' is a token that joins any customer's
    ///  board meeting". LiveKit's roomRecord permission has no room field —
    ///  it is service-wide in its model — so this is the single exception,
    ///  and it is contained rather than justified:
    ///
    ///   • it is minted per HTTP call and lives ten minutes;
    ///   • it carries roomRecord and NOTHING else — no roomJoin, no room, no
    ///     publish, no subscribe, so it cannot enter a meeting even though it
    ///     can ask for one to be recorded;
    ///   • it is used only on the hop to livekit:7880 INSIDE the compose
    ///     network, and there is no code path that returns it to a caller.
    ///
    ///  If a future change ever hands this to a browser, the browser can
    ///  record any meeting on the platform. There is no second control.
    /// ─────────────────────────────────────────────────────────────────────
    /// </summary>
    internal string MintRecordToken()
    {
        if (!IsConfigured)
            throw new InvalidOperationException("LiveKit is not configured; refusing to mint a token.");

        var now = DateTimeOffset.UtcNow;
        var claims = new TokenClaims
        {
            Issuer = _options.ApiKey,
            Subject = "tatvaos-api",
            Name = "TatvaOS",
            NotBefore = now.AddSeconds(-10).ToUnixTimeSeconds(),
            Expires = now.AddMinutes(_options.TokenMinutes).ToUnixTimeSeconds(),
            Video = new VideoGrant
            {
                // Everything else is left at its default and SERIALISES AS
                // false — roomJoin:false, room:"", canPublish:false,
                // canSubscribe:false, canPublishData:false. Written out rather
                // than omitted on purpose: an explicit false is a claim a
                // reviewer can see, where an absent field has to be looked up.
                RoomRecord = true,
            },
        };
        return Sign(claims);
    }

    /// <summary>
    /// Verify an inbound LiveKit webhook.
    ///
    /// LiveKit signs the request with the same key pair: the Authorization
    /// header carries a JWT whose `sha256` claim is the base64 SHA-256 of the
    /// body. Checking BOTH the signature and the body hash is what makes the
    /// endpoint safe to expose — reachability is not the control, verification
    /// is. Returns false for anything it cannot prove.
    /// </summary>
    public bool VerifyWebhook(string? authorizationHeader, byte[] body)
    {
        if (!IsConfigured || string.IsNullOrWhiteSpace(authorizationHeader)) return false;

        var jwt = authorizationHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? authorizationHeader[7..].Trim()
            : authorizationHeader.Trim();

        var parts = jwt.Split('.');
        if (parts.Length != 3) return false;

        var signingInput = Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");
        byte[] provided;
        try { provided = FromBase64Url(parts[2]); }
        catch { return false; }

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_options.ApiSecret));
        var expected = hmac.ComputeHash(signingInput);
        if (!CryptographicOperations.FixedTimeEquals(expected, provided)) return false;

        JsonElement payload;
        try { payload = JsonSerializer.Deserialize<JsonElement>(FromBase64Url(parts[1])); }
        catch { return false; }

        // Expiry, if present. LiveKit sets one; a token without it is refused
        // rather than trusted.
        //
        // Read through ConnectWire, not TryGetInt64. `exp` is a JWT NumericDate
        // and LiveKit's Go library emits it as a number — but TryGetInt64
        // THROWS on a string rather than returning false, and TryGetProperty
        // throws if the decoded payload is not an object at all. An exception
        // thrown HERE, one line after the signature check, would take down
        // webhook verification itself. That is the same bug that emptied
        // connect.meeting_events, sitting on the security path.
        var exp = ConnectWire.Number(payload, "exp");
        if (exp is not long expiresAt) return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > expiresAt + 30) return false;

        // The body hash. Without this a valid signature could be replayed over
        // a DIFFERENT body — the signature would still check out.
        var declared = ConnectWire.Text(payload, "sha256");
        if (declared is null) return false;
        var actual = Convert.ToBase64String(SHA256.HashData(body));
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(declared ?? ""), Encoding.ASCII.GetBytes(actual));
    }

    // ------------------------------------------------------------------
    //  JWT plumbing. HS256, compact serialisation, base64url without padding.
    // ------------------------------------------------------------------
    private string Sign(TokenClaims claims)
    {
        var header = ToBase64Url(JsonSerializer.SerializeToUtf8Bytes(new JwtHeader()));
        var payload = ToBase64Url(JsonSerializer.SerializeToUtf8Bytes(claims, JsonOpts));
        var signingInput = Encoding.ASCII.GetBytes($"{header}.{payload}");

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_options.ApiSecret));
        var signature = ToBase64Url(hmac.ComputeHash(signingInput));
        return $"{header}.{payload}.{signature}";
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static string ToBase64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    private sealed class JwtHeader
    {
        [JsonPropertyName("alg")] public string Alg => "HS256";
        [JsonPropertyName("typ")] public string Typ => "JWT";
    }

    private sealed class TokenClaims
    {
        [JsonPropertyName("iss")] public string Issuer { get; set; } = "";
        [JsonPropertyName("sub")] public string Subject { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("nbf")] public long NotBefore { get; set; }
        [JsonPropertyName("exp")] public long Expires { get; set; }
        [JsonPropertyName("video")] public VideoGrant Video { get; set; } = new();
    }

    private sealed class VideoGrant
    {
        [JsonPropertyName("roomJoin")] public bool RoomJoin { get; set; }
        [JsonPropertyName("room")] public string Room { get; set; } = "";
        [JsonPropertyName("canPublish")] public bool CanPublish { get; set; }
        [JsonPropertyName("canSubscribe")] public bool CanSubscribe { get; set; }
        [JsonPropertyName("canPublishData")] public bool CanPublishData { get; set; }
        // Null rather than false so the claim is absent for ordinary
        // participants, matching what the LiveKit SDKs emit.
        [JsonPropertyName("roomAdmin")] public bool? RoomAdmin { get; set; }
        // Egress. Nullable for the same reason: absent on every join token
        // ever minted, present only on the internal record token above.
        [JsonPropertyName("roomRecord")] public bool? RoomRecord { get; set; }
    }
}

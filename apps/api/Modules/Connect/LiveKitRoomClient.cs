using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// The server half of the LiveKit conversation: what the API asks the media
/// server to DO, as opposed to the tokens it mints for browsers.
///
/// Host controls run through here rather than through the host's browser on
/// purpose. A client that lies about its role — an edited token, a replayed
/// one, a hand-rolled request — still cannot mute or remove anyone, because
/// the decision is taken here after ConnectEndpoints has checked the caller's
/// role in the database. The RoomAdmin grant on a host's token is a
/// convenience for their client, never the control.
///
/// LiveKit's server API is Twirp: POST JSON to
/// /twirp/livekit.RoomService/{Method}, authorised with a short-lived token
/// carrying roomAdmin for the room in question. Written against HttpClient
/// rather than the LiveKit server SDK because adding a NuGet dependency is a
/// change to a shared csproj, and this is four calls.
/// </summary>
public sealed class LiveKitRoomClient(
    HttpClient http,
    LiveKitTokenService tokens,
    ILogger<LiveKitRoomClient> log)
{
    /// <summary>Everyone LiveKit currently has in the room, with their tracks.</summary>
    public async Task<IReadOnlyList<LkParticipant>> ListParticipantsAsync(Guid meetingId, CancellationToken ct)
        => await TryListParticipantsAsync(meetingId, ct) ?? [];

    /// <summary>
    /// The same read, but able to say "I could not ask".
    ///
    /// NULL means LiveKit was unreachable or refused. An EMPTY LIST means it
    /// answered and the room really is empty. ListParticipantsAsync flattens
    /// the two to [], which is right for the host controls — you cannot mute
    /// anybody either way — and wrong for anything that makes a DECISION out
    /// of the emptiness. The recording gate does exactly that, and telling a
    /// host "nobody has joined" when the media server is down would send them
    /// looking in entirely the wrong place.
    /// </summary>
    public async Task<IReadOnlyList<LkParticipant>?> TryListParticipantsAsync(
        Guid meetingId, CancellationToken ct)
    {
        var response = await CallAsync(meetingId, "ListParticipants",
            new { room = ConnectCodes.RoomName(meetingId) }, ct);
        if (response is null) return null;

        try
        {
            var parsed = await response.Content.ReadFromJsonAsync<LkParticipantList>(WireJson, ct);
            return parsed?.Participants ?? [];
        }
        catch (JsonException ex)
        {
            // A body that will not deserialise is the media server being
            // unintelligible, which is the same thing to a caller as the media
            // server being unreachable: null, not an empty room. Telling a host
            // "nobody has joined" because a field changed shape would send them
            // looking in entirely the wrong place.
            log.LogWarning(ex, "LiveKit ListParticipants returned a body that could not be read");
            return null;
        }
    }

    /// <summary>
    /// The one place this file deserialises LiveKit's JSON into typed classes,
    /// and the settings that keep that safe.
    ///
    /// AllowReadingFromString is not optional here. LiveKit serialises protobuf
    /// with protojson, which renders every int64 as a JSON STRING — joinedAt,
    /// creationTime, any byte count. The classes below happen to hold only
    /// strings and bools today, so nothing breaks; the day somebody adds
    /// `public long JoinedAt`, the deserialiser would throw on a perfectly
    /// normal LiveKit response and the recording gate would start answering
    /// 502 to a room full of people. That exact class of surprise — a number
    /// arriving as a string — already cost this module a day.
    ///
    /// Everything hand-parsed goes through ConnectWire, which knows the same
    /// rule. This is the typed path saying it out loud.
    /// </summary>
    private static readonly JsonSerializerOptions WireJson = new()
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// Mute one person's microphone or camera.
    ///
    /// Two calls, because LiveKit mutes a TRACK and the API knows only the
    /// person: list the room, find their published track of that kind, mute
    /// it. Silently succeeds when they have no such track — asking to mute a
    /// camera that is already off is not an error worth surfacing to a host.
    /// </summary>
    public async Task<bool> MuteAsync(Guid meetingId, string identity, string kind, CancellationToken ct)
    {
        var participants = await ListParticipantsAsync(meetingId, ct);
        var person = participants.FirstOrDefault(p => p.Identity == identity);
        if (person is null) return false;

        // 'screen' targets the SOURCE, not the media type: a screen share is a
        // VIDEO track like a camera is, and matching on type alone would stop
        // the presenter's face when the host meant to stop their slides.
        var track = kind == "screen"
            ? person.Tracks?.FirstOrDefault(t =>
                string.Equals(t.Source, "SCREEN_SHARE", StringComparison.OrdinalIgnoreCase) && !t.Muted)
            : person.Tracks?.FirstOrDefault(t =>
                string.Equals(t.Type, kind, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(t.Source, "SCREEN_SHARE", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(t.Source, "SCREEN_SHARE_AUDIO", StringComparison.OrdinalIgnoreCase)
                && !t.Muted);
        if (track is null) return true;

        var response = await CallAsync(meetingId, "MutePublishedTrack", new
        {
            room = ConnectCodes.RoomName(meetingId),
            identity,
            track_sid = track.Sid,
            muted = true,
        }, ct);
        return response is not null;
    }

    /// <summary>Remove someone from the room. Their next join needs re-admission.</summary>
    public async Task<bool> RemoveAsync(Guid meetingId, string identity, CancellationToken ct)
    {
        var response = await CallAsync(meetingId, "RemoveParticipant", new
        {
            room = ConnectCodes.RoomName(meetingId),
            identity,
        }, ct);
        return response is not null;
    }

    /// <summary>
    /// Change what one CONNECTED participant may publish, live, without
    /// disconnecting them. This is how a share-policy change reaches people
    /// already in the room — their token was minted under the old policy and
    /// tokens cannot be recalled.
    ///
    /// `sources` follows the same convention as the token grant: NULL means
    /// "all sources". The spelling differs, though, and the difference is a
    /// protojson rule worth writing down: the JWT grant carries TrackSource as
    /// lower_snake strings ("screen_share"), but the Twirp API's
    /// ParticipantPermission.can_publish_sources is a protobuf ENUM, which
    /// protojson serialises by its NAME — "SCREEN_SHARE". Same concept, two
    /// spellings, chosen by which wire you are on.
    ///
    /// UpdateParticipant REPLACES the whole permission object rather than
    /// merging, so canPublish/canSubscribe/canPublishData are restated every
    /// time. Omitting them here would revoke a participant's microphone as a
    /// side effect of changing who may share — silently, mid-sentence.
    /// </summary>
    public async Task<bool> SetPublishSourcesAsync(
        Guid meetingId, string identity, string[]? sources, CancellationToken ct)
    {
        var enumNames = sources?.Select(s => s.ToUpperInvariant()).ToArray();
        var response = await CallAsync(meetingId, "UpdateParticipant", new
        {
            room = ConnectCodes.RoomName(meetingId),
            identity,
            permission = new
            {
                can_subscribe = true,
                can_publish = true,
                can_publish_data = true,
                // Empty/absent = all sources, matching the token grant's rule.
                can_publish_sources = enumNames ?? [],
            },
        }, ct);
        return response is not null;
    }

    /// <summary>
    /// End the meeting for everyone. Deleting the room disconnects every
    /// participant; the room_finished webhook then stamps ended_at, so the
    /// database learns it from the media server rather than from our optimism.
    /// </summary>
    public async Task<bool> EndAsync(Guid meetingId, CancellationToken ct)
    {
        var response = await CallAsync(meetingId, "DeleteRoom",
            new { room = ConnectCodes.RoomName(meetingId) }, ct);
        return response is not null;
    }

    // ------------------------------------------------------------------
    //  One place that talks to LiveKit, so one place that fails gracefully.
    //
    //  A media server that is down must not take the API down with it: host
    //  controls return false and the endpoint answers 502 with a sentence,
    //  rather than throwing a 500 that says nothing.
    // ------------------------------------------------------------------
    private async Task<HttpResponseMessage?> CallAsync(Guid meetingId, string method, object body, CancellationToken ct)
    {
        if (!tokens.IsConfigured)
        {
            log.LogWarning("LiveKit is not configured; refusing to call {Method}", method);
            return null;
        }

        // Two different grants, because LiveKit checks two different ones.
        //
        // roomAdmin authorises operations on the PEOPLE in a room — mute,
        // remove, update, list. Room LIFECYCLE — CreateRoom, DeleteRoom,
        // ListRooms — is checked against roomCreate instead, and a token
        // carrying only roomAdmin is answered:
        //
        //     status 401, "permissions denied", code "unauthenticated"
        //
        // which is precisely what "End the meeting for everyone" did, in
        // production, while every other host control worked. The failure was
        // invisible from our side: EndAsync saw a null response and answered
        // 502 with a sentence, and the reason was only ever in LiveKit's log.
        var lifecycle = method is "DeleteRoom" or "CreateRoom" or "ListRooms";
        var admin = lifecycle
            ? tokens.MintRoomLifecycleToken()
            : tokens.MintJoinToken(new LiveKitGrantOptions(
                RoomName: ConnectCodes.RoomName(meetingId),
                Identity: "tatvaos-api",
                DisplayName: "TatvaOS",
                CanPublish: false,
                CanSubscribe: false,
                RoomAdmin: true));

        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"{tokens.InternalUrl.TrimEnd('/')}/twirp/livekit.RoomService/{method}")
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin);

        try
        {
            var response = await http.SendAsync(request, ct);
            if (response.IsSuccessStatusCode) return response;

            var detail = await response.Content.ReadAsStringAsync(ct);
            log.LogWarning("LiveKit {Method} returned {Status}: {Detail}",
                method, (int)response.StatusCode, detail);
            return null;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogError(ex, "LiveKit {Method} could not be reached", method);
            return null;
        }
    }
}

public sealed class LkParticipantList
{
    [JsonPropertyName("participants")] public List<LkParticipant>? Participants { get; set; }
}

public sealed class LkParticipant
{
    [JsonPropertyName("sid")] public string? Sid { get; set; }
    [JsonPropertyName("identity")] public string? Identity { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("state")] public string? State { get; set; }
    [JsonPropertyName("tracks")] public List<LkTrack>? Tracks { get; set; }
}

public sealed class LkTrack
{
    [JsonPropertyName("sid")] public string? Sid { get; set; }
    /// <summary>"AUDIO" or "VIDEO" in LiveKit's JSON enum rendering.</summary>
    [JsonPropertyName("type")] public string? Type { get; set; }
    /// <summary>"CAMERA", "MICROPHONE", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO" —
    /// protojson renders the TrackSource enum by NAME. What tells a camera
    /// from a screen share, which the type field cannot.</summary>
    [JsonPropertyName("source")] public string? Source { get; set; }
    [JsonPropertyName("muted")] public bool Muted { get; set; }
}

using System.Net.Http.Headers;
using System.Net.Http.Json;
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
    {
        var response = await CallAsync(meetingId, "ListParticipants",
            new { room = ConnectCodes.RoomName(meetingId) }, ct);
        if (response is null) return [];

        var parsed = await response.Content.ReadFromJsonAsync<LkParticipantList>(ct);
        return parsed?.Participants ?? [];
    }

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

        var track = person.Tracks?.FirstOrDefault(t =>
            string.Equals(t.Type, kind, StringComparison.OrdinalIgnoreCase) && !t.Muted);
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

        var admin = tokens.MintJoinToken(new LiveKitGrantOptions(
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
    [JsonPropertyName("muted")] public bool Muted { get; set; }
}

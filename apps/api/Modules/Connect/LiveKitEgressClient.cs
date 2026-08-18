using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Recording. The API asks LiveKit's Egress service to record a room; the
/// bytes are written by the egress container into a volume this container can
/// read, and nothing about media passes through here.
///
/// ─────────────────────────────────────────────────────────────────────────
///  AUDIO IS THE DEFAULT, AND IT IS A MEASURED CHOICE, NOT A SHORTCUT.
///
///  LiveKit's own admission controller prices a room-composite VIDEO egress at
///  4 CPU and an AUDIO-ONLY one at 1 (egress/pkg/config/service.go). The
///  reason is in egress/pkg/config/pipeline.go: ShouldUseSDKSource returns
///  true when audio_only is set AND layout is empty AND there is no custom
///  base url, and an SDK-source egress never launches Chrome at all. Video
///  composites a browser page and re-encodes it.
///
///  Connect runs on ONE box that is already carrying the SFU. On that box the
///  difference between 1 and 4 CPU is the difference between recording a
///  meeting and degrading it for everyone in it. So audio is the default in
///  the API, in the UI, and in the schema; video is offered and says what it
///  costs.
///
///  THIS IS WHY AUDIO MODE MUST NOT SET A LAYOUT. Setting one silently moves
///  the request onto the Chrome path — same output, four times the cost, no
///  error anywhere. If you ever add a layout option, read ShouldUseSDKSource
///  first.
///
///  THE RECORD TOKEN IS NOT A JOIN TOKEN. LiveKit's roomRecord grant is
///  service-wide by design — there is no per-room recording permission in its
///  model. That token therefore never leaves this process: it is minted for
///  one HTTP call to livekit:7880 inside the compose network, lives ten
///  minutes, and is never handed to a browser. Browsers keep receiving
///  room-scoped join tokens and nothing else (brief §7).
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class LiveKitEgressClient(
    HttpClient http,
    LiveKitTokenService tokens,
    ConnectRecordingOptions options,
    ILogger<LiveKitEgressClient> log)
{
    /// <summary>What LiveKit told us about one egress. Every field is optional
    /// because this is external input and a missing field must not throw.</summary>
    public sealed record EgressState(
        string? EgressId,
        string? Status,
        string? Error,
        string? FileName,
        long SizeBytes,
        long? DurationMs,
        DateTimeOffset? StartedAt,
        DateTimeOffset? EndedAt);

    public bool IsConfigured => tokens.IsConfigured && options.Enabled;

    /// <summary>
    /// Begin recording a room. Returns null when LiveKit refuses or cannot be
    /// reached — the caller answers 502 with a sentence rather than throwing.
    /// </summary>
    public async Task<EgressState?> StartAsync(
        Guid meetingId, string mode, string fileName, CancellationToken ct)
    {
        var isVideo = mode == "video";
        var filepath = $"{options.OutputDirectory.TrimEnd('/')}/{fileName}";

        // disable_manifest: without it egress writes a .json manifest beside
        // every file. It would land in the same volume, count against nothing,
        // and make the directory's contents disagree with the table.
        var output = new Dictionary<string, object?>
        {
            ["file_type"] = isVideo ? "MP4" : "OGG",
            ["filepath"] = filepath,
            ["disable_manifest"] = true,
        };

        var request = new Dictionary<string, object?>
        {
            ["room_name"] = ConnectCodes.RoomName(meetingId),
            ["file_outputs"] = new[] { output },
        };

        if (isVideo)
        {
            // A layout is REQUIRED here and must be ABSENT below — see the
            // header. 'grid' is the layout a meeting actually looks like.
            request["layout"] = "grid";
            request["preset"] = options.VideoPreset;
        }
        else
        {
            request["audio_only"] = true;
        }

        var root = await CallAsync("StartRoomCompositeEgress", request, ct);
        return root is null ? null : ReadEgress(root.Value);
    }

    /// <summary>Stop one egress. LiveKit finalises the file and then sends
    /// egress_ended, which is what actually marks the row ready.</summary>
    public async Task<EgressState?> StopAsync(string egressId, CancellationToken ct)
    {
        var root = await CallAsync("StopEgress",
            new Dictionary<string, object?> { ["egress_id"] = egressId }, ct);
        return root is null ? null : ReadEgress(root.Value);
    }

    /// <summary>
    /// Ask LiveKit about one egress directly.
    ///
    /// The webhook is the normal path and this is the repair: if a webhook is
    /// lost, a recording would sit in 'recording' forever and the file would
    /// never be linked to its row. The worker calls this for anything stuck,
    /// so a missed callback costs a delay rather than a lost recording.
    /// </summary>
    public async Task<EgressState?> DescribeAsync(string egressId, CancellationToken ct)
    {
        var root = await CallAsync("ListEgress",
            new Dictionary<string, object?> { ["egress_id"] = egressId }, ct);
        if (root is null) return null;

        if (!root.Value.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
            return null;
        foreach (var item in items.EnumerateArray()) return ReadEgress(item);
        return null;
    }

    // ------------------------------------------------------------------
    //  One place that talks to Egress, so one place that fails gracefully —
    //  the same shape as LiveKitRoomClient.CallAsync, and for the same
    //  reason: a media server that is down must not take the API with it.
    // ------------------------------------------------------------------
    private async Task<JsonElement?> CallAsync(string method, object body, CancellationToken ct)
    {
        if (!tokens.IsConfigured)
        {
            log.LogWarning("LiveKit is not configured; refusing to call Egress.{Method}", method);
            return null;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"{tokens.InternalUrl.TrimEnd('/')}/twirp/livekit.Egress/{method}")
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Authorization =
            new AuthenticationHeaderValue("Bearer", tokens.MintRecordToken());

        try
        {
            var response = await http.SendAsync(request, ct);
            var payload = await response.Content.ReadAsStringAsync(ct);

            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("LiveKit Egress.{Method} returned {Status}: {Detail}",
                    method, (int)response.StatusCode, payload);
                return null;
            }

            return JsonDocument.Parse(payload).RootElement.Clone();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            log.LogError(ex, "LiveKit Egress.{Method} could not be reached", method);
            return null;
        }
    }

    // ==================================================================
    //  Reading LiveKit's JSON.
    //
    //  Twirp and the webhooks both serialise protobuf with protojson, which
    //  emits lowerCamelCase field names AND renders every int64 as a JSON
    //  STRING. Both of those are easy to get wrong in a way that compiles,
    //  runs, and quietly produces zero — which is exactly the class of bug
    //  that already cost this module a day. So nothing here is deserialised
    //  into a typed class: every field is read by name, both spellings are
    //  accepted, and every number goes through a reader that takes a string
    //  or a number.
    // ==================================================================
    internal static EgressState ReadEgress(JsonElement e)
    {
        var (fileName, size, durationNs) = ReadFirstFile(e);

        return new EgressState(
            EgressId: Text(e, "egressId", "egress_id"),
            Status: Text(e, "status"),
            Error: NullIfBlank(Text(e, "error")),
            FileName: fileName,
            SizeBytes: size,
            DurationMs: durationNs is long ns && ns > 0 ? ns / 1_000_000 : null,
            StartedAt: Instant(e, "startedAt", "started_at"),
            EndedAt: Instant(e, "endedAt", "ended_at"));
    }

    private static (string? Name, long Size, long? DurationNs) ReadFirstFile(JsonElement e)
    {
        if (!TryProperty(e, out var files, "fileResults", "file_results")
            || files.ValueKind != JsonValueKind.Array)
            return (null, 0, null);

        foreach (var f in files.EnumerateArray())
        {
            // 'filename' is the full path egress wrote to. The database stores
            // the leaf only — the directory is configuration, not data, and a
            // stored absolute path would be wrong the day the mount moves.
            var full = Text(f, "filename");
            var leaf = string.IsNullOrEmpty(full) ? null : full[(full.LastIndexOf('/') + 1)..];
            return (NullIfBlank(leaf), Number(f, "size") ?? 0, Number(f, "duration"));
        }
        return (null, 0, null);
    }

    private static bool TryProperty(JsonElement e, out JsonElement value, params string[] names)
    {
        foreach (var name in names)
            if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out value))
                return true;
        value = default;
        return false;
    }

    private static string? Text(JsonElement e, params string[] names) =>
        TryProperty(e, out var v, names) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    /// <summary>protojson renders int64 as a STRING. Accepts either.</summary>
    private static long? Number(JsonElement e, params string[] names)
    {
        if (!TryProperty(e, out var v, names)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.TryGetInt64(out var n) ? n : null,
            JsonValueKind.String => long.TryParse(v.GetString(), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out var s) ? s : null,
            _ => null,
        };
    }

    /// <summary>EgressInfo timestamps are UNIX NANOSECONDS, unlike the
    /// webhook envelope's createdAt which is seconds. Getting that wrong puts
    /// a recording in the year 55000 and no test would notice.</summary>
    private static DateTimeOffset? Instant(JsonElement e, params string[] names)
    {
        var ns = Number(e, names);
        if (ns is not long value || value <= 0) return null;
        return DateTimeOffset.FromUnixTimeMilliseconds(value / 1_000_000);
    }
}

/// <summary>
/// Everything about recording that an operator can change without a rebuild.
///
/// Registered as a singleton and read once at start, like LiveKitOptions — a
/// setting that can change under a running request is a setting two requests
/// can disagree about.
/// </summary>
public sealed class ConnectRecordingOptions
{
    /// <summary>
    /// Master switch. False — the default — means every recording endpoint
    /// answers "Recording is not switched on for this server." rather than
    /// failing somewhere deeper. Recording needs a container that may not be
    /// deployed, so "not configured" is a normal state that deserves a plain
    /// sentence.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>Where the EGRESS container writes. Must be the same directory
    /// this container reads, mounted from the same volume.</summary>
    public string OutputDirectory { get; set; } = "/var/lib/connect/recordings";

    /// <summary>Where THIS container reads them from. Separate setting because
    /// the two containers are free to mount the volume at different paths, and
    /// assuming they match is the kind of assumption that survives review and
    /// fails at 3 a.m.</summary>
    public string ReadDirectory { get; set; } = "/var/lib/connect/recordings";

    /// <summary>LiveKit encoding preset for video mode. Only consulted when
    /// somebody explicitly asks for video.</summary>
    public string VideoPreset { get; set; } = "H264_720P_30";

    /// <summary>Refuse to start a recording when the organisation's pool is
    /// this close to full, in bytes. A recording that fills the disk takes
    /// Mail down with it — one box, one filesystem.</summary>
    public long MinimumFreeBytes { get; set; } = 1L * 1024 * 1024 * 1024;

    // ---- Transcription -------------------------------------------------
    /// <summary>An OpenAI-compatible /v1/audio/transcriptions endpoint. EMPTY
    /// BY DEFAULT, and that is deliberate: with no value set, no audio leaves
    /// this server and transcripts are honestly marked 'unavailable'.</summary>
    public string TranscriptionUrl { get; set; } = "";
    public string TranscriptionKey { get; set; } = "";
    public string TranscriptionModel { get; set; } = "whisper-1";
    /// <summary>ISO code, or empty to let the service detect it. Worth setting
    /// for a school in one language — detection is the main source of
    /// nonsense on short or noisy recordings.</summary>
    public string TranscriptionLanguage { get; set; } = "";
    public int TranscriptionTimeoutMinutes { get; set; } = 30;

    // ---- Notes ---------------------------------------------------------
    /// <summary>An OpenAI-compatible /v1/chat/completions endpoint. Empty means
    /// notes are assembled on this box from the transcript with no model
    /// involved, and are labelled 'digest' so nobody mistakes them for a
    /// summary somebody wrote.</summary>
    public string NotesUrl { get; set; } = "";
    public string NotesKey { get; set; } = "";
    public string NotesModel { get; set; } = "";
    public int NotesTimeoutMinutes { get; set; } = 10;

    public bool TranscriptionConfigured => !string.IsNullOrWhiteSpace(TranscriptionUrl);
    public bool NotesModelConfigured =>
        !string.IsNullOrWhiteSpace(NotesUrl) && !string.IsNullOrWhiteSpace(NotesModel);

    public static ConnectRecordingOptions Read(IConfiguration config)
    {
        var o = new ConnectRecordingOptions();
        var s = config.GetSection("Connect:Recording");

        o.Enabled = Flag(s["Enabled"]);
        o.OutputDirectory = NonEmpty(s["OutputDirectory"], o.OutputDirectory);
        o.ReadDirectory = NonEmpty(s["ReadDirectory"], o.OutputDirectory);
        o.VideoPreset = NonEmpty(s["VideoPreset"], o.VideoPreset);
        if (long.TryParse(s["MinimumFreeBytes"], out var free) && free >= 0) o.MinimumFreeBytes = free;

        o.TranscriptionUrl = (s["TranscriptionUrl"] ?? "").Trim();
        o.TranscriptionKey = (s["TranscriptionKey"] ?? "").Trim();
        o.TranscriptionModel = NonEmpty(s["TranscriptionModel"], o.TranscriptionModel);
        o.TranscriptionLanguage = (s["TranscriptionLanguage"] ?? "").Trim();
        if (int.TryParse(s["TranscriptionTimeoutMinutes"], out var tt) && tt > 0)
            o.TranscriptionTimeoutMinutes = tt;

        o.NotesUrl = (s["NotesUrl"] ?? "").Trim();
        o.NotesKey = (s["NotesKey"] ?? "").Trim();
        o.NotesModel = (s["NotesModel"] ?? "").Trim();
        if (int.TryParse(s["NotesTimeoutMinutes"], out var nt) && nt > 0) o.NotesTimeoutMinutes = nt;

        return o;
    }

    private static string NonEmpty(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    private static bool Flag(string? value) =>
        value is not null && (value.Equals("true", StringComparison.OrdinalIgnoreCase) || value == "1");
}

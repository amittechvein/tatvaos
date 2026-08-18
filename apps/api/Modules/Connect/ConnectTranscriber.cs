using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Turns a recording into text.
///
/// ─────────────────────────────────────────────────────────────────────────
///  NOTHING LEAVES THIS SERVER UNLESS SOMEBODY SETS A URL.
///
///  Connect:Recording:TranscriptionUrl is EMPTY by default, and with no value
///  set this class does nothing at all: the transcript row is marked
///  'unavailable' with a sentence saying so. That is the whole point of the
///  default. Connect's market is schools and clinics in India, where "the
///  audio of every lesson was posted to a company abroad" is not a footnote —
///  and a feature that quietly starts doing that because it shipped switched
///  on is not one anybody can take back.
///
///  THE CONTRACT IS OPENAI'S /v1/audio/transcriptions, AND THAT IS THE POINT.
///  It is the shape every self-hosted Whisper server, every Indian STT
///  vendor and every large provider already speaks. So the choice between
///  "on this box", "on a second box of ours" and "somebody else's API" is
///  three environment variables and no code — which keeps it a decision that
///  can be revisited rather than one baked into a build.
///
///  response_format=verbose_json is asked for because it carries the TIMELINE.
///  A wall of text is a poor transcript: you cannot jump to the bit you want,
///  and the notes step cannot tell a two-minute answer from a passing remark.
///  A service that ignores the request and returns plain text still works —
///  the whole transcript becomes one segment — because a degraded transcript
///  beats a failed one.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ConnectTranscriber(
    HttpClient http,
    ConnectRecordingOptions options,
    ILogger<ConnectTranscriber> log)
{
    public sealed record Segment(double Start, double End, string Text, string? Speaker);

    public sealed record Result(
        bool Ok,
        string? Text,
        IReadOnlyList<Segment> Segments,
        string? Language,
        long? DurationMs,
        string? Error);

    public bool IsConfigured => options.TranscriptionConfigured;

    public async Task<Result> TranscribeAsync(string path, string contentType, CancellationToken ct)
    {
        if (!IsConfigured)
            return new Result(false, null, [], null, null,
                "No transcription service is configured for this server.");

        if (!File.Exists(path))
            return new Result(false, null, [], null, null, "The recording file is missing.");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(options.TranscriptionTimeoutMinutes));

        try
        {
            using var form = new MultipartFormDataContent();

            // Streamed, not read into memory: an hour of Opus is ~30 MB and an
            // hour of MP4 is far more, and this process is also serving
            // requests. FileShare.Read so a concurrent download of the same
            // recording is not blocked by the transcription of it.
            await using var file = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.Read, bufferSize: 64 * 1024, useAsync: true);

            var content = new StreamContent(file);
            content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            // The FILE NAME matters: most OpenAI-compatible servers decide how
            // to decode from the extension, not from the content type.
            form.Add(content, "file", Path.GetFileName(path));
            form.Add(new StringContent(options.TranscriptionModel), "model");
            form.Add(new StringContent("verbose_json"), "response_format");
            if (!string.IsNullOrWhiteSpace(options.TranscriptionLanguage))
                form.Add(new StringContent(options.TranscriptionLanguage), "language");

            using var request = new HttpRequestMessage(HttpMethod.Post, options.TranscriptionUrl)
            {
                Content = form,
            };
            if (!string.IsNullOrWhiteSpace(options.TranscriptionKey))
                request.Headers.Authorization =
                    new AuthenticationHeaderValue("Bearer", options.TranscriptionKey);

            var response = await http.SendAsync(request, timeout.Token);
            var payload = await response.Content.ReadAsStringAsync(timeout.Token);

            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("Transcription returned {Status}", (int)response.StatusCode);
                // The BODY is not put in the error the user sees: it can carry
                // a provider's key echo or an internal path. The status is
                // enough to act on and the rest is in the log.
                return new Result(false, null, [], null, null,
                    $"The transcription service answered {(int)response.StatusCode}.");
            }

            return Parse(payload);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new Result(false, null, [], null, null,
                $"Transcription took longer than {options.TranscriptionTimeoutMinutes} minutes.");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or JsonException)
        {
            log.LogError(ex, "Transcription failed");
            return new Result(false, null, [], null, null, "The transcription service could not be reached.");
        }
    }

    // ------------------------------------------------------------------
    //  Reading the answer. Written to survive a service that returns less
    //  than asked for, because half of them do.
    // ------------------------------------------------------------------
    private static Result Parse(string payload)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(payload).RootElement; }
        catch (JsonException) { return new Result(false, null, [], null, null, "Unreadable answer."); }

        if (root.ValueKind != JsonValueKind.Object)
            return new Result(false, null, [], null, null, "Unreadable answer.");

        var text = Str(root, "text");
        var language = Str(root, "language");
        var duration = Dbl(root, "duration");

        var segments = new List<Segment>();
        if (root.TryGetProperty("segments", out var segs) && segs.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in segs.EnumerateArray())
            {
                var body = Str(s, "text")?.Trim();
                if (string.IsNullOrEmpty(body)) continue;
                segments.Add(new Segment(
                    Dbl(s, "start") ?? 0,
                    Dbl(s, "end") ?? 0,
                    body,
                    // Reserved. Nothing produces it today — a room-composite
                    // recording is one mixed stream and there is nothing in it
                    // to attribute. A per-track egress would fill this in.
                    Str(s, "speaker")));
            }
        }

        // A service that ignored response_format gives text and no segments.
        // One segment covering the whole recording is a worse transcript, not
        // a broken one.
        if (segments.Count == 0 && !string.IsNullOrWhiteSpace(text))
            segments.Add(new Segment(0, duration ?? 0, text.Trim(), null));

        if (segments.Count == 0)
            return new Result(false, null, [], language, null,
                "The transcription service returned nothing. The recording may be silent.");

        // Rebuild the flat text from the segments when the service did not
        // send one, so `text` and `segments` can never disagree.
        var whole = string.IsNullOrWhiteSpace(text)
            ? string.Join(" ", segments.Select(s => s.Text))
            : text.Trim();

        return new Result(true, whole, segments, language,
            duration is double d && d > 0 ? (long)(d * 1000) : null, null);
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object
        && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;

    private static double? Dbl(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.TryGetDouble(out var n) ? n : null,
            // Some servers send numbers as strings. Invariant culture on
            // purpose: a server in a comma-decimal locale would otherwise
            // parse "12.5" as 125.
            JsonValueKind.String => double.TryParse(v.GetString(), NumberStyles.Float,
                CultureInfo.InvariantCulture, out var s) ? s : null,
            _ => null,
        };
    }

    /// <summary>
    /// The transcript as a person would read it: one line per segment, with a
    /// timestamp. This is what is handed to a notes model and what a person
    /// downloads, so it is generated in ONE place rather than formatted
    /// differently in each.
    /// </summary>
    public static string Render(IReadOnlyList<Segment> segments)
    {
        var sb = new StringBuilder();
        foreach (var s in segments)
        {
            var t = TimeSpan.FromSeconds(s.Start);
            sb.Append('[')
              .Append(((int)t.TotalHours).ToString("00", CultureInfo.InvariantCulture))
              .Append(':').Append(t.Minutes.ToString("00", CultureInfo.InvariantCulture))
              .Append(':').Append(t.Seconds.ToString("00", CultureInfo.InvariantCulture))
              .Append("] ");
            if (!string.IsNullOrWhiteSpace(s.Speaker)) sb.Append(s.Speaker).Append(": ");
            sb.AppendLine(s.Text);
        }
        return sb.ToString();
    }
}

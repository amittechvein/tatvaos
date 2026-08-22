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

    /// <param name="Permanent">
    /// This will NEVER succeed on a retry, so the caller must stop rather than
    /// queue it again.
    ///
    /// Added 22 August 2026, the day the first real recording was transcribed.
    /// A 95-second meeting produced a 36 MB MP4, the service refused it with
    /// 413, and the worker — which treats every failure as "the service was
    /// probably restarting" — uploaded those same 36 MB twice more to be told
    /// the same thing. Three refusals, 108 MB, one outcome.
    ///
    /// The distinction that matters is not error versus success, it is
    /// TRANSIENT versus PERMANENT. Retrying a transient failure is the right
    /// thing; retrying a permanent one is a way to spend bandwidth and time
    /// arriving at the answer you already had.
    /// </param>
    public sealed record Result(
        bool Ok,
        string? Text,
        IReadOnlyList<Segment> Segments,
        string? Language,
        long? DurationMs,
        string? Error,
        bool Permanent = false);

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

        // ── STRIP THE PICTURE BEFORE SENDING ──────────────────────────────
        // A meeting recording is video. A transcription service wants speech.
        // Sending the MP4 means paying to upload a picture nobody will look
        // at, and on 22 August it meant a 95-second meeting arriving as 36 MB
        // against a 25 MB limit — i.e. the feature could not work AT ALL, for
        // any meeting, however short.
        var (uploadPath, uploadType, isTemporary, prepError) =
            await PrepareAudioAsync(path, contentType, timeout.Token);

        if (prepError is not null)
            return new Result(false, null, [], null, null, prepError, Permanent: true);

        try
        {
            // ── ASK FOR THE TIMELINE, ACCEPT LESS ─────────────────────────
            //
            // verbose_json is what carries per-segment timestamps, and a
            // transcript without them is a wall of text you cannot navigate.
            // whisper-1 supports it. gpt-4o-transcribe and its diarize sibling
            // do NOT — they answer 400 "not compatible with model".
            //
            // So the format is negotiated rather than configured. A setting
            // would work right up until somebody changed the model and not the
            // format, and got a 400 that reads like an outage; the code can
            // simply find out. One extra round trip, once per recording, only
            // on services that refuse — and it means switching model stays a
            // one-line change to .env, which is the property this whole module
            // was built around.
            var chunks = await SplitIfLongAsync(uploadPath, timeout.Token);
            try
            {
                var format = "verbose_json";
                var merged = new List<Segment>();
                var text = new StringBuilder();
                string? language = null;
                double totalSeconds = 0;

                foreach (var chunk in chunks)
                {
                    var (status, payload) = await SendAsync(
                        chunk.Path, uploadType, format, timeout.Token);

                    // Negotiated once, then remembered. Asking every chunk of a
                    // three-hour meeting to rediscover the same refusal would be
                    // one wasted round trip per twenty minutes.
                    if (status == 400 && format == "verbose_json")
                    {
                        log.LogInformation(
                            "{Model} refused verbose_json; using plain json (no timestamps).",
                            options.TranscriptionModel);
                        format = "json";
                        (status, payload) = await SendAsync(
                            chunk.Path, uploadType, format, timeout.Token);
                    }

                    if (status is < 200 or >= 300)
                    {
                        var permanent = IsPermanent(status);

                        // ── THE PROVIDER'S OWN WORDS, ON PURPOSE ──────────
                        //
                        // ConnectNotesComposer deliberately logs only 'code'
                        // and 'param' from an error body, never the message,
                        // because there we SEND THE TRANSCRIPT and a provider's
                        // error can quote back what it was given — which is a
                        // meeting, in a log file, at rest, in every backup.
                        //
                        // Here we send AUDIO. There is no customer text in the
                        // request for an error to echo, and the messages are
                        // exactly the ones an operator needs: "audio duration
                        // 1891.9 seconds is longer than 1400 seconds which is
                        // the maximum for this model" told us in one line what
                        // a 400 alone could not. Capped at 300 characters so a
                        // provider that decides to be verbose cannot fill the
                        // log.
                        //
                        // The distinction is what is IN the request, not which
                        // company answered it. If a transcription endpoint ever
                        // starts taking text prompts, this reasoning expires.
                        log.LogWarning(
                            "Transcription returned {Status} for {Bytes} bytes ({Kind}) — {Verdict}. Service said: {Detail}",
                            status, new FileInfo(chunk.Path).Length, uploadType,
                            permanent ? "permanent, will not retry" : "transient, will retry",
                            ErrorMessage(payload) ?? "(no message)");

                        // The BODY is not put in the error the user sees: it can
                        // carry a provider's key echo or an internal path. The
                        // status is enough to act on and the rest is in the log.
                        return new Result(false, null, [], null, null,
                            Explain(status), permanent);
                    }

                    var part = Parse(payload);

                    // ONE BAD PIECE FAILS THE WHOLE THING, deliberately.
                    // Returning the parts that worked would produce a transcript
                    // with a silent hole in the middle, presented as complete —
                    // and a record that is confidently incomplete is worse than
                    // no record, because nobody knows to go and listen.
                    if (!part.Ok) return part;

                    language ??= part.Language;
                    if (text.Length > 0) text.Append(' ');
                    text.Append(part.Text);

                    foreach (var s in part.Segments)
                        merged.Add(s with
                        {
                            Start = s.Start + chunk.OffsetSeconds,
                            End = s.End + chunk.OffsetSeconds,
                        });

                    totalSeconds = chunk.OffsetSeconds
                        + (part.DurationMs is long ms ? ms / 1000.0 : 0);
                }

                return new Result(
                    true, text.ToString().Trim(), merged, language,
                    totalSeconds > 0 ? (long)(totalSeconds * 1000) : null, null);
            }
            finally
            {
                // The chunks live in a directory of their own, so removing that
                // removes all of them and the directory with it. A three-hour
                // meeting leaves nine files behind otherwise, on a box whose
                // disk is the same one Mail writes to.
                foreach (var directory in chunks
                    .Where(c => c.Temporary)
                    .Select(c => Path.GetDirectoryName(c.Path))
                    .Where(d => !string.IsNullOrEmpty(d))
                    .Distinct())
                {
                    try { Directory.Delete(directory!, recursive: true); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
            }
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
        finally
        {
            // Ours to clean up, and ONLY ours: isTemporary is false when we
            // sent the recording itself, and deleting that would destroy a
            // customer's meeting to save a few megabytes of scratch space.
            if (isTemporary)
            {
                try { File.Delete(uploadPath); }
                catch (IOException) { /* a full /tmp is not worth failing a good transcript over */ }
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    /// <summary>
    /// One POST. Separated out so the format can be retried without the caller
    /// worrying about a consumed stream: the file handle and the multipart body
    /// are BUILT FRESH EACH TIME, because an HttpContent can only be sent once
    /// and reusing one is a bug that shows up as an empty upload rather than an
    /// exception.
    /// </summary>
    private async Task<(int Status, string Payload)> SendAsync(
        string uploadPath, string uploadType, string responseFormat, CancellationToken ct)
    {
        using var form = new MultipartFormDataContent();

        // Streamed, not read into memory: an hour of Opus is ~30 MB and an
        // hour of MP4 is far more, and this process is also serving requests.
        // FileShare.Read so a concurrent download of the same recording is not
        // blocked by the transcription of it.
        await using var file = new FileStream(uploadPath, FileMode.Open, FileAccess.Read,
            FileShare.Read, bufferSize: 64 * 1024, useAsync: true);

        var content = new StreamContent(file);
        content.Headers.ContentType = new MediaTypeHeaderValue(uploadType);
        // The FILE NAME matters: most OpenAI-compatible servers decide how to
        // decode from the extension, not from the content type.
        form.Add(content, "file", Path.GetFileName(uploadPath));
        form.Add(new StringContent(options.TranscriptionModel), "model");
        form.Add(new StringContent(responseFormat), "response_format");
        if (!string.IsNullOrWhiteSpace(options.TranscriptionLanguage))
            form.Add(new StringContent(options.TranscriptionLanguage), "language");

        using var request = new HttpRequestMessage(HttpMethod.Post, options.TranscriptionUrl)
        {
            Content = form,
        };
        if (!string.IsNullOrWhiteSpace(options.TranscriptionKey))
            request.Headers.Authorization =
                new AuthenticationHeaderValue("Bearer", options.TranscriptionKey);

        using var response = await http.SendAsync(request, ct);
        var payload = await response.Content.ReadAsStringAsync(ct);
        return ((int)response.StatusCode, payload);
    }

    /// <summary>
    /// A status turned into a sentence, and told apart by who has to act.
    /// "Too big" is our problem, "rejected our key" is an administrator's, and
    /// "busy" is nobody's — they need three different responses and a single
    /// "transcription failed" sends all three to the wrong place.
    /// </summary>
    private static string Explain(int status) => status switch
    {
        413 => "The recording was too large for the transcription service even after the "
             + "audio was extracted.",
        // 400 is the provider saying the REQUEST is wrong, and for this
        // endpoint it is nearly always the audio: too long for the model, or a
        // format it will not decode. Named as an us-problem rather than a
        // them-problem, because it is.
        400 => "The transcription service would not accept this recording. It may be "
             + "longer than the model allows, or in a format it cannot read. "
             + "The server log names the exact reason.",
        401 or 403 => "The transcription service rejected our credentials. "
                    + "An administrator needs to check the key.",
        404 => "The transcription service could not find that address or model. "
             + "An administrator needs to check the settings.",
        415 or 422 => "The transcription service could not read that audio format.",
        429 => "The transcription service is busy or the account's limit has been reached.",
        >= 500 => "The transcription service is having problems.",
        _ => $"The transcription service answered {status}.",
    };

    /// <summary>
    /// error.message out of an OpenAI-shaped error body, capped. Null for any
    /// body that is not that shape — a provider being unhelpful is not a
    /// reason to fail, and never a reason to log something unparsed.
    /// </summary>
    private static string? ErrorMessage(string payload)
    {
        try
        {
            var root = JsonDocument.Parse(payload).RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("error", out var error)
                || error.ValueKind != JsonValueKind.Object
                || !error.TryGetProperty("message", out var message)
                || message.ValueKind != JsonValueKind.String)
                return null;

            var text = message.GetString();
            if (string.IsNullOrWhiteSpace(text)) return null;

            return text.Length > 300 ? text[..300] + "…" : text;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// Will a retry ever change this answer?
    ///
    /// 429 and 5xx are the service having a moment — retry. 408 is a timeout,
    /// which can genuinely differ next time. Everything else in the 4xx range
    /// is a statement about the REQUEST, and the request will be identical
    /// next tick, so a retry is a slower way to receive the same refusal.
    /// </summary>
    private static bool IsPermanent(int status) =>
        status is >= 400 and < 500 && status is not (408 or 429);

    // ==================================================================
    //  Getting the speech out of the recording
    // ==================================================================

    /// <summary>
    /// Extensions that are already speech-shaped. A file with one of these is
    /// sent as it is — re-encoding audio to audio would cost CPU and quality
    /// for nothing.
    /// </summary>
    private static readonly string[] AudioExtensions =
        [".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".flac", ".webm"];

    /// <summary>
    /// Produce something worth uploading, and say whether we made it.
    ///
    /// ──────────────────────────────────────────────────────────────────
    ///  WHY THIS EXISTS
    ///
    ///  LiveKit records MP4 when the meeting has video, because that is what
    ///  a person wants to watch afterwards. But 95 seconds of 720p is 36 MB,
    ///  and OpenAI's transcription endpoint stops at 25 MB. So the feature
    ///  did not work for SHORT meetings, never mind long ones — and the
    ///  failure looked like an AI problem when it was an arithmetic one.
    ///
    ///  Speech does not need the picture, or stereo, or 48 kHz. Whisper and
    ///  everything like it works at 16 kHz mono internally, so sending more
    ///  than that is paying to upload data the model discards. Mono Opus at
    ///  24 kbps is about 11 MB per HOUR — roughly two hundred times smaller
    ///  than the video, with nothing lost that a transcript can use.
    ///
    ///  ──────────────────────────────────────────────────────────────────
    ///  IT DEGRADES RATHER THAN REFUSES
    ///
    ///  If ffmpeg is absent or fails, this returns the ORIGINAL file and lets
    ///  the upload proceed. A box without ffmpeg then behaves exactly as this
    ///  code did before today — which for a small audio-only recording is
    ///  perfectly fine. The one thing it will not do is upload something it
    ///  can already see is too large: that is checked last, against whatever
    ///  we ended up with.
    /// </summary>
    private async Task<(string Path, string ContentType, bool Temporary, string? Error)>
        PrepareAudioAsync(string path, string contentType, CancellationToken ct)
    {
        var extension = Path.GetExtension(path).ToLowerInvariant();
        var alreadyAudio = AudioExtensions.Contains(extension);
        var originalBytes = new FileInfo(path).Length;

        // Small and already audio: nothing to gain. Note the ORDER — a small
        // video is still worth stripping, because "small" is about the
        // transfer and "audio" is about what the model can use.
        if (alreadyAudio && originalBytes <= options.TranscriptionMaxUploadBytes)
            return (path, contentType, false, null);

        var temp = Path.Combine(
            Path.GetTempPath(), $"connect-audio-{Guid.NewGuid():N}.ogg");

        var extracted = await TryExtractAsync(path, temp, ct);

        if (extracted)
        {
            var audioBytes = new FileInfo(temp).Length;
            log.LogInformation(
                "Extracted audio for transcription: {Before} bytes -> {After} bytes ({Ratio:0.0}x smaller)",
                originalBytes, audioBytes,
                audioBytes > 0 ? (double)originalBytes / audioBytes : 0);

            if (audioBytes > options.TranscriptionMaxUploadBytes)
            {
                try { File.Delete(temp); } catch (IOException) { }
                return (path, contentType, false,
                    "This meeting is too long to transcribe in one piece. "
                    + "The audio alone is over the service's size limit.");
            }

            return (temp, "audio/ogg", true, null);
        }

        // No ffmpeg, or it could not read the file. Fall back — but REFUSE
        // rather than upload something already known to be over the limit.
        // Discovering that over the wire is what cost 108 MB this morning.
        if (originalBytes > options.TranscriptionMaxUploadBytes)
            return (path, contentType, false,
                "The recording is too large to transcribe, and the audio could not be "
                + "extracted from it on this server. ffmpeg is needed in the API image.");

        return (path, contentType, false, null);
    }

    /// <summary>One piece of audio to send, and where it sits in the meeting.</summary>
    private sealed record Chunk(string Path, double OffsetSeconds, bool Temporary);

    /// <summary>
    /// Split the audio if the service will not take it in one piece.
    ///
    /// ──────────────────────────────────────────────────────────────────
    ///  WHY: THERE IS A CLOCK LIMIT AS WELL AS A SIZE LIMIT, AND IT IS THE
    ///  ONE THAT BITES.
    ///
    ///  Extracting the audio fixed the megabytes — 31 minutes of meeting came
    ///  down to 5.5 MB, comfortably inside 25. It still failed, with a 400
    ///  saying "audio duration 1891.9 seconds is longer than 1400 seconds
    ///  which is the maximum for this model".
    ///
    ///  1400 seconds is 23 minutes 20. Almost every meeting worth writing
    ///  minutes for is longer than that. So the size fix alone would have left
    ///  the feature working for tests and failing for customers, which is the
    ///  worst place for a limit to hide.
    ///
    ///  ──────────────────────────────────────────────────────────────────
    ///  WHY 20 MINUTES AND NOT 23
    ///
    ///  Headroom. The limit belongs to the provider and can change, opus
    ///  duration is not exact to the millisecond, and a chunk that lands one
    ///  second over fails the whole recording. Three minutes of margin costs
    ///  one extra request on a long meeting and removes a class of failure
    ///  that would only ever appear in production.
    ///
    ///  Splits are at fixed times, not at silences. A word can be cut in half
    ///  at a boundary — once every twenty minutes, and the model recovers on
    ///  the next syllable. Finding a silence near each boundary would be
    ///  better and is not worth the complexity until somebody shows a
    ///  transcript it actually spoiled.
    /// </summary>
    private async Task<List<Chunk>> SplitIfLongAsync(string path, CancellationToken ct)
    {
        var single = new List<Chunk> { new(path, 0, false) };

        var limit = options.TranscriptionMaxChunkSeconds;
        if (limit <= 0) return single;

        var duration = await ProbeDurationAsync(path, ct);

        // Unknown duration is NOT a reason to split blindly: chunking audio
        // that did not need it costs requests and puts a seam in a transcript
        // for no gain. If ffprobe cannot say, send it whole and let the
        // service refuse — which it does clearly, and which we now explain.
        if (duration is not double seconds || seconds <= limit) return single;

        var directory = Path.Combine(
            Path.GetTempPath(), $"connect-chunks-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);

        var pattern = Path.Combine(directory, "part-%03d.ogg");

        // -c copy: the audio is ALREADY mono 16 kHz Opus from the extraction
        // step, so re-encoding it here would cost CPU and a generation of
        // quality to produce the same thing. -reset_timestamps so each part
        // starts at zero and the offsets below are the only arithmetic.
        var (exit, _, stderr) = await RunAsync("ffmpeg",
            $"-nostdin -hide_banner -loglevel error -y -i \"{path}\" " +
            $"-f segment -segment_time {limit} -reset_timestamps 1 -c copy \"{pattern}\"",
            ct);

        var parts = Directory.Exists(directory)
            ? Directory.GetFiles(directory, "part-*.ogg").OrderBy(f => f).ToArray()
            : [];

        if (exit != 0 || parts.Length == 0)
        {
            log.LogWarning(
                "Could not split a {Seconds:0}s recording into chunks (exit {Exit}): {Error}",
                seconds, exit, stderr.Trim());
            try { Directory.Delete(directory, recursive: true); } catch (IOException) { }
            return single;
        }

        log.LogInformation(
            "Split {Seconds:0}s of audio into {Count} chunk(s) of up to {Limit}s for transcription.",
            seconds, parts.Length, limit);

        return parts
            .Select((p, i) => new Chunk(p, i * (double)limit, true))
            .ToList();
    }

    /// <summary>
    /// How long the audio is, in seconds, or null if ffprobe cannot say.
    /// Null is a real answer here and the caller treats it as "do not split".
    /// </summary>
    private async Task<double?> ProbeDurationAsync(string path, CancellationToken ct)
    {
        var (exit, stdout, _) = await RunAsync("ffprobe",
            $"-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \"{path}\"",
            ct);

        if (exit != 0) return null;

        return double.TryParse(stdout.Trim(), NumberStyles.Float,
            CultureInfo.InvariantCulture, out var seconds) && seconds > 0
            ? seconds : null;
    }

    /// <summary>
    /// Run a command and collect both its streams. Returns exit code -1 rather
    /// than throwing for every reason it might not run at all — a missing
    /// binary, a bad path, a full disk — because none of those should take a
    /// recording down with them.
    /// </summary>
    private async Task<(int Exit, string Stdout, string Stderr)> RunAsync(
        string fileName, string arguments, CancellationToken ct)
    {
        try
        {
            using var process = new System.Diagnostics.Process
            {
                StartInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                },
            };

            process.Start();

            // BOTH pipes, started before the wait. A redirected stream that
            // nobody reads fills its buffer and blocks the child forever, and
            // the child here is inside a background worker with a 30-minute
            // timeout — so the symptom would be transcripts silently stopping,
            // which is the worst shape a bug can take.
            var errorTask = process.StandardError.ReadToEndAsync(ct);
            var outputTask = process.StandardOutput.ReadToEndAsync(ct);
            await Task.WhenAll(errorTask, outputTask);
            await process.WaitForExitAsync(ct);

            return (process.ExitCode, await outputTask, await errorTask);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // Not installed. Said plainly, because it is an operator's job to
            // fix and a silent fallback would hide the reason transcripts
            // stopped working.
            log.LogWarning(
                "{Tool} is not available in this container. Video recordings cannot be "
                + "reduced to audio or split, so long or large recordings will be refused.",
                fileName);
            return (-1, "", $"{fileName} not found");
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        {
            log.LogWarning(ex, "{Tool} failed", fileName);
            return (-1, "", ex.Message);
        }
    }

    /// <summary>
    /// Strip the picture and write mono 16 kHz Opus. Returns false — never
    /// throws — for every reason it might not work, because none of them
    /// should take a recording down with them.
    /// </summary>
    private async Task<bool> TryExtractAsync(string input, string output, CancellationToken ct)
    {
        // -vn drops the video. -ac 1 makes it mono. -ar 16000 matches what
        // speech models resample to anyway. -nostdin so a build of ffmpeg
        // that wants a keypress cannot hang a background worker forever.
        var (exit, _, stderr) = await RunAsync("ffmpeg",
            $"-nostdin -hide_banner -loglevel error -y -i \"{input}\" " +
            $"-vn -ac 1 -ar 16000 -c:a libopus -b:a {options.TranscriptionAudioKbps}k \"{output}\"",
            ct);

        if (exit == 0 && File.Exists(output) && new FileInfo(output).Length > 0)
            return true;

        if (exit != -1)   // -1 is "could not run it at all", already logged by RunAsync
            log.LogWarning(
                "ffmpeg could not extract audio (exit {Code}): {Error}", exit, stderr.Trim());

        try { if (File.Exists(output)) File.Delete(output); } catch (IOException) { }
        return false;
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

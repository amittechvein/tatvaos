using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Writes the meeting notes.
///
/// ─────────────────────────────────────────────────────────────────────────
///  TWO WAYS, AND THE NOTES SAY WHICH ONE PRODUCED THEM.
///
///  'model'  — an OpenAI-compatible /v1/chat/completions endpoint was
///             configured, and it wrote them. Same contract as the
///             transcriber, for the same reason: self-hosted, a second box,
///             or a vendor is three environment variables, not a rebuild.
///
///  'digest' — nothing is configured, so the notes are ASSEMBLED HERE from
///             the transcript: how long people talked, and the lines that
///             actually contain a decision or a commitment. No model, no
///             network, no inference. It is mechanical and it is labelled
///             mechanical.
///
///  The digest exists because the alternative was an empty screen on every
///  deployment that has not bought an LLM, which is all of them today. It is
///  genuinely useful — "who spoke, for how long, and every line where somebody
///  said they would do something" is most of what people take from a meeting.
///  What it is not is a summary, and the UI does not call it one.
///
///  A MODEL THAT ANSWERS BADLY FALLS BACK TO THE DIGEST rather than failing.
///  Notes are not a transaction: something honest and mechanical beats an
///  error message, and the kind field means nobody is misled about which they
///  got.
///
///  THE TRANSCRIPT IS TRUNCATED BEFORE IT IS SENT. A three-hour meeting is
///  more tokens than most context windows and more money than anyone budgeted
///  for. The cut is at the START of the tail, not the end, and the notes say
///  the meeting was truncated — silently summarising the first fifth of a
///  meeting and presenting it as the whole is the worst available outcome.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ConnectNotesComposer(
    HttpClient http,
    ConnectRecordingOptions options,
    ILogger<ConnectNotesComposer> log)
{
    public sealed record SpeakerTime(string Name, long Seconds, int Turns);

    public sealed record Notes(
        string Kind,                 // digest | model
        string? Provider,
        string? Model,
        string Summary,
        IReadOnlyList<string> KeyPoints,
        IReadOnlyList<string> Decisions,
        IReadOnlyList<string> ActionItems,
        IReadOnlyList<SpeakerTime> Speakers);

    /// <summary>Roughly four characters to a token. Deliberately conservative:
    /// running out of context produces a 400 the user cannot act on.</summary>
    private const int MaxTranscriptChars = 48_000;

    public async Task<Notes> ComposeAsync(
        string meetingTitle, IReadOnlyList<ConnectTranscriber.Segment> segments, CancellationToken ct)
    {
        var speakers = SpeakerTimes(segments);

        if (options.NotesModelConfigured)
        {
            var written = await AskModelAsync(meetingTitle, segments, speakers, ct);
            if (written is not null) return written;
            log.LogWarning("Notes model did not answer usefully; falling back to the digest");
        }

        return Digest(meetingTitle, segments, speakers);
    }

    // ==================================================================
    //  The digest — no model, no network.
    // ==================================================================
    private static Notes Digest(
        string meetingTitle,
        IReadOnlyList<ConnectTranscriber.Segment> segments,
        IReadOnlyList<SpeakerTime> speakers)
    {
        var sentences = Sentences(segments);

        var decisions = sentences.Where(s => DecisionCue.IsMatch(s)).Distinct().Take(12).ToList();
        var actions = sentences.Where(s => ActionCue.IsMatch(s)).Distinct().Take(12).ToList();

        // Key points are the longest sentences that are NOT already listed —
        // length is a poor proxy for importance, but it is an honest one, and
        // it does not pretend to understand the meeting.
        var listed = new HashSet<string>(decisions.Concat(actions));
        var points = sentences
            .Where(s => !listed.Contains(s) && s.Length >= 60)
            .OrderByDescending(s => s.Length)
            .Take(8)
            .ToList();

        var spoken = segments.Count == 0
            ? TimeSpan.Zero
            : TimeSpan.FromSeconds(Math.Max(0, segments[^1].End));
        var words = sentences.Sum(s => s.Count(char.IsWhiteSpace) + 1);

        var summary = new StringBuilder()
            .Append("Assembled from the transcript of ").Append(meetingTitle).Append(". ")
            .Append(Describe(spoken)).Append(", about ")
            .Append(words.ToString("N0", CultureInfo.InvariantCulture)).Append(" words")
            .Append(speakers.Count > 0 ? $", {speakers.Count} identified speaker(s)" : "")
            .Append(". This is a mechanical digest, not a written summary — ")
            .Append("configure a notes model to have one written.")
            .ToString();

        return new Notes("digest", null, null, summary, points, decisions, actions, speakers);
    }

    private static string Describe(TimeSpan t) =>
        t.TotalMinutes < 1
            ? "under a minute"
            : t.TotalHours < 1
                ? $"{(int)t.TotalMinutes} minutes"
                : $"{(int)t.TotalHours}h {t.Minutes:00}m";

    // Cue phrases, kept narrow on purpose. A wide pattern matches most of the
    // transcript and the list stops meaning anything.
    private static readonly Regex DecisionCue = new(
        @"\b(we (?:have )?(?:decided|agreed)|it (?:was|is) (?:decided|agreed)|"
        + @"the decision is|we(?:'| a)?re going (?:to|with)|let'?s go with|"
        + @"we will not|we won'?t|approved|rejected|final(?:ised|ized))\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    private static readonly Regex ActionCue = new(
        @"\b(action item|to-?do|i'?ll |i will |we'?ll |will (?:send|share|check|prepare|update|"
        + @"draft|review|follow up|circulate|schedule)|please (?:send|share|check|prepare|update)|"
        + @"by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|"
        + @"end of (?:day|week|month))|deadline|due (?:on|by))\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    private static readonly Regex SentenceSplit = new(
        @"(?<=[.!?])\s+", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    private static List<string> Sentences(IReadOnlyList<ConnectTranscriber.Segment> segments)
    {
        var all = new List<string>();
        foreach (var segment in segments)
        {
            foreach (var raw in SentenceSplit.Split(segment.Text))
            {
                var s = raw.Trim();
                // Under 25 characters is "yes", "mm-hm", "okay then" — true,
                // and useless in a list of decisions.
                if (s.Length < 25) continue;
                if (s.Length > 400) s = s[..400].TrimEnd() + "…";
                all.Add(string.IsNullOrWhiteSpace(segment.Speaker) ? s : $"{segment.Speaker}: {s}");
            }
        }
        return all;
    }

    private static List<SpeakerTime> SpeakerTimes(IReadOnlyList<ConnectTranscriber.Segment> segments)
    {
        // Nothing produces speaker labels today (one mixed audio stream has
        // nothing in it to attribute), so this is normally empty. It is
        // written now so per-track egress becomes a change of one input rather
        // than a change of shape everywhere downstream.
        var byName = new Dictionary<string, (double Seconds, int Turns)>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in segments)
        {
            if (string.IsNullOrWhiteSpace(s.Speaker)) continue;
            var seconds = Math.Max(0, s.End - s.Start);
            byName.TryGetValue(s.Speaker, out var current);
            byName[s.Speaker] = (current.Seconds + seconds, current.Turns + 1);
        }
        return byName
            .Select(kv => new SpeakerTime(kv.Key, (long)kv.Value.Seconds, kv.Value.Turns))
            .OrderByDescending(s => s.Seconds)
            .ToList();
    }

    // ==================================================================
    //  The model
    // ==================================================================
    private async Task<Notes?> AskModelAsync(
        string meetingTitle,
        IReadOnlyList<ConnectTranscriber.Segment> segments,
        IReadOnlyList<SpeakerTime> speakers,
        CancellationToken ct)
    {
        var (transcript, truncated) = Fit(ConnectTranscriber.Render(segments));

        var system =
            "You write minutes for a meeting from its transcript. "
            + "Reply with JSON only, no prose around it, in exactly this shape: "
            + "{\"summary\":string,\"key_points\":[string],\"decisions\":[string],"
            + "\"action_items\":[string]}. "
            + "Write plainly, in the transcript's own language. "
            + "State only what the transcript supports: if there were no decisions, "
            + "return an empty list rather than inventing one. "
            + "Attribute an action to a person only when the transcript names them.";

        var user = new StringBuilder()
            .Append("Meeting: ").AppendLine(meetingTitle)
            .AppendLine(truncated
                ? "NOTE: this transcript is truncated; say so in the summary."
                : "")
            .AppendLine()
            .Append(transcript)
            .ToString();

        var body = new
        {
            model = options.NotesModel,
            temperature = 0.2,
            messages = new object[]
            {
                new { role = "system", content = system },
                new { role = "user", content = user },
            },
        };

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(options.NotesTimeoutMinutes));

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, options.NotesUrl)
            {
                Content = JsonContent.Create(body),
            };
            if (!string.IsNullOrWhiteSpace(options.NotesKey))
                request.Headers.Authorization =
                    new AuthenticationHeaderValue("Bearer", options.NotesKey);

            var response = await http.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("Notes model returned {Status}", (int)response.StatusCode);
                return null;
            }

            var payload = await response.Content.ReadAsStringAsync(timeout.Token);
            var content = ChatContent(payload);
            if (string.IsNullOrWhiteSpace(content)) return null;

            var parsed = ReadNotesJson(content);
            if (parsed is null) return null;

            var (summary, points, decisions, actions) = parsed.Value;
            if (string.IsNullOrWhiteSpace(summary)) return null;

            return new Notes("model", Host(options.NotesUrl), options.NotesModel,
                summary, points, decisions, actions, speakers);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            log.LogWarning("Notes model did not answer within {Minutes} minutes",
                options.NotesTimeoutMinutes);
            return null;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException)
        {
            log.LogWarning(ex, "Notes model could not be reached");
            return null;
        }
    }

    /// <summary>
    /// Cut the MIDDLE out of an over-long transcript, keeping the opening and
    /// the close.
    ///
    /// Meetings put their agenda at the start and their decisions at the end.
    /// Truncating the tail — the obvious implementation — throws away exactly
    /// the part the notes are for.
    /// </summary>
    private static (string Text, bool Truncated) Fit(string transcript)
    {
        if (transcript.Length <= MaxTranscriptChars) return (transcript, false);

        var half = MaxTranscriptChars / 2;
        var head = transcript[..half];
        var tail = transcript[^half..];
        return (head + "\n\n[... middle of the meeting omitted ...]\n\n" + tail, true);
    }

    private static string? ChatContent(string payload)
    {
        try
        {
            var root = JsonDocument.Parse(payload).RootElement;
            if (!root.TryGetProperty("choices", out var choices)
                || choices.ValueKind != JsonValueKind.Array) return null;
            foreach (var choice in choices.EnumerateArray())
            {
                if (choice.TryGetProperty("message", out var message)
                    && message.TryGetProperty("content", out var content)
                    && content.ValueKind == JsonValueKind.String)
                    return content.GetString();
            }
        }
        catch (JsonException) { }
        return null;
    }

    /// <summary>
    /// Models wrap JSON in prose and in ``` fences however firmly they are
    /// asked not to. Take the outermost braces and parse those.
    /// </summary>
    private static (string Summary, List<string> Points, List<string> Decisions, List<string> Actions)?
        ReadNotesJson(string content)
    {
        var start = content.IndexOf('{');
        var end = content.LastIndexOf('}');
        if (start < 0 || end <= start) return null;

        try
        {
            var root = JsonDocument.Parse(content[start..(end + 1)]).RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var summary = root.TryGetProperty("summary", out var s) && s.ValueKind == JsonValueKind.String
                ? s.GetString() ?? "" : "";
            return (summary,
                Strings(root, "key_points"),
                Strings(root, "decisions"),
                Strings(root, "action_items"));
        }
        catch (JsonException) { return null; }
    }

    private static List<string> Strings(JsonElement root, string name)
    {
        var list = new List<string>();
        if (!root.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array)
            return list;
        foreach (var item in array.EnumerateArray())
        {
            // Some models answer with objects like {"text":"...","owner":"..."}
            // instead of strings. Take the text rather than dropping the item.
            var value = item.ValueKind switch
            {
                JsonValueKind.String => item.GetString(),
                JsonValueKind.Object when item.TryGetProperty("text", out var t)
                    && t.ValueKind == JsonValueKind.String => t.GetString(),
                _ => null,
            };
            if (!string.IsNullOrWhiteSpace(value)) list.Add(value.Trim());
            if (list.Count >= 25) break;
        }
        return list;
    }

    /// <summary>The host only — the provider is recorded for the operator, and
    /// a full URL could carry a key in its query string.</summary>
    private static string? Host(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : null;
}

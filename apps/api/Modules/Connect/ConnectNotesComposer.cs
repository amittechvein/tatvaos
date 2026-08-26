using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// The shape of what this class produces lives in ConnectNotesModel, which
// depends on nothing at all. It moved out of here so the minutes renderer and
// its tests can use the REAL types without dragging an HttpClient along — a
// hand-copied record is a second definition that drifts. These aliases keep
// every call site in this file reading exactly as it did.
using SpeakerTime = TatvaOS.Api.Modules.Connect.ConnectNotesModel.SpeakerTime;
using Attendee = TatvaOS.Api.Modules.Connect.ConnectNotesModel.Attendee;
using Notes = TatvaOS.Api.Modules.Connect.ConnectNotesModel.Notes;

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
/// <remarks>
/// ── ROUTED THROUGH THE AI GATEWAY, 24 August 2026. ───────────────────────
///
/// This class used to carry its own HttpClient, its own key
/// (Connect:Recording:NotesKey), its own URL, model name, timeout and
/// temperature — a second, parallel copy of everything IAiGateway already
/// owns. That bought nothing and cost three times:
///
///   · THE KEY LIVED IN THREE PLACES on the box, so rotating it meant
///     remembering three names or breaking one feature silently.
///   · TOKEN COUNTS WERE INVISIBLE. The gateway logs tokens in/out on every
///     call; this path logged nothing, so "minutes cost about ₹1" stayed
///     arithmetic instead of a bill that can be read.
///   · THE TEMPERATURE BUG LIVED HERE AND NOT THERE. The gateway never sent
///     temperature and worked; this path sent 0.2 and silently degraded every
///     meeting's notes to a digest for two days. Two implementations of one
///     call is two homes for the same class of bug.
///
/// The legacy Connect:Recording:Notes* settings are still read into options
/// but no longer used, so existing .env files break nothing. When a hospital
/// wants Azure India while a school stays on OpenAI, that is the GATEWAY's
/// lookup to grow — not another per-module HTTP client.
/// </remarks>
public sealed class ConnectNotesComposer(
    TatvaOS.Api.Shared.Ai.IAiGateway ai,
    ConnectRecordingOptions options,
    ILogger<ConnectNotesComposer> log)
{
    /// <summary>Whether a model will write the notes, for callers that used to
    /// read options.NotesModelConfigured. One answer, owned by the gateway.</summary>
    public bool ModelConfigured => ai.IsConfigured;

    /// <summary>
    /// DERIVED FROM THE GATEWAY'S CAP, minus room for the title and attendee
    /// list that share the same input. It was an independent 48_000 while this
    /// class owned its own HTTP call; the moment the gateway (cap 24_000)
    /// carried the request, the larger number stopped being a limit and became
    /// a lie — Fit() would "keep" 48k of transcript and the gateway would cut
    /// half of it silently, WITHOUT Fit()'s careful keep-the-opening-and-the-
    /// close shape. Deriving one cap from the other ends the drift
    /// structurally; the warning in AskModelAsync is the tripwire if this is
    /// ever made independent again.
    /// </summary>
    private const int MaxTranscriptChars =
        TatvaOS.Api.Shared.Ai.OpenAiGateway.MaxInputCharacters - 1_000;

    public async Task<Notes> ComposeAsync(
        string meetingTitle,
        IReadOnlyList<ConnectTranscriber.Segment> segments,
        IReadOnlyList<Attendee> attendance,
        CancellationToken ct)
    {
        var speakers = SpeakerTimes(segments);

        // ── NOTES EXIST WITHOUT A TRANSCRIPT. ────────────────────────────
        // This used to be called only for a meeting that HAD one, and a
        // transcript needs a transcription service, which is off by default
        // because audio must not leave the box until somebody decides it may.
        // The result was an automatic-notes feature that produced nothing at
        // all on a fresh deployment. Who attended and for how long is a
        // meeting record in its own right — for a school marking a register
        // it is THE record — so it is written either way, and a model is
        // never asked about a meeting there is no transcript for.
        if (segments.Count == 0) return AttendanceOnly(meetingTitle, attendance);

        if (ai.IsConfigured)
        {
            var written = await AskModelAsync(meetingTitle, segments, speakers, attendance, ct);
            if (written is not null) return written;
            log.LogWarning("Notes model did not answer usefully; falling back to the digest");
        }

        return Digest(meetingTitle, segments, speakers, attendance);
    }

    /// <summary>
    /// A meeting with no transcript. Not a failure and not empty: it says who
    /// came, how long they stayed, and why there is nothing else — which is
    /// three facts more than the blank screen this replaced.
    /// </summary>
    private static Notes AttendanceOnly(string meetingTitle, IReadOnlyList<Attendee> attendance)
    {
        var longest = attendance.Count == 0 ? 0 : attendance.Max(a => a.Seconds);
        var summary = new StringBuilder()
            .Append(meetingTitle).Append(". ")
            .Append(attendance.Count switch
            {
                0 => "Nobody joined.",
                1 => "One person joined.",
                _ => $"{attendance.Count} people joined.",
            })
            .Append(longest > 0 ? $" Longest attendance {Describe(TimeSpan.FromSeconds(longest))}." : "")
            .Append(" This meeting was not transcribed, so there are no notes on what was said.")
            .ToString();

        return new Notes("digest", null, null, summary, [], [], [], [], attendance);
    }

    // ==================================================================
    //  The digest — no model, no network.
    // ==================================================================
    private static Notes Digest(
        string meetingTitle,
        IReadOnlyList<ConnectTranscriber.Segment> segments,
        IReadOnlyList<SpeakerTime> speakers,
        IReadOnlyList<Attendee> attendance)
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
            .Append(attendance.Count > 0 ? $", {attendance.Count} attended" : "")
            .Append(speakers.Count > 0 ? $", {speakers.Count} identified speaker(s)" : "")
            .Append(". This is a mechanical digest, not a written summary — ")
            .Append("configure a notes model to have one written.")
            .ToString();

        return new Notes("digest", null, null, summary, points, decisions, actions,
            speakers, attendance);
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
        IReadOnlyList<Attendee> attendance,
        CancellationToken ct)
    {
        var (transcript, truncated) = Fit(ConnectTranscriber.Render(segments));

        // ── THE LANGUAGE OF THE REPORT IS NOT THE LANGUAGE OF THE ROOM ────
        //
        // Amit's ruling, 22 August 2026: minutes come out in English however
        // the meeting was held. TatvaOS's customers hold meetings in Hindi and
        // in Hinglish, and read reports in English — a head teacher forwarding
        // minutes to a board, or a clinic filing them, wants one language on
        // the page and does not want to be the one translating it.
        //
        // The TRANSCRIPT is untouched by this and stays in the language it was
        // spoken. That asymmetry is deliberate: a transcript is a record of
        // what was said, and a record that has been quietly translated is no
        // longer evidence of anything. The minutes are a reading of it, and a
        // reading may be in whatever language its reader needs.
        //
        // Doing the translation HERE, rather than at transcription, is also
        // the better of the two: this model sees the whole meeting at once, so
        // it translates "sir bol rahe the ki fees structure change karna hai"
        // with the context to know that fees structure is the subject. A
        // speech model translating line by line has no such view.
        //
        // A setting rather than a constant, because a Hindi-medium school will
        // eventually want Hindi minutes and that should be a settings change.
        var language = string.IsNullOrWhiteSpace(options.NotesLanguage)
            ? "English" : options.NotesLanguage.Trim();

        var system =
            "You write minutes for a meeting from its transcript. "
            + "Reply with JSON only, no prose around it, in exactly this shape: "
            + "{\"summary\":string,\"key_points\":[string],\"decisions\":[string],"
            + "\"action_items\":[string]}. "
            + $"WRITE EVERYTHING IN {language.ToUpperInvariant()}. The meeting may have been "
            + $"held in another language, or in a mixture of languages - translate it into "
            + $"{language} rather than quoting it. Keep people's names, place names, and "
            + "organisation names exactly as they were said; do not translate a name. "
            + "Where a word has no good equivalent, use the plain English term a colleague "
            + "would use rather than a literal translation. "
            + "Write plainly. "
            + "State only what the transcript supports: if there were no decisions, "
            + "return an empty list rather than inventing one. "
            + "Attribute an action to a person only when the transcript names them.";

        // Who was in the room, so the model can attribute an action to a
        // name that was actually there instead of inventing a plausible one.
        var who = attendance.Count == 0
            ? ""
            : "Present: " + string.Join(", ", attendance.Select(a => a.Name)) + "\n";

        var user = new StringBuilder()
            .Append("Meeting: ").AppendLine(meetingTitle)
            .Append(who)
            .AppendLine(truncated
                ? "NOTE: this transcript is truncated; say so in the summary."
                : "")
            .AppendLine()
            .Append(transcript)
            .ToString();

        // ── TEMPERATURE IS SENT ONLY IF SOMEBODY ASKED FOR IT ─────────────
        //
        // This used to send temperature 0.2 unconditionally, which is a
        // sensible number for minutes: low, so the same meeting does not
        // produce a differently-worded summary each time somebody presses
        // Write again.
        //
        // gpt-5.6-luna rejects it outright — "Unsupported value: 'temperature'
        // does not support 0.2 with this model. Only the default (1) value is
        // supported" — with a 400. The reasoning-family models fix their own
        // sampling and refuse to be told otherwise.
        //
        // The symptom was much worse than the cause. A 400 here is caught and
        // falls back to the mechanical digest, so the minutes still arrived,
        // still looked plausible, and quietly said "no model was involved" in
        // grey text underneath. Nothing failed loudly. The feature was simply
        // off, for every meeting, and would have stayed off.
        //
        // So it is now OMITTED unless configured. A parameter nobody set is a
        // parameter that cannot be refused, and the default the model chooses
        // for itself is the one it was tuned for. Providers that do want a
        // fixed temperature can have one via Connect:Recording:NotesTemperature
        // — which is the same shape as every other provider difference in this
        // module: a setting, not a rebuild.
        // ── ONE CALL, THROUGH THE GATEWAY. ────────────────────────────────
        //
        // Everything that used to be here — the HttpClient, the bearer
        // header, the timeout, the temperature that one model refused, the
        // status-code translation, the careful never-log-the-body rule — is
        // the gateway's single copy now. What this method keeps is what only
        // it knows: the prompt, and how to read the JSON that comes back.
        //
        // The instruction and the transcript travel as SEPARATE arguments on
        // purpose: the transcript is a customer's meeting, and anything in it
        // that reads like an instruction to the model is a person being
        // quoted, not an order to obey. The gateway's contract makes that
        // distinction structural.
        var result = await ai.CompleteAsync(system, user, ct);

        if (result.Error is not null)
        {
            // Already a sentence a person can act on — the gateway translated
            // the status before we saw it. Logged with the model name so the
            // digest-fallback trail stays greppable next to the old logs.
            log.LogWarning("Notes model {Model}: {Error} — falling back to the digest",
                ai.Model, result.Error);
            return null;
        }

        if (result.Truncated)
            // Fit() should have kept us inside the gateway's cap; if it did
            // not, the summary silently covers part of a meeting. Loud, not
            // fatal — the JSON may still be honest about what it read.
            log.LogWarning(
                "Notes input was truncated BY THE GATEWAY despite Fit() — "
                + "MaxTranscriptChars and the gateway cap have drifted apart.");

        var parsed = ReadNotesJson(result.Text);
        if (parsed is null) return null;

        var (summary, points, decisions, actions) = parsed.Value;
        if (string.IsNullOrWhiteSpace(summary)) return null;

        return new Notes("model", "ai-gateway", ai.Model,
            summary, points, decisions, actions, speakers, attendance);
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

    // ChatContent() lived here until 24 Aug 2026 — walking the provider's
    // choices/message/content JSON is the gateway's job now, and a second
    // parser of the same wire shape is a second place for it to be wrong.

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

}

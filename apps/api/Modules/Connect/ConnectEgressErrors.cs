namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Turn what the recording service says into what a person can act on.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS.
///
///  Egress failures were stored exactly as LiveKit phrased them and rendered
///  straight onto the meeting page in red. What a host actually saw, under a
///  recording they had been waiting twenty minutes for, was:
///
///      context deadline exceeded
///      rpc error: code = Unavailable desc = connection error
///      failed to start recorder: no available instances
///
///  Every one of those is a true sentence written for the person who
///  maintains the recorder, and useless to the person who wanted the
///  recording. Two of the three are somebody else's problem to fix and the
///  host cannot tell which.
///
///  So: a small dictionary, applied where the error is stored, that answers
///  the two questions a person actually has — is my meeting lost, and is
///  there anything I can do?
///
///  ─────────────────────────────────────────────────────────────────────
///  THREE RULES IT KEEPS.
///
///  1. NEVER INVENT REASSURANCE. If a recording is gone, it says so. A
///     message that reads like everything is fine while a file is missing
///     costs more than a technical string ever did.
///
///  2. NEVER SWALLOW AN UNKNOWN. Anything unrecognised is passed through
///     with a sentence in front of it, not replaced by "Something went
///     wrong." The raw text is the only lead anybody has on a failure nobody
///     anticipated, and the day it matters is the day it is new.
///
///  3. THE RAW STRING IS STILL LOGGED, at the call site, against the
///     recording id. This changes what is DISPLAYED. It does not delete
///     evidence.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectEgressErrors
{
    /// <summary>
    /// A recognised failure and the sentence a person should read.
    ///
    /// Ordered, and matched in order: the more specific patterns come first,
    /// because "connection error" appears inside several messages that have
    /// better explanations available.
    /// </summary>
    private static readonly (string Needle, string Plain)[] Known =
    [
        // ── The room never got a recorder ────────────────────────────────
        ("no available instances",
            "The recording service was busy and could not take another "
          + "recording. Nothing was recorded. Try again in a few minutes."),

        ("failed to start recorder",
            "The recording could not be started. Nothing was recorded, and "
          + "the meeting itself was not affected."),

        // ── It could not be reached at all ────────────────────────────────
        ("code = unavailable",
            "The recording service could not be reached. Nothing was "
          + "recorded. This is a server problem, not something to fix in the "
          + "meeting — tell whoever looks after the servers."),

        ("connection refused",
            "The recording service could not be reached. Nothing was "
          + "recorded. This is a server problem, not something to fix in the "
          + "meeting — tell whoever looks after the servers."),

        ("context deadline exceeded",
            "The recording service did not answer in time. The recording may "
          + "be incomplete or missing. If the meeting matters, check the "
          + "recording before relying on it."),

        ("context canceled",
            "The recording stopped before it finished. Anything recorded up "
          + "to that point may still be there — check the length before "
          + "relying on it."),

        // ── It ran, and then something went wrong with the file ───────────
        ("no space left on device",
            "The server ran out of disk space while recording. The recording "
          + "is incomplete. Free up space, or ask an administrator to, before "
          + "recording again."),

        ("permission denied",
            "The recording service could not write the file. Nothing usable "
          + "was saved. This is a server setup problem — tell whoever looks "
          + "after the servers."),

        ("no such file or directory",
            "The recording finished but the file is not where it should be. "
          + "Tell whoever looks after the servers before recording again — "
          + "the next recording will land in the same place."),

        // ── The room ended in a way the recorder did not expect ───────────
        ("room not found",
            "The meeting had already ended when the recording started, so "
          + "there was nothing to record."),

        ("participant not found",
            "The person being recorded left before the recording began. "
          + "Nothing was recorded."),

        // ── Configuration ────────────────────────────────────────────────
        ("invalid api key",
            "The recording service rejected this server's credentials. "
          + "Nothing was recorded. An administrator needs to check the "
          + "recording configuration."),

        ("unauthorized",
            "The recording service rejected this server's credentials. "
          + "Nothing was recorded. An administrator needs to check the "
          + "recording configuration."),
    ];

    /// <summary>
    /// The sentence to show. Never null when given a non-empty error, and
    /// never longer than the column allows.
    /// </summary>
    /// <param name="raw">Exactly what the recording service said.</param>
    public static string InPlainWords(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return "The recording failed, and the recording service did not "
                 + "say why. Tell whoever looks after the servers.";

        var hay = raw.ToLowerInvariant();
        foreach (var (needle, plain) in Known)
            if (hay.Contains(needle))
                return plain;

        // Rule 2. An unrecognised failure keeps its own words, because they
        // are the only lead anybody has — but it says up front that this is a
        // recording problem, so the reader is not left deciding whether a line
        // of Go internals is about their meeting.
        var trimmed = raw.Trim();
        if (trimmed.Length > 240) trimmed = trimmed[..240] + "…";
        return $"The recording failed. The recording service said: {trimmed}";
    }
}

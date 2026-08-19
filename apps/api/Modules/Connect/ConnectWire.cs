using System.Globalization;
using System.Text.Json;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Every decision about what LiveKit's JSON actually looks like, in one file.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THIS FILE EXISTS BECAUSE THE SAME KNOWLEDGE LIVED IN TWO PLACES AND ONLY
///  ONE OF THEM WAS RIGHT.
///
///  LiveKitEgressClient read every number through a tolerant helper, with a
///  comment explaining that protojson renders int64 as a STRING.
///  ConnectWebhookEndpoints, in the same folder, read `createdAt` with
///  JsonElement.TryGetInt64 — which does not return false for a String, it
///  THROWS. The exception was unhandled, Kestrel answered 500, LiveKit gave
///  up after five attempts, and connect.meeting_events stayed empty from the
///  day the module shipped: no attendance, no started_at, no meeting ever
///  reaching 'ended', and a notes worker built on a table that could not have
///  a row in it. One line, twelve hours to find.
///
///  So the rules now live once, here, and both callers use them. The test
///  project under tests/connect-wire feeds this file REAL protojson shapes
///  and would have caught that in under a second.
///
///  THE FIVE RULES, ALL LEARNED THE EXPENSIVE WAY:
///
///  1. int64 IS A STRING. protojson cannot put 64 bits in a JSON number
///     safely, so it quotes them. createdAt, startedAt, duration, size — all
///     strings. Read every number through Number().
///
///  2. TryGetInt64 AND FRIENDS THROW ON THE WRONG KIND. A TryGet that throws
///     is a trap. Check ValueKind first, always.
///
///  3. NAMES ARE lowerCamelCase, but snake_case is accepted everywhere too.
///     Betting on one spelling is a coin flip that compiles either way.
///
///  4. EGRESS TIMESTAMPS ARE NANOSECONDS. The webhook envelope's createdAt is
///     SECONDS. Mixing them puts a recording in the year 55000 and no test
///     notices, because both are just large numbers.
///
///  5. EVERY FIELD IS OPTIONAL. This is external input from a service that
///     will add fields and versions. A missing one returns null; it never
///     throws, and it never guesses.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectWire
{
    // ==================================================================
    //  Primitives — rules 2, 3 and 5
    // ==================================================================

    /// <summary>The first of these property names that is present. Rule 3.</summary>
    public static bool TryProperty(JsonElement e, out JsonElement value, params string[] names)
    {
        if (e.ValueKind == JsonValueKind.Object)
        {
            foreach (var name in names)
                if (e.TryGetProperty(name, out value))
                    return true;
        }
        value = default;
        return false;
    }

    public static string? Text(JsonElement e, params string[] names) =>
        TryProperty(e, out var v, names) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    public static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    /// <summary>
    /// A 64-bit number from LiveKit, which sends it as a string. Rules 1 and 2.
    ///
    /// Accepts a real number too — a future LiveKit, or a hand-written test
    /// payload, may well send one, and refusing it would be the same mistake
    /// in the opposite direction.
    ///
    /// InvariantCulture is not decoration: on a machine whose locale uses a
    /// comma for the decimal point, a permissive parse of "1787074610" is
    /// fine but "12.5" is not, and this platform runs in Asia/Kolkata.
    /// </summary>
    public static long? Number(JsonElement e, params string[] names)
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

    /// <summary>
    /// A floating-point number, by the same rules as Number and for the same
    /// reason: some services quote them and some do not.
    ///
    /// InvariantCulture matters MORE here than it does for integers. On a
    /// machine whose locale uses a comma for the decimal point, a
    /// culture-sensitive parse reads "12.5" as 125 — no exception, no warning,
    /// a transcript segment that lands two minutes late. This platform runs in
    /// Asia/Kolkata today and will run wherever a school puts it.
    /// </summary>
    public static double? Real(JsonElement e, params string[] names)
    {
        if (!TryProperty(e, out var v, names)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.TryGetDouble(out var n) ? n : null,
            JsonValueKind.String => double.TryParse(v.GetString(), NumberStyles.Float,
                CultureInfo.InvariantCulture, out var s) ? s : null,
            _ => null,
        };
    }

    /// <summary>
    /// Strictly true. Not "true", not 1, not any non-empty value — this is not
    /// JavaScript, and a flag that is true because the field happened to be a
    /// non-zero number is a flag nobody can reason about.
    /// </summary>
    public static bool Flag(JsonElement e, params string[] names) =>
        TryProperty(e, out var v, names) && v.ValueKind == JsonValueKind.True;

    /// <summary>
    /// A nested OBJECT.
    ///
    /// This exists because JsonElement.TryGetProperty is the same trap as
    /// TryGetInt64 one level up: called on an element that is not an object it
    /// THROWS rather than returning false. Any code that walks two levels into
    /// external JSON — choices[0].message.content, room.name, participant.identity
    /// — has to prove each level is an object first, and code that proves it by
    /// hand eventually forgets a level.
    /// </summary>
    public static bool TryObject(JsonElement e, out JsonElement value, params string[] names)
    {
        if (TryProperty(e, out var found, names) && found.ValueKind == JsonValueKind.Object)
        {
            value = found;
            return true;
        }
        value = default;
        return false;
    }

    /// <summary>A nested ARRAY, for the same reason as TryObject.</summary>
    public static bool TryArray(JsonElement e, out JsonElement value, params string[] names)
    {
        if (TryProperty(e, out var found, names) && found.ValueKind == JsonValueKind.Array)
        {
            value = found;
            return true;
        }
        value = default;
        return false;
    }

    // ==================================================================
    //  Time — rule 4
    // ==================================================================

    /// <summary>The webhook ENVELOPE's createdAt, in unix SECONDS.</summary>
    public static DateTimeOffset? Seconds(JsonElement e, params string[] names)
    {
        var n = Number(e, names);
        if (n is not long v || v <= 0) return null;
        // Beyond this, something has sent nanoseconds where seconds were
        // expected — rule 4 in the act of going wrong. Refuse rather than
        // stamp an event in the year 55000.
        if (v > 4_102_444_800) return null;      // 2100-01-01
        return DateTimeOffset.FromUnixTimeSeconds(v);
    }

    /// <summary>EgressInfo timestamps, in unix NANOSECONDS.</summary>
    public static DateTimeOffset? Nanoseconds(JsonElement e, params string[] names)
    {
        var n = Number(e, names);
        if (n is not long v || v <= 0) return null;
        return DateTimeOffset.FromUnixTimeMilliseconds(v / 1_000_000);
    }

    // ==================================================================
    //  Shapes
    // ==================================================================

    /// <summary>
    /// The meeting a webhook is about.
    ///
    /// The room is named m-{meetingId} and that is the ONLY place the id
    /// appears. Room events carry `room`; EGRESS events carry no room object
    /// at all and put the name on egressInfo.roomName instead — a handler
    /// that looked only at `room` would drop every recording callback and
    /// answer 200.
    /// </summary>
    public static bool TryMeetingId(JsonElement root, out Guid meetingId)
    {
        meetingId = Guid.Empty;

        string? name = null;
        if (TryObject(root, out var room, "room"))
            name = Text(room, "name");

        if (string.IsNullOrEmpty(name) && TryEgress(root, out var egress))
            name = Text(egress, "roomName", "room_name");

        if (string.IsNullOrEmpty(name) || !name.StartsWith("m-", StringComparison.Ordinal))
            return false;

        return Guid.TryParse(name[2..], out meetingId);
    }

    public static bool TryEgress(JsonElement root, out JsonElement egress) =>
        TryObject(root, out egress, "egressInfo", "egress_info");

    public static string? ParticipantText(JsonElement root, string name) =>
        TryObject(root, out var p, "participant") ? Text(p, name) : null;

    /// <summary>
    /// LiveKit's egress status to ours.
    ///
    /// EGRESS_COMPLETE without a file is 'failed', not 'ready'. A complete
    /// egress that wrote nothing happens — the room emptied before a frame,
    /// or the output path was not writable — and calling that ready puts a
    /// download button on screen that answers 404. The database refuses it
    /// too: recordings_ready_has_file.
    ///
    /// An unrecognised status returns null and the caller LEAVES THE ROW
    /// ALONE. LiveKit may add states; guessing at one and moving a live
    /// recording to a wrong status is worse than ignoring it, because the
    /// worker's repair pass reads the real state from LiveKit anyway.
    /// </summary>
    public static string? MapEgressStatus(string? status, string? fileName) => status switch
    {
        "EGRESS_STARTING" => "starting",
        "EGRESS_ACTIVE" => "recording",
        "EGRESS_ENDING" => "processing",
        "EGRESS_COMPLETE" or "EGRESS_LIMIT_REACHED"
            => string.IsNullOrEmpty(fileName) ? "failed" : "ready",
        "EGRESS_FAILED" => "failed",
        "EGRESS_ABORTED" => "aborted",
        _ => null,
    };

    /// <summary>What LiveKit told us about one egress. Every field optional —
    /// rule 5.</summary>
    public sealed record EgressState(
        string? EgressId,
        string? Status,
        string? Error,
        string? FileName,
        long SizeBytes,
        long? DurationMs,
        DateTimeOffset? StartedAt,
        DateTimeOffset? EndedAt);

    public static EgressState ReadEgress(JsonElement e)
    {
        var (fileName, size, durationNs) = ReadFirstFile(e);

        return new EgressState(
            EgressId: Text(e, "egressId", "egress_id"),
            Status: Text(e, "status"),
            Error: NullIfBlank(Text(e, "error")),
            FileName: fileName,
            SizeBytes: size,
            DurationMs: durationNs is long ns && ns > 0 ? ns / 1_000_000 : null,
            StartedAt: Nanoseconds(e, "startedAt", "started_at"),
            EndedAt: Nanoseconds(e, "endedAt", "ended_at"));
    }

    private static (string? Name, long Size, long? DurationNs) ReadFirstFile(JsonElement e)
    {
        if (!TryArray(e, out var files, "fileResults", "file_results"))
            return (null, 0, null);

        foreach (var f in files.EnumerateArray())
        {
            // 'filename' is the full path egress wrote to. The database stores
            // the LEAF only — the directory is configuration, not data, and a
            // stored absolute path would be wrong the day the mount moves.
            var full = Text(f, "filename");
            var leaf = string.IsNullOrEmpty(full) ? null : full[(full.LastIndexOf('/') + 1)..];
            return (NullIfBlank(leaf), Number(f, "size") ?? 0, Number(f, "duration"));
        }
        return (null, 0, null);
    }

    // ==================================================================
    //  Which events this platform records
    // ==================================================================

    /// <summary>
    /// The event name as connect.meeting_events.kind stores it, or null for
    /// one we deliberately ignore.
    ///
    /// The ignored ones matter more than they look. track_published and
    /// track_unpublished arrive constantly, are answered 200 before anything
    /// is touched, and for a whole day their healthy 200s in LiveKit's log
    /// were read as proof that webhook delivery worked — while every event in
    /// this list was failing. If you are reading a webhook log to decide
    /// whether delivery works, MIND WHICH EVENT each line is about.
    /// </summary>
    public static string? EventKind(string? eventName) => eventName switch
    {
        "room_started" => "room_started",
        "room_finished" => "room_finished",
        "participant_joined" => "participant_joined",
        "participant_left" => "participant_left",
        "recording_started" => "recording_started",
        "recording_finished" => "recording_finished",
        "egress_started" => "egress_started",
        "egress_updated" => "egress_updated",
        "egress_ended" => "egress_ended",
        _ => null,
    };
}

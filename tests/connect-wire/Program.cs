using System.Globalization;
using System.Text.Json;
using TatvaOS.Api.Modules.Connect;

namespace TatvaOS.Tests.Wire;

/// <summary>
/// Runs every rule in ConnectWire against the real payloads in Fixtures.
///
/// Usage:  dotnet run --project tests/connect-wire
/// Exit:   0 = all assertions passed, 1 = at least one failed.
///
/// Read the last line. Everything above it is there so that a failure tells
/// you what broke without opening a debugger.
/// </summary>
internal static class Program
{
    private static int Main()
    {
        var t = new Harness();

        Console.WriteLine();
        Console.WriteLine("  ConnectWire — LiveKit wire format");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        RunAll(t);

        // ── The same suite under hostile cultures ─────────────────────────
        //
        // This platform runs in Asia/Kolkata and serves schools that will set
        // whatever locale they like. th-TH uses the Buddhist calendar, so any
        // DateTime that goes through a culture-sensitive ToString or Parse
        // comes back 543 years out; de-DE swaps the decimal and group
        // separators. ConnectWire pins InvariantCulture today. This is the
        // guard that notices the day somebody takes that off.
        var repeated = 0;
        foreach (var name in new[] { "th-TH", "de-DE", "ar-SA" })
        {
            var before = t.Failed;
            t.Quiet = true;
            CultureInfo.CurrentCulture = new CultureInfo(name);
            CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
            var start = t.Passed;
            RunAll(t);
            repeated = t.Passed - start;
            if (t.Failed != before)
                Console.WriteLine($"  FAIL  the suite does not hold under culture {name}");
        }
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        t.Quiet = false;
        t.Note($"all {repeated} assertions repeat clean under th-TH, de-DE, ar-SA");

        return t.Report();
    }

    private static void RunAll(Harness t)
    {
        TheBugItself(t);
        Envelopes(t);
        WhichMeeting(t);
        EgressPayloads(t);
        StatusMapping(t);
        WhichEvents(t);
        TheOtherParsers(t);
        NothingThrows(t);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  1. The bug itself
    // ══════════════════════════════════════════════════════════════════════
    private static void TheBugItself(Harness t)
    {
        t.Section("the bug this project exists for");

        var root = Parse(Fixtures.ParticipantJoined);

        // The fact, stated as a test so it can never be argued about again.
        t.Ok("LiveKit sends createdAt as a JSON String, not a Number",
            root.GetProperty("createdAt").ValueKind == JsonValueKind.String);

        // And the trap: a TryGet that does not return false.
        t.Throws<InvalidOperationException>(
            "TryGetInt64 THROWS on that string — it does not return false",
            () => root.GetProperty("createdAt").TryGetInt64(out _));

        // The part that made it hard to see. int32 fields are NOT quoted, so
        // a glance at a payload shows plenty of honest numbers.
        t.Ok("but int32 fields ARE plain numbers — which is why the payload looks fine",
            root.GetProperty("room").GetProperty("numParticipants").ValueKind == JsonValueKind.Number);

        // What the platform does now.
        var at = ConnectWire.Seconds(root, "createdAt");
        t.Ok("ConnectWire.Seconds reads it", at is not null);
        t.Ok("and reads it EXACTLY — 1787074611", at?.ToUnixTimeSeconds() == 1787074611);

        // The consequence, spelled out: this is the value that becomes
        // meeting_events.occurred_at, which is what attendance is computed
        // from and what sets started_at and ended_at.
        t.Ok("participant_left is 3600s after the join — one hour of attendance",
            ConnectWire.Seconds(Parse(Fixtures.ParticipantLeft), "createdAt")!.Value
              .ToUnixTimeSeconds() - at!.Value.ToUnixTimeSeconds() == 3600);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  2. The webhook envelope
    // ══════════════════════════════════════════════════════════════════════
    private static void Envelopes(Harness t)
    {
        t.Section("the envelope");

        t.Ok("a real JSON number is accepted too — refusing it is the same mistake reversed",
            ConnectWire.Seconds(Parse(Fixtures.CreatedAtAsNumber), "createdAt")?
                .ToUnixTimeSeconds() == 1787074610);

        t.Ok("a missing createdAt is null, so the caller can stamp 'now' and carry on",
            ConnectWire.Seconds(Parse(Fixtures.NoCreatedAt), "createdAt") is null);

        t.Ok("nanoseconds in a seconds field are REFUSED, not dated to the year 58,000",
            ConnectWire.Seconds(Parse(Fixtures.CreatedAtInNanoseconds), "createdAt") is null);

        t.Ok("createdAt of the wrong kind entirely is null, not an exception",
            ConnectWire.Seconds(Parse(Fixtures.HostileTypes), "createdAt") is null);

        t.Ok("snake_case created_at is read as well",
            ConnectWire.Seconds(Parse(Fixtures.EgressEndedSnakeCase), "createdAt", "created_at")?
                .ToUnixTimeSeconds() == 1787078190);

        // Rule 4, from the other side.
        var egress = Egress(Fixtures.EgressEndedComplete);
        t.Ok("egress startedAt is NANOseconds and reads as 1787074680000ms",
            ConnectWire.Nanoseconds(egress, "startedAt")?.ToUnixTimeMilliseconds() == 1787074680000);
        t.Ok("the two units in one message land 52 seconds apart, not 56 centuries",
            (ConnectWire.Nanoseconds(egress, "endedAt")!.Value
             - ConnectWire.Nanoseconds(egress, "startedAt")!.Value).TotalSeconds == 52);

        t.Ok("startedAt of \"0\" — a fresh egress — is null, not 1970",
            ConnectWire.Nanoseconds(Parse(Fixtures.EgressStartReply), "startedAt") is null);

        t.Ok("Text on a non-string is null",
            ConnectWire.Text(Parse(Fixtures.HostileTypes), "event") is null);
        t.Ok("Flag reads a real true",
            ConnectWire.Flag(Egress(Fixtures.EgressUnknownStatus), "backupStorageUsed"));
        t.Ok("Flag is false for a real false",
            !ConnectWire.Flag(Parse(Fixtures.ParticipantJoined).GetProperty("room"), "activeRecording"));
        t.Ok("Flag is false for a missing field",
            !ConnectWire.Flag(Parse(Fixtures.NoCreatedAt), "activeRecording"));
        t.Ok("Flag is false for a NUMBER — 12345 is not truthy here, this is not JavaScript",
            !ConnectWire.Flag(Parse(Fixtures.HostileTypes), "event"));
        t.Ok("Flag is false for the STRING \"true\", which is what a form post would send",
            !ConnectWire.Flag(Parse("""{"audioOnly":"true"}"""), "audioOnly"));

        t.Ok("ParticipantText reads the display name",
            ConnectWire.ParticipantText(Parse(Fixtures.ParticipantJoined), "name") == "Amit Sharma");
        t.Ok("ParticipantText reads the identity, which is how attendance is keyed",
            ConnectWire.ParticipantText(Parse(Fixtures.ParticipantJoined), "identity")
                == "u-8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f");
        t.Ok("ParticipantText on an event with no participant is null",
            ConnectWire.ParticipantText(Parse(Fixtures.RoomFinished), "identity") is null);
        t.Ok("ParticipantText when 'participant' is an ARRAY is null, not a crash",
            ConnectWire.ParticipantText(Parse(Fixtures.HostileTypes), "identity") is null);

        t.Ok("a 64-bit size survives exactly — 9007199254740993, which a double cannot hold",
            ConnectWire.Number(FirstFile(Fixtures.EgressHugeNumbers), "size") == 9007199254740993L);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  3. Which meeting is this about
    // ══════════════════════════════════════════════════════════════════════
    private static void WhichMeeting(Harness t)
    {
        t.Section("which meeting");

        var expected = Guid.Parse(Fixtures.MeetingId);

        t.Ok("room events carry it on room.name",
            ConnectWire.TryMeetingId(Parse(Fixtures.ParticipantJoined), out var a) && a == expected);

        // The one that would have silently dropped every recording callback.
        t.Ok("EGRESS events have NO room object — it comes from egressInfo.roomName",
            !Parse(Fixtures.EgressEndedComplete).TryGetProperty("room", out _));
        t.Ok("and it is found there anyway",
            ConnectWire.TryMeetingId(Parse(Fixtures.EgressEndedComplete), out var b) && b == expected);

        t.Ok("snake_case egress_info.room_name too",
            ConnectWire.TryMeetingId(Parse(Fixtures.EgressEndedSnakeCase), out var c) && c == expected);

        t.Ok("a room belonging to something else is refused",
            !ConnectWire.TryMeetingId(Parse(Fixtures.ForeignRoom), out _));
        t.Ok("an m- prefix over a non-guid is refused — the prefix passing is not the parse passing",
            !ConnectWire.TryMeetingId(Parse(Fixtures.MalformedMeetingRoom), out _));
        t.Ok("a room that is a string instead of an object is refused, not a crash",
            !ConnectWire.TryMeetingId(Parse(Fixtures.HostileTypes), out _));
        t.Ok("a refused id is Guid.Empty, never a stale value from a previous call",
            !ConnectWire.TryMeetingId(Parse(Fixtures.ForeignRoom), out var d) && d == Guid.Empty);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  4. EgressInfo
    // ══════════════════════════════════════════════════════════════════════
    private static void EgressPayloads(Harness t)
    {
        t.Section("egress payloads");

        var done = ConnectWire.ReadEgress(Egress(Fixtures.EgressEndedComplete));
        t.Ok("egressId", done.EgressId == "EG_hT7kPqW2ZmXv");
        t.Ok("status", done.Status == "EGRESS_COMPLETE");
        t.Ok("an empty error string is null, not \"\" — the column means 'no error'",
            done.Error is null);
        t.Ok("the filename is stored as the LEAF — a stored absolute path is wrong the day the mount moves",
            done.FileName == "rec-0f9c1d2e.ogg");
        t.Ok("size comes off a quoted int64 as 834112",
            done.SizeBytes == 834112);
        t.Ok("duration converts nanoseconds to 52000ms",
            done.DurationMs == 52000);
        t.Ok("startedAt", done.StartedAt?.ToUnixTimeMilliseconds() == 1787074680000);
        t.Ok("endedAt", done.EndedAt?.ToUnixTimeMilliseconds() == 1787074732000);

        var snake = ConnectWire.ReadEgress(Egress(Fixtures.EgressEndedSnakeCase, "egress_info"));
        t.Ok("the snake_case payload reads identically — id, file, size and duration",
            snake.EgressId == done.EgressId && snake.FileName == done.FileName
            && snake.SizeBytes == done.SizeBytes && snake.DurationMs == done.DurationMs
            && snake.StartedAt == done.StartedAt && snake.EndedAt == done.EndedAt);

        var failed = ConnectWire.ReadEgress(Egress(Fixtures.EgressEndedFailed));
        t.Ok("a failure keeps its error sentence, which is what the operator reads",
            failed.Error is not null && failed.Error.Contains("permission denied", StringComparison.Ordinal));
        t.Ok("a failure with no fileResults array at all gives no file and zero bytes",
            failed.FileName is null && failed.SizeBytes == 0);
        t.Ok("and no duration, rather than 0 — there is a difference between 'none' and 'zero'",
            failed.DurationMs is null);

        var empty = ConnectWire.ReadEgress(Egress(Fixtures.EgressEndedCompleteNoFile));
        t.Ok("COMPLETE with an EMPTY fileResults array also gives no file",
            empty.FileName is null && empty.SizeBytes == 0);

        var starting = ConnectWire.ReadEgress(Parse(Fixtures.EgressStartReply));
        t.Ok("the Twirp start REPLY reads through the same code — no envelope needed",
            starting.EgressId == "EG_hT7kPqW2ZmXv" && starting.Status == "EGRESS_STARTING");
        t.Ok("with nothing invented for the fields it does not have yet",
            starting.FileName is null && starting.EndedAt is null && starting.StartedAt is null);

        var bare = ConnectWire.ReadEgress(Parse(Fixtures.EgressBareFilename));
        t.Ok("a filename with no directory keeps all of itself (LastIndexOf('/') + 1 == 0)",
            bare.FileName == "rec-nodir.ogg");

        var huge = ConnectWire.ReadEgress(Parse(Fixtures.EgressHugeNumbers));
        t.Ok("int64.MaxValue nanoseconds divides without overflowing",
            huge.DurationMs == 9223372036854L);
        t.Ok("and a size beyond double's exact range is charged to storage precisely",
            huge.SizeBytes == 9007199254740993L);

        t.Ok("TryEgress is false when egressInfo is a bool",
            !ConnectWire.TryEgress(Parse(Fixtures.HostileTypes), out _));
        t.Ok("TryEgress is false on a room event that has none",
            !ConnectWire.TryEgress(Parse(Fixtures.RoomFinished), out _));
    }

    // ══════════════════════════════════════════════════════════════════════
    //  5. Status mapping
    // ══════════════════════════════════════════════════════════════════════
    private static void StatusMapping(Harness t)
    {
        t.Section("status mapping");

        t.Ok("STARTING → starting", ConnectWire.MapEgressStatus("EGRESS_STARTING", null) == "starting");
        t.Ok("ACTIVE → recording", ConnectWire.MapEgressStatus("EGRESS_ACTIVE", null) == "recording");
        t.Ok("ENDING → processing", ConnectWire.MapEgressStatus("EGRESS_ENDING", null) == "processing");
        t.Ok("COMPLETE with a file → ready",
            ConnectWire.MapEgressStatus("EGRESS_COMPLETE", "rec.ogg") == "ready");

        // The one that stops a 404 reaching a user.
        t.Ok("COMPLETE with NO file → failed, not ready",
            ConnectWire.MapEgressStatus("EGRESS_COMPLETE", null) == "failed");
        t.Ok("and an empty filename counts as no file",
            ConnectWire.MapEgressStatus("EGRESS_COMPLETE", "") == "failed");
        t.Ok("LIMIT_REACHED with a file is still a usable recording",
            ConnectWire.MapEgressStatus("EGRESS_LIMIT_REACHED", "rec.ogg") == "ready");
        t.Ok("FAILED → failed", ConnectWire.MapEgressStatus("EGRESS_FAILED", "rec.ogg") == "failed");
        t.Ok("ABORTED → aborted", ConnectWire.MapEgressStatus("EGRESS_ABORTED", null) == "aborted");

        // Forward compatibility, stated as behaviour rather than hope.
        t.Ok("a status this build has never heard of returns null — LEAVE THE ROW ALONE",
            ConnectWire.MapEgressStatus("EGRESS_PAUSED", "rec.ogg") is null);
        t.Ok("null and empty do the same",
            ConnectWire.MapEgressStatus(null, "rec.ogg") is null
            && ConnectWire.MapEgressStatus("", "rec.ogg") is null);
        t.Ok("lowercase is not silently accepted — LiveKit shouts, and a match on the wrong case is a guess",
            ConnectWire.MapEgressStatus("egress_complete", "rec.ogg") is null);

        var unknown = ConnectWire.ReadEgress(Egress(Fixtures.EgressUnknownStatus));
        t.Ok("a payload with unknown fields still reads the fields we do know",
            unknown.EgressId == "EG_hT7kPqW2ZmXv" && unknown.Status == "EGRESS_PAUSED");
    }

    // ══════════════════════════════════════════════════════════════════════
    //  6. Which events are recorded
    // ══════════════════════════════════════════════════════════════════════
    private static void WhichEvents(Harness t)
    {
        t.Section("which events");

        // Every kind connect.meeting_events accepts. If this list and the
        // database CHECK constraint ever disagree, the handler writes a row
        // the database refuses and the webhook 500s — which is how this
        // module got into trouble the first time.
        string[] recorded =
        [
            "room_started", "room_finished",
            "participant_joined", "participant_left",
            "recording_started", "recording_finished",
            "egress_started", "egress_updated", "egress_ended",
        ];
        var mapped = recorded.Where(e => ConnectWire.EventKind(e) == e).Count();
        t.Ok($"all {recorded.Length} recorded kinds map to themselves", mapped == recorded.Length);

        t.Ok("track_published is ignored — and its healthy 200s are why the log looked fine for a day",
            ConnectWire.EventKind("track_published") is null);
        t.Ok("track_unpublished is ignored",
            ConnectWire.EventKind("track_unpublished") is null);
        t.Ok("an event LiveKit adds later is ignored, not stored",
            ConnectWire.EventKind("participant_active") is null);
        t.Ok("null is ignored", ConnectWire.EventKind(null) is null);
        t.Ok("a non-string event field yields null and then an ignored event",
            ConnectWire.EventKind(ConnectWire.Text(Parse(Fixtures.HostileTypes), "event")) is null);

        t.Ok("the ignored fixture really is one of the ignored ones",
            ConnectWire.EventKind(ConnectWire.Text(Parse(Fixtures.TrackPublished), "event")) is null);
        t.Ok("and the recorded fixtures really are recorded",
            ConnectWire.EventKind(ConnectWire.Text(Parse(Fixtures.ParticipantJoined), "event")) == "participant_joined"
            && ConnectWire.EventKind(ConnectWire.Text(Parse(Fixtures.RoomFinished), "event")) == "room_finished"
            && ConnectWire.EventKind(ConnectWire.Text(Parse(Fixtures.EgressEndedComplete), "event")) == "egress_ended");
    }

    // ══════════════════════════════════════════════════════════════════════
    //  7. The three other places the same trap was found
    // ══════════════════════════════════════════════════════════════════════
    private static void TheOtherParsers(Harness t)
    {
        t.Section("the notes model's answer");

        // What the composer does, in the same order it does it.
        static string? Content(string payload)
        {
            var root = Parse(payload);
            if (!ConnectWire.TryArray(root, out var choices, "choices")) return null;
            foreach (var choice in choices.EnumerateArray())
                if (ConnectWire.TryObject(choice, out var message, "message")
                    && ConnectWire.Text(message, "content") is { } c)
                    return c;
            return null;
        }

        t.Ok("a normal completion yields the model's JSON",
            Content(Fixtures.ChatCompletion)?.StartsWith("{\"summary\"", StringComparison.Ordinal) == true);

        // The two that used to throw INSIDE a catch that only caught
        // JsonException — killing the notes worker for every queued meeting.
        t.Throws<InvalidOperationException>(
            "proof the old code threw: TryGetProperty on a string choice",
            () => Parse(Fixtures.ChatCompletionFlatChoices)
                    .GetProperty("choices")[0].TryGetProperty("message", out _));
        t.Ok("choices full of strings now reads as 'no content'",
            Content(Fixtures.ChatCompletionFlatChoices) is null);
        t.Ok("a message that is a string rather than an object reads as 'no content'",
            Content(Fixtures.ChatCompletionStringMessage) is null);
        t.Ok("an error body reads as 'no content'",
            Content(Fixtures.ChatCompletionError) is null);

        t.Section("transcript segments out of jsonb");

        static (double Start, double End, string Text)[] Segments(string raw)
        {
            var list = new List<(double, double, string)>();
            foreach (var item in Parse(raw).EnumerateArray())
            {
                var text = ConnectWire.Text(item, "text");
                if (string.IsNullOrWhiteSpace(text)) continue;
                list.Add((ConnectWire.Real(item, "start") ?? 0, ConnectWire.Real(item, "end") ?? 0, text));
            }
            return [.. list];
        }

        var numeric = Segments(Fixtures.SegmentsNumeric);
        t.Ok("Whisper's own numbers read exactly — 4.32 is 4.32",
            numeric.Length == 2 && numeric[0].End == 4.32 && numeric[1].End == 11.08);

        // The one that matters for the self-hosted transcription about to land
        // on this box.
        var quoted = Segments(Fixtures.SegmentsStringOffsets);
        t.Ok("a self-hosted wrapper's QUOTED offsets read identically",
            quoted.Length == numeric.Length
            && quoted[0].End == numeric[0].End && quoted[1].End == numeric[1].End);
        t.Ok("and 4.32 did not become 432 — the decimal point is parsed, not dropped",
            quoted[0].End > 4 && quoted[0].End < 5);

        var hostile = Segments(Fixtures.SegmentsHostile);
        t.Ok("junk entries are skipped and the real ones survive",
            hostile.Length == 2);
        t.Ok("an offset that is an object defaults to 0 rather than throwing",
            hostile[0] is { Start: 0, End: 0 });
        t.Ok("an offset that is unparseable text defaults to 0 too",
            hostile[1] is { Start: 0, End: 0 });

        t.Section("attendance out of jsonb");

        static (string Name, bool Guest, long Seconds, int Joins)[] Attendees(string raw)
        {
            var list = new List<(string, bool, long, int)>();
            foreach (var item in Parse(raw).EnumerateArray())
            {
                var name = ConnectWire.Text(item, "name");
                if (string.IsNullOrWhiteSpace(name)) continue;
                list.Add((name, ConnectWire.Flag(item, "guest"),
                    ConnectWire.Number(item, "seconds") ?? 0,
                    (int)Math.Clamp(ConnectWire.Number(item, "joins") ?? 0, 0, int.MaxValue)));
            }
            return [.. list];
        }

        var att = Attendees(Fixtures.Attendance);
        t.Ok("all four attendees are read",
            att.Length == 4);
        t.Ok("Asha never left and is credited the full hour",
            att[0] is { Name: "Asha Nair", Seconds: 3600, Joins: 1 });
        t.Ok("Ravi rejoined, so his two spells total 1800s — not the 3000s between first and last",
            att[1] is { Seconds: 1800, Joins: 2 });
        t.Ok("Meera is marked a guest",
            att[2] is { Guest: true, Seconds: 600 });
        t.Ok("Silent Sam is present with 0 seconds, which is not the same as absent",
            att[3] is { Name: "Silent Sam", Seconds: 0, Joins: 1 });

        t.Ok("quoted numbers from any future change to that SQL read the same",
            Attendees(Fixtures.AttendanceQuoted)[0] is { Seconds: 3600, Joins: 1 });

        t.Section("the webhook JWT");

        t.Ok("exp as a number", ConnectWire.Number(Parse(Fixtures.JwtPayload), "exp") == 1787074911);
        t.Ok("exp quoted reads the same",
            ConnectWire.Number(Parse(Fixtures.JwtPayloadQuotedExp), "exp") == 1787074911);
        t.Ok("the sha256 claim is read as text",
            ConnectWire.Text(Parse(Fixtures.JwtPayload), "sha256")?.EndsWith('=') == true);

        // The payload that would throw one line after a FixedTimeEquals.
        t.Throws<InvalidOperationException>(
            "proof the old code threw: TryGetProperty on a JWT body that is not an object",
            () => Parse(Fixtures.JwtPayloadNotAnObject).TryGetProperty("exp", out _));
        t.Ok("a JWT body that is not an object now yields null, and verification returns false",
            ConnectWire.Number(Parse(Fixtures.JwtPayloadNotAnObject), "exp") is null
            && ConnectWire.Text(Parse(Fixtures.JwtPayloadNotAnObject), "sha256") is null);

        t.Section("TryObject and TryArray");

        t.Ok("TryObject finds a real object",
            ConnectWire.TryObject(Parse(Fixtures.ParticipantJoined), out _, "participant"));
        t.Ok("TryObject refuses a string, an array, a bool and a missing name",
            !ConnectWire.TryObject(Parse(Fixtures.HostileTypes), out _, "room")
            && !ConnectWire.TryObject(Parse(Fixtures.HostileTypes), out _, "participant")
            && !ConnectWire.TryObject(Parse(Fixtures.HostileTypes), out _, "egressInfo")
            && !ConnectWire.TryObject(Parse(Fixtures.HostileTypes), out _, "nothing"));
        t.Ok("a refused TryObject leaves default, never the wrong-kind element",
            !ConnectWire.TryObject(Parse(Fixtures.HostileTypes), out var o, "room")
            && o.ValueKind == JsonValueKind.Undefined);
        t.Ok("TryArray finds a real array and refuses an object",
            ConnectWire.TryArray(Parse(Fixtures.ChatCompletion), out _, "choices")
            && !ConnectWire.TryArray(Parse(Fixtures.ChatCompletion), out _, "usage"));
        t.Ok("a refused TryArray leaves default",
            !ConnectWire.TryArray(Parse(Fixtures.ChatCompletion), out var a, "usage")
            && a.ValueKind == JsonValueKind.Undefined);

        t.Section("Real");

        t.Ok("a plain number", ConnectWire.Real(Parse("""{"x":12.5}"""), "x") == 12.5);
        t.Ok("a quoted number", ConnectWire.Real(Parse("""{"x":"12.5"}"""), "x") == 12.5);
        t.Ok("scientific notation, which Whisper wrappers emit for tiny offsets",
            ConnectWire.Real(Parse("""{"x":"1.5e-3"}"""), "x") == 0.0015);
        t.Ok("a negative offset survives rather than being clamped here",
            ConnectWire.Real(Parse("""{"x":-1.25}"""), "x") == -1.25);
        t.Ok("a COMMA decimal is refused, not read as 125 — this is the locale trap",
            ConnectWire.Real(Parse("""{"x":"12,5"}"""), "x") is null);
        t.Ok("words are null", ConnectWire.Real(Parse("""{"x":"half past"}"""), "x") is null);
        t.Ok("an object, an array, a bool and a missing name are all null",
            ConnectWire.Real(Parse("""{"x":{}}"""), "x") is null
            && ConnectWire.Real(Parse("""{"x":[]}"""), "x") is null
            && ConnectWire.Real(Parse("""{"x":true}"""), "x") is null
            && ConnectWire.Real(Parse("""{"y":1}"""), "x") is null);
        t.Ok("both spellings, same as everything else",
            ConnectWire.Real(Parse("""{"start_time":9.5}"""), "startTime", "start_time") == 9.5);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  8. The sweep
    // ══════════════════════════════════════════════════════════════════════
    private static void NothingThrows(Harness t)
    {
        t.Section("nothing throws");

        // Every reader, against every fixture, plus a set of deliberately
        // broken documents. A webhook handler that throws is a webhook
        // handler that answers 500, and LiveKit discards the event after five
        // of those. Returning null is always allowed; throwing never is.
        var docs = new List<(string Name, string Json)>(Fixtures.All)
        {
            ("empty object", "{}"),
            ("empty array", "[]"),
            ("bare string", "\"hello\""),
            ("bare number", "42"),
            ("bare null", "null"),
            ("bare true", "true"),
            ("nested nulls", """{"event":null,"room":null,"egressInfo":null,"participant":null,"createdAt":null}"""),
            ("arrays where objects go", """{"room":[],"egressInfo":[],"participant":[],"createdAt":[]}"""),
            ("deeply wrong egress", """{"egressInfo":{"fileResults":[[],null,3,"x"],"status":[],"egressId":{}}}"""),
            ("file entry that is not an object", """{"fileResults":["/rec/x.ogg"]}"""),
            ("negative and zero times", """{"createdAt":"-1","startedAt":"0","endedAt":"-999"}"""),
            ("non-numeric numbers", """{"createdAt":"tomorrow","size":"lots","duration":"12.5"}"""),
            ("number too big for int64", """{"createdAt":"99999999999999999999999"}"""),
        };

        var swept = 0;
        foreach (var (name, json) in docs)
        {
            t.NoThrow($"every reader survives: {name}", () =>
            {
                var root = Parse(json);
                ConnectWire.TryProperty(root, out _, "anything");
                ConnectWire.Text(root, "event", "status", "filename");
                ConnectWire.Number(root, "createdAt", "size", "duration", "exp", "seconds");
                ConnectWire.Real(root, "start", "end", "duration");
                ConnectWire.Flag(root, "activeRecording", "audioOnly", "guest");
                ConnectWire.Seconds(root, "createdAt", "created_at");
                ConnectWire.Nanoseconds(root, "startedAt", "started_at");
                ConnectWire.TryMeetingId(root, out _);
                ConnectWire.TryEgress(root, out var e);
                ConnectWire.TryObject(root, out _, "room", "message", "usage");
                ConnectWire.TryArray(root, out _, "choices", "fileResults", "segments");
                ConnectWire.ParticipantText(root, "identity");
                ConnectWire.ReadEgress(root);
                if (e.ValueKind == JsonValueKind.Object) ConnectWire.ReadEgress(e);
                ConnectWire.EventKind(ConnectWire.Text(root, "event"));
                ConnectWire.MapEgressStatus(ConnectWire.Text(root, "status"), null);
            });
            swept++;
        }

        t.Note($"{swept} documents × every reader in ConnectWire, no exception from any of them");

        // A truncated body is the one case that legitimately throws, because
        // it is not JSON at all — and the handler must catch it there and
        // answer 400, not 500. Stated here so the boundary is explicit.
        t.Throws<JsonException>(
            "a truncated body is not JSON and JsonDocument.Parse throws — caught at the handler, answered 400",
            () => Parse("""{"event":"room_star"""));
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private static JsonElement Parse(string json) =>
        JsonDocument.Parse(json).RootElement.Clone();

    private static JsonElement Egress(string json, string field = "egressInfo") =>
        Parse(json).GetProperty(field);

    private static JsonElement FirstFile(string json)
    {
        foreach (var f in Parse(json).GetProperty("fileResults").EnumerateArray()) return f.Clone();
        throw new InvalidOperationException("fixture has no fileResults");
    }
}

/// <summary>
/// A test harness small enough to read in one sitting.
///
/// No framework, so no restore, so this runs on a box with no network and in
/// CI and on a laptop identically. The only contract is the exit code.
/// </summary>
internal sealed class Harness
{
    public int Passed { get; private set; }
    public int Failed { get; private set; }
    public bool Quiet { get; set; }

    public void Section(string title)
    {
        if (Quiet) return;
        Console.WriteLine();
        Console.WriteLine($"  {title}");
    }

    public void Note(string text)
    {
        if (Quiet) return;
        Console.WriteLine($"        · {text}");
    }

    public void Ok(string what, bool passed)
    {
        if (passed)
        {
            Passed++;
            if (!Quiet) Console.WriteLine($"    ok  {what}");
        }
        else
        {
            Failed++;
            Console.WriteLine($"  FAIL  {what}");
        }
    }

    public void Throws<TException>(string what, Action action) where TException : Exception
    {
        try
        {
            action();
            Ok($"{what} [expected {typeof(TException).Name}, nothing was thrown]", false);
        }
        catch (TException)
        {
            Ok(what, true);
        }
        catch (Exception ex)
        {
            Ok($"{what} [expected {typeof(TException).Name}, got {ex.GetType().Name}]", false);
        }
    }

    public void NoThrow(string what, Action action)
    {
        try
        {
            action();
            Ok(what, true);
        }
        catch (Exception ex)
        {
            Ok($"{what} [threw {ex.GetType().Name}: {ex.Message}]", false);
        }
    }

    public int Report()
    {
        Console.WriteLine();
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");
        Console.WriteLine($"  {Passed} ok, {Failed} failed");
        Console.WriteLine();
        return Failed == 0 ? 0 : 1;
    }
}

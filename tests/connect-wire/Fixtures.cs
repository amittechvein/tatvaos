namespace TatvaOS.Tests.Wire;

/// <summary>
/// Real LiveKit payloads.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE RULE FOR THIS FILE: nothing in here is invented to make a test pass.
///
///  Every payload is either copied from what this platform's LiveKit
///  actually sent, or built from LiveKit's protojson serialisation of the
///  matching protobuf message. Where a value is confirmed from production it
///  says so. Where it is from the schema rather than a captured request it
///  says that too, because the difference matters: a fixture a developer
///  imagined tests the developer's imagination.
///
///  The single most important thing in this file is that every int64 is
///  QUOTED. createdAt, joinedAt, creationTime, startedAt, endedAt, duration,
///  size — all strings. That is not a stylistic choice by LiveKit; protojson
///  does it because a 64-bit integer does not survive a JSON number in every
///  parser. Reading one of these with JsonElement.TryGetInt64 throws, and
///  that is the bug this whole project is a monument to.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
internal static class Fixtures
{
    /// <summary>The meeting these fixtures are about. Room names are m-{id}.</summary>
    public const string MeetingId = "3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915";
    public const string RoomName = "m-" + MeetingId;

    /// <summary>
    /// participant_joined — CONFIRMED SHAPE FROM PRODUCTION.
    ///
    /// This is the event whose handling threw. Note `createdAt`: "1787074611",
    /// a string. Note also `joinedAt` and the room's `creationTime`: also
    /// strings, also int64s. And `numParticipants`, an int32, is a plain
    /// number — protojson quotes 64-bit fields and leaves 32-bit ones alone,
    /// so a payload that "looks like it uses numbers" proves nothing about
    /// the field you care about.
    /// </summary>
    public const string ParticipantJoined = """
    {
      "event": "participant_joined",
      "room": {
        "sid": "RM_4nEvVJqXtBSp",
        "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "emptyTimeout": 300,
        "departureTimeout": 20,
        "maxParticipants": 0,
        "creationTime": "1787074610",
        "creationTimeMs": "1787074610412",
        "turnPassword": "0Wl9pQ2rTzKxA1vB",
        "enabledCodecs": [
          { "mime": "audio/opus" },
          { "mime": "video/H264" },
          { "mime": "video/VP8" }
        ],
        "numParticipants": 1,
        "numPublishers": 1,
        "activeRecording": false
      },
      "participant": {
        "sid": "PA_9kQwZ3mNbVcX",
        "identity": "u-8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
        "state": "ACTIVE",
        "joinedAt": "1787074611",
        "joinedAtMs": "1787074611203",
        "name": "Amit Sharma",
        "version": 1,
        "permission": {
          "canSubscribe": true,
          "canPublish": true,
          "canPublishData": true,
          "hidden": false,
          "recorder": false,
          "canUpdateMetadata": false
        },
        "region": "",
        "isPublisher": true,
        "kind": "STANDARD"
      },
      "id": "EV_dXbNmQ7wLpRt",
      "createdAt": "1787074611"
    }
    """;

    /// <summary>
    /// participant_left. Same envelope, and the reason attendance can be
    /// computed at all.
    /// </summary>
    public const string ParticipantLeft = """
    {
      "event": "participant_left",
      "room": {
        "sid": "RM_4nEvVJqXtBSp",
        "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "creationTime": "1787074610",
        "numParticipants": 0
      },
      "participant": {
        "sid": "PA_9kQwZ3mNbVcX",
        "identity": "u-8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
        "state": "DISCONNECTED",
        "joinedAt": "1787074611",
        "name": "Amit Sharma",
        "kind": "STANDARD"
      },
      "id": "EV_pLmXcVbNq2Ws",
      "createdAt": "1787078211"
    }
    """;

    /// <summary>
    /// room_finished. `createdAt` here is what sets meetings.ended_at, which
    /// is what makes a meeting eligible for notes. When this event was being
    /// dropped, no meeting on the platform ever ended.
    /// </summary>
    public const string RoomFinished = """
    {
      "event": "room_finished",
      "room": {
        "sid": "RM_4nEvVJqXtBSp",
        "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "creationTime": "1787074610",
        "numParticipants": 0,
        "activeRecording": false
      },
      "id": "EV_zXcVbNmAsDfG",
      "createdAt": "1787078215"
    }
    """;

    /// <summary>
    /// egress_ended, complete, with a file.
    ///
    /// TWO TRAPS LIVE IN THIS ONE PAYLOAD.
    ///
    /// First: there is NO `room` object. Egress events carry the room name on
    /// egressInfo.roomName instead. A handler that looked only at `room`
    /// would drop every recording callback — and answer 200 while doing it,
    /// so the logs would look perfect.
    ///
    /// Second: the envelope's `createdAt` is 1787078190 — unix SECONDS —
    /// while egressInfo.startedAt is 1787074680000000000 — unix NANOSECONDS.
    /// Same message, two units, both quoted strings, both large numbers. Feed
    /// one to the other's reader and you get a recording that started in the
    /// year 55000 or a meeting that started in 1970, and nothing anywhere
    /// complains.
    /// </summary>
    public const string EgressEndedComplete = """
    {
      "event": "egress_ended",
      "egressInfo": {
        "egressId": "EG_hT7kPqW2ZmXv",
        "roomId": "RM_4nEvVJqXtBSp",
        "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "status": "EGRESS_COMPLETE",
        "startedAt": "1787074680000000000",
        "endedAt": "1787074732000000000",
        "updatedAt": "1787074732114000000",
        "error": "",
        "roomComposite": {
          "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
          "audioOnly": true,
          "file": {
            "fileType": "OGG",
            "filepath": "/var/lib/connect/recordings/2026/08/18/rec-0f9c1d2e.ogg",
            "disableManifest": true
          }
        },
        "fileResults": [
          {
            "filename": "/var/lib/connect/recordings/2026/08/18/rec-0f9c1d2e.ogg",
            "startedAt": "1787074680000000000",
            "endedAt": "1787074732000000000",
            "duration": "52000000000",
            "size": "834112",
            "location": ""
          }
        ]
      },
      "id": "EV_qWeRtYuIoP12",
      "createdAt": "1787078190"
    }
    """;

    /// <summary>
    /// egress_ended, FAILED.
    ///
    /// This is the shape production actually produced the night the recording
    /// volume was owned by the wrong uid: EGRESS_FAILED, an error sentence,
    /// and no fileResults array at all. Everything that reads a file out of
    /// this must answer null rather than reaching into an array that is not
    /// there.
    /// </summary>
    public const string EgressEndedFailed = """
    {
      "event": "egress_ended",
      "egressInfo": {
        "egressId": "EG_bN4mXcVzQwEr",
        "roomId": "RM_4nEvVJqXtBSp",
        "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "status": "EGRESS_FAILED",
        "startedAt": "1787061300000000000",
        "endedAt": "1787061352000000000",
        "error": "local upload failed: open /var/lib/connect/recordings/rec-77aa10b3.ogg: permission denied",
        "errorCode": 500
      },
      "id": "EV_aSdFgHjKlZ34",
      "createdAt": "1787061353"
    }
    """;

    /// <summary>
    /// EGRESS_COMPLETE with an EMPTY fileResults array.
    ///
    /// A real state: the room emptied before a single frame was written, so
    /// egress finished successfully having produced nothing. Calling that
    /// 'ready' puts a download button on screen that answers 404, which is
    /// why MapEgressStatus asks for a filename and not just a status — and
    /// why the database has recordings_ready_has_file behind it.
    /// </summary>
    public const string EgressEndedCompleteNoFile = """
    {
      "event": "egress_ended",
      "egressInfo": {
        "egressId": "EG_yUiOpAsDfGhJ",
        "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "status": "EGRESS_COMPLETE",
        "startedAt": "1787061300000000000",
        "endedAt": "1787061301000000000",
        "fileResults": []
      },
      "id": "EV_mNbVcXzLkJh5",
      "createdAt": "1787061302"
    }
    """;

    /// <summary>
    /// The Twirp REPLY to StartRoomCompositeEgress — an EgressInfo on its own,
    /// no webhook envelope around it. Same reader, different caller, and the
    /// reason ReadEgress takes the egress object rather than the root.
    ///
    /// A start reply has no fileResults yet and no endedAt. Both absent, not
    /// empty.
    /// </summary>
    public const string EgressStartReply = """
    {
      "egressId": "EG_hT7kPqW2ZmXv",
      "roomId": "RM_4nEvVJqXtBSp",
      "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
      "status": "EGRESS_STARTING",
      "startedAt": "0",
      "roomComposite": {
        "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "audioOnly": true
      }
    }
    """;

    /// <summary>
    /// The same egress in snake_case.
    ///
    /// LiveKit's protojson emits lowerCamelCase, and its servers accept and
    /// in some configurations emit the original proto field names. Which one
    /// arrives is not something this platform controls, and betting on one
    /// spelling compiles perfectly and returns null forever.
    /// </summary>
    public const string EgressEndedSnakeCase = """
    {
      "event": "egress_ended",
      "egress_info": {
        "egress_id": "EG_hT7kPqW2ZmXv",
        "room_id": "RM_4nEvVJqXtBSp",
        "room_name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "status": "EGRESS_COMPLETE",
        "started_at": "1787074680000000000",
        "ended_at": "1787074732000000000",
        "file_results": [
          {
            "filename": "/var/lib/connect/recordings/2026/08/18/rec-0f9c1d2e.ogg",
            "duration": "52000000000",
            "size": "834112"
          }
        ]
      },
      "id": "EV_qWeRtYuIoP12",
      "created_at": "1787078190"
    }
    """;

    /// <summary>
    /// track_published — an event this platform deliberately ignores.
    ///
    /// It is in this file for one reason. For a whole day, LiveKit's log was
    /// full of 200 OKs and that was read as proof that webhook delivery
    /// worked. Those 200s were all track_published and track_unpublished,
    /// which are answered before anything is touched. Every event that
    /// mattered was failing on the line below them. If you are reading a
    /// webhook log to decide whether delivery works, MIND WHICH EVENT each
    /// line is about.
    /// </summary>
    public const string TrackPublished = """
    {
      "event": "track_published",
      "room": {
        "sid": "RM_4nEvVJqXtBSp",
        "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "creationTime": "1787074610"
      },
      "participant": {
        "sid": "PA_9kQwZ3mNbVcX",
        "identity": "u-8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
        "joinedAt": "1787074611"
      },
      "track": {
        "sid": "TR_VCabcdef123456",
        "type": "AUDIO",
        "source": "MICROPHONE",
        "mimeType": "audio/opus"
      },
      "id": "EV_trackPub00001",
      "createdAt": "1787074612"
    }
    """;

    /// <summary>
    /// A room that is not a meeting.
    ///
    /// Connect names its rooms m-{guid}. Anything else on the same LiveKit —
    /// a future module, somebody's test, a probe — must be ignored, not
    /// guessed at.
    /// </summary>
    public const string ForeignRoom = """
    {
      "event": "room_started",
      "room": { "sid": "RM_zzzz", "name": "lobby-test", "creationTime": "1787074610" },
      "id": "EV_foreign00001",
      "createdAt": "1787074610"
    }
    """;

    /// <summary>
    /// A room named like a meeting but carrying something that is not a guid.
    /// The prefix check passing does not mean the parse will.
    /// </summary>
    public const string MalformedMeetingRoom = """
    {
      "event": "room_started",
      "room": { "sid": "RM_zzzz", "name": "m-not-a-guid", "creationTime": "1787074610" },
      "id": "EV_malformed0001",
      "createdAt": "1787074610"
    }
    """;

    /// <summary>
    /// Every field present and every field the WRONG TYPE.
    ///
    /// This is the general form of the bug that cost the day. A reader must
    /// answer null for each of these, not throw and not coerce. It is the
    /// payload a version skew, a proxy that rewrites JSON, or a bad actor
    /// produces, and 500s from a webhook handler are not free: LiveKit
    /// retries five times and then discards the event permanently.
    /// </summary>
    public const string HostileTypes = """
    {
      "event": 12345,
      "room": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
      "participant": [ { "identity": "u-1" } ],
      "egressInfo": true,
      "createdAt": { "seconds": 1787074611 },
      "id": null
    }
    """;

    /// <summary>
    /// The envelope with createdAt as a real JSON number.
    ///
    /// Not what LiveKit sends today. It is here because refusing it would be
    /// the same mistake as refusing the string, pointing the other way — and
    /// because every hand-written curl payload, every future LiveKit, and
    /// every replay tool writes it this way.
    /// </summary>
    public const string CreatedAtAsNumber = """
    {
      "event": "room_started",
      "room": { "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915" },
      "id": "EV_number0000001",
      "createdAt": 1787074610
    }
    """;

    /// <summary>An envelope with no createdAt at all. The handler must stamp
    /// the row with 'now' and carry on, not refuse the event.</summary>
    public const string NoCreatedAt = """
    {
      "event": "room_started",
      "room": { "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915" },
      "id": "EV_nocreated00001"
    }
    """;

    /// <summary>
    /// createdAt in NANOSECONDS where the envelope promises seconds — rule 4
    /// caught in the act. Reading this as seconds dates the event to the year
    /// 58,600. The only safe answer is to refuse it.
    /// </summary>
    public const string CreatedAtInNanoseconds = """
    {
      "event": "room_started",
      "room": { "name": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915" },
      "id": "EV_nanos000000001",
      "createdAt": "1787074610000000000"
    }
    """;

    /// <summary>
    /// A payload carrying fields this build has never heard of, on a status
    /// this build does not know.
    ///
    /// LiveKit will ship new versions. An unknown status must leave the
    /// recording row ALONE — the worker reads the true state from LiveKit
    /// anyway — because guessing moves a live recording to a wrong terminal
    /// status and there is no way back from that.
    /// </summary>
    public const string EgressUnknownStatus = """
    {
      "event": "egress_updated",
      "egressInfo": {
        "egressId": "EG_hT7kPqW2ZmXv",
        "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
        "status": "EGRESS_PAUSED",
        "pauseReason": "SUBSCRIBER_STALLED",
        "backupStorageUsed": true,
        "startedAt": "1787074680000000000"
      },
      "id": "EV_unknown0000001",
      "createdAt": "1787074700"
    }
    """;

    /// <summary>
    /// A file whose name has no directory separator at all.
    ///
    /// The leaf-only rule is implemented with LastIndexOf('/') + 1, which is
    /// correct for "no slash" only because -1 + 1 == 0. That is exactly the
    /// kind of cleverness that gets "simplified" into an off-by-one, so it
    /// gets a test.
    /// </summary>
    public const string EgressBareFilename = """
    {
      "egressId": "EG_bare000000001",
      "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
      "status": "EGRESS_COMPLETE",
      "fileResults": [ { "filename": "rec-nodir.ogg", "size": "1024" } ]
    }
    """;

    /// <summary>
    /// Sizes and durations at the top of the int64 range.
    ///
    /// The whole reason protojson quotes these is that they do not fit in a
    /// JavaScript number. A parser that goes through double loses precision
    /// silently, and a recording's byte count is charged to an
    /// organisation's storage pool.
    /// </summary>
    public const string EgressHugeNumbers = """
    {
      "egressId": "EG_huge000000001",
      "roomName": "m-3f2b7c58-9a41-4d0e-b6c2-71a5d8e40915",
      "status": "EGRESS_COMPLETE",
      "fileResults": [
        { "filename": "/rec/huge.mp4", "size": "9007199254740993", "duration": "9223372036854775807" }
      ]
    }
    """;

    // ══════════════════════════════════════════════════════════════════════
    //  THE OTHER PARSERS.
    //
    //  ConnectWire was written for LiveKit, but the sweep that followed found
    //  the same trap in three more places, all reading JSON from something
    //  outside this process:
    //
    //    · the notes composer, walking choices[].message.content out of an
    //      OpenAI-shaped answer — TryGetProperty on a non-object THROWS, and
    //      its catch only handled JsonException;
    //    · the notes worker, reading segment offsets and attendance back out
    //      of jsonb with TryGetDouble and TryGetInt64;
    //    · webhook signature verification, reading a JWT's `exp` with
    //      TryGetInt64 one line after the signature check.
    //
    //  All three now read through ConnectWire. These fixtures are why.
    // ══════════════════════════════════════════════════════════════════════

    /// <summary>A normal OpenAI-shaped chat completion.</summary>
    public const string ChatCompletion = """
    {
      "id": "chatcmpl-9xQ2LmZ",
      "object": "chat.completion",
      "created": 1787074800,
      "model": "gpt-4o-mini",
      "choices": [
        {
          "index": 0,
          "message": { "role": "assistant", "content": "{\"summary\":\"Fees discussed.\"}" },
          "finish_reason": "stop"
        }
      ],
      "usage": { "prompt_tokens": 812, "completion_tokens": 140, "total_tokens": 952 }
    }
    """;

    /// <summary>
    /// The shape that would have thrown.
    ///
    /// `choices` is an array of STRINGS. TryGetProperty("message") on a string
    /// element throws InvalidOperationException, the composer's catch only
    /// handled JsonException, and the notes job dies — taking every meeting
    /// queued behind it with it. Some local llama.cpp front-ends really do
    /// answer like this when asked for a completion rather than a chat.
    /// </summary>
    public const string ChatCompletionFlatChoices = """
    {
      "id": "chatcmpl-broken",
      "choices": [ "Fees discussed.", "Nothing else." ]
    }
    """;

    /// <summary>`message` present but a string rather than an object. Same
    /// throw, one level deeper.</summary>
    public const string ChatCompletionStringMessage = """
    {
      "id": "chatcmpl-odd",
      "choices": [ { "index": 0, "message": "Fees discussed." } ]
    }
    """;

    /// <summary>An answer with no choices at all — a refusal, a rate limit, an
    /// error body. Must read as "no content", not as a crash.</summary>
    public const string ChatCompletionError = """
    {
      "error": {
        "message": "Rate limit reached for gpt-4o-mini",
        "type": "rate_limit_error",
        "code": "rate_limit_exceeded"
      }
    }
    """;

    /// <summary>
    /// transcripts.segments as OpenAI's Whisper writes it — offsets as real
    /// JSON numbers, with decimals.
    /// </summary>
    public const string SegmentsNumeric = """
    [
      { "start": 0, "end": 4.32, "text": "Good morning everyone." },
      { "start": 4.32, "end": 11.08, "text": "Let us start with the fee structure." }
    ]
    """;

    /// <summary>
    /// The same segments from a SELF-HOSTED wrapper, which quotes them.
    ///
    /// This is not hypothetical: this box is about to run its own Whisper, and
    /// several of the OpenAI-compatible front-ends around whisper.cpp and
    /// faster-whisper emit offsets as strings. The old reader called
    /// TryGetDouble on these and threw.
    /// </summary>
    public const string SegmentsStringOffsets = """
    [
      { "start": "0", "end": "4.32", "text": "Good morning everyone." },
      { "start": "4.32", "end": "11.08", "text": "Let us start with the fee structure." }
    ]
    """;

    /// <summary>Segments with junk in them: a bare string, a null, an entry
    /// with no text, an offset that is an object. Each must be skipped or
    /// defaulted, and none may throw.</summary>
    public const string SegmentsHostile = """
    [
      "not a segment",
      null,
      { "text": "" },
      { "start": {}, "end": [], "text": "Kept, with zeroed offsets." },
      { "start": "half past", "end": "later", "text": "Also kept." }
    ]
    """;

    /// <summary>
    /// meeting_notes.attendance, exactly as connect.attendance() renders it
    /// through json_agg. seconds is bigint and joins is integer, so both
    /// arrive as JSON numbers — today.
    /// </summary>
    public const string Attendance = """
    [
      { "name": "Asha Nair",  "guest": false, "seconds": 3600, "joins": 1 },
      { "name": "Ravi Kumar", "guest": false, "seconds": 1800, "joins": 2 },
      { "name": "Meera",      "guest": true,  "seconds": 600,  "joins": 1 },
      { "name": "Silent Sam", "guest": false, "seconds": 0,    "joins": 1 }
    ]
    """;

    /// <summary>
    /// The same attendance with quoted numbers, which is what any change to
    /// that SQL that casts through text would produce — and what the old
    /// reader would have thrown on.
    /// </summary>
    public const string AttendanceQuoted = """
    [
      { "name": "Asha Nair", "guest": false, "seconds": "3600", "joins": "1" }
    ]
    """;

    /// <summary>A LiveKit webhook JWT payload. `exp` is a NumericDate, and the
    /// Go library emits it as a number.</summary>
    public const string JwtPayload = """
    { "iss": "APIabc123", "exp": 1787074911, "sha256": "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
    """;

    /// <summary>The same claim quoted — some JWT libraries do this, and it is
    /// one line after the signature check.</summary>
    public const string JwtPayloadQuotedExp = """
    { "iss": "APIabc123", "exp": "1787074911", "sha256": "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
    """;

    /// <summary>A JWT body that decodes to something that is not an object at
    /// all. TryGetProperty on this throws.</summary>
    public const string JwtPayloadNotAnObject = "\"nonsense\"";

    /// <summary>Every fixture, for the sweep that feeds all of them to every
    /// reader and demands that nothing throws.</summary>
    public static readonly (string Name, string Json)[] All =
    [
        (nameof(ParticipantJoined), ParticipantJoined),
        (nameof(ParticipantLeft), ParticipantLeft),
        (nameof(RoomFinished), RoomFinished),
        (nameof(EgressEndedComplete), EgressEndedComplete),
        (nameof(EgressEndedFailed), EgressEndedFailed),
        (nameof(EgressEndedCompleteNoFile), EgressEndedCompleteNoFile),
        (nameof(EgressStartReply), EgressStartReply),
        (nameof(EgressEndedSnakeCase), EgressEndedSnakeCase),
        (nameof(TrackPublished), TrackPublished),
        (nameof(ForeignRoom), ForeignRoom),
        (nameof(MalformedMeetingRoom), MalformedMeetingRoom),
        (nameof(HostileTypes), HostileTypes),
        (nameof(CreatedAtAsNumber), CreatedAtAsNumber),
        (nameof(NoCreatedAt), NoCreatedAt),
        (nameof(CreatedAtInNanoseconds), CreatedAtInNanoseconds),
        (nameof(EgressUnknownStatus), EgressUnknownStatus),
        (nameof(EgressBareFilename), EgressBareFilename),
        (nameof(EgressHugeNumbers), EgressHugeNumbers),
        (nameof(ChatCompletion), ChatCompletion),
        (nameof(ChatCompletionFlatChoices), ChatCompletionFlatChoices),
        (nameof(ChatCompletionStringMessage), ChatCompletionStringMessage),
        (nameof(ChatCompletionError), ChatCompletionError),
        (nameof(SegmentsNumeric), SegmentsNumeric),
        (nameof(SegmentsStringOffsets), SegmentsStringOffsets),
        (nameof(SegmentsHostile), SegmentsHostile),
        (nameof(Attendance), Attendance),
        (nameof(AttendanceQuoted), AttendanceQuoted),
        (nameof(JwtPayload), JwtPayload),
        (nameof(JwtPayloadQuotedExp), JwtPayloadQuotedExp),
        (nameof(JwtPayloadNotAnObject), JwtPayloadNotAnObject),
    ];
}

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Recording, transcript and notes rows. Columns are snake_case by EF
/// convention; the schema is hand-written SQL
/// (local/postgres/init/20260902-connect-recording.sql) and this file only has
/// to agree with it.
///
/// Mapped explicitly with ToTable(name, "connect") in AppDbContext, never by
/// default — the same rule as the Phase 1 entities, for the same reason.
/// </summary>
public sealed class ConnectRecording
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }

    /// <summary>
    /// LiveKit's identifier for this egress. The handle for StopEgress and the
    /// join key for every webhook that follows, so a row is written only once
    /// LiveKit has given us one — a recording nothing can stop is worse than
    /// no recording.
    /// </summary>
    public string EgressId { get; set; } = "";

    /// <summary>audio | video. Audio is the default; see the migration.</summary>
    public string Mode { get; set; } = "audio";

    /// <summary>starting|recording|processing|ready|failed|aborted|deleted</summary>
    public string Status { get; set; } = "starting";

    /// <summary>
    /// The file NAME inside the recordings volume — never a path. Nothing can
    /// write a '/' into it (a CHECK constraint refuses one), and the download
    /// endpoint re-checks before opening anything.
    /// </summary>
    public string? FileName { get; set; }

    public string? ContentType { get; set; }
    public long SizeBytes { get; set; }
    public long? DurationMs { get; set; }

    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }

    public Guid? RequestedByUserId { get; set; }

    /// <summary>Whether this recording should be transcribed once ready.</summary>
    public bool Transcribe { get; set; } = true;

    public string? Error { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class ConnectTranscript
{
    public Guid Id { get; set; }
    public Guid RecordingId { get; set; }

    /// <summary>
    /// Redundant — the recording knows its meeting — and here on purpose, so
    /// the RLS policy is byte-identical to the other child tables. See
    /// decision 3 in the migration.
    /// </summary>
    public Guid MeetingId { get; set; }

    /// <summary>
    /// queued|running|ready|failed|unavailable.
    ///
    /// 'unavailable' is not a failure: it means no transcription service is
    /// configured. Collapsing the two would send somebody looking for a bug
    /// that is really an unset environment variable.
    /// </summary>
    public string Status { get; set; } = "queued";

    public string? Provider { get; set; }
    public string? Model { get; set; }
    public string? Language { get; set; }

    public string? Text { get; set; }

    /// <summary>JSON array of {start,end,text,speaker}. Stored as text and
    /// mapped to jsonb by Npgsql's default for string→jsonb columns is NOT
    /// automatic, so the column is written as json text — see AppDbContext,
    /// where it is configured with HasColumnType("jsonb").</summary>
    public string Segments { get; set; } = "[]";

    public long? DurationMs { get; set; }
    public int Attempts { get; set; }
    public string? Error { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class ConnectMeetingNotes
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }

    /// <summary>queued|running|ready|failed</summary>
    public string Status { get; set; } = "queued";

    /// <summary>
    /// 'digest'  assembled from the transcript on this server, no model.
    /// 'model'   written by a language model.
    /// The screen says which, in those words. A summary that might be either
    /// with no way to tell is worse than either one honestly labelled.
    /// </summary>
    public string Kind { get; set; } = "digest";

    public string? Provider { get; set; }
    public string? Model { get; set; }

    public string? Summary { get; set; }
    public string KeyPoints { get; set; } = "[]";
    public string Decisions { get; set; } = "[]";
    public string ActionItems { get; set; } = "[]";
    public string Speakers { get; set; } = "[]";

    public string? Error { get; set; }
    public DateTimeOffset? GeneratedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

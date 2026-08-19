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

    /// <summary>
    /// Who attended: names from connect.participants, timings from
    /// connect.meeting_events. Present for every ended meeting, with or
    /// without a recording — see 20260903-connect-notes-attendance.sql.
    /// </summary>
    public string Attendance { get; set; } = "[]";

    /// <summary>
    /// Whether there was a transcript to work from. Lets the screen tell
    /// "this meeting was not recorded" — normal — from "it was recorded and
    /// the transcript failed" — a fault. Those need different sentences.
    /// </summary>
    public bool HadTranscript { get; set; }

    public string? Error { get; set; }
    public DateTimeOffset? GeneratedAt { get; set; }

    // ---- The minutes email ------------------------------------------------
    //
    // EmailedAt is stamped BEFORE the send is attempted, and that order is the
    // whole design. calendar.reminder_sends learned it the same way: a worker
    // that records after sending re-sends everything it was in the middle of
    // when the process restarted, and minutes that arrive three times are how
    // somebody builds a filter rule for you. Recording first can lose one
    // send; recording after can send one repeatedly, forever.

    /// <summary>When the minutes email went out. NULL means it has not.</summary>
    public DateTimeOffset? EmailedAt { get; set; }

    /// <summary>Attempts so far. Three and it stops asking — a permanently
    /// bad recipient list must not be retried every minute for the life of
    /// the deployment.</summary>
    public int EmailAttempts { get; set; }

    public string? EmailError { get; set; }

    /// <summary>How many people it actually reached. 'Sent' with a count of
    /// zero is a different fact from 'sent to eleven people', and an operator
    /// reading this row deserves to tell them apart.</summary>
    public int EmailRecipients { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// One line of meeting chat, kept.
///
/// ─────────────────────────────────────────────────────────────────────────
///  CHAT USED TO EXIST ONLY IN THE BROWSERS THAT WERE OPEN.
///
///  It rides LiveKit's data channel, which is the right transport — it is
///  peer-to-peer through the SFU, it needs no server round trip, and it works
///  when the API is restarting. What it is not is a record. Every link, every
///  "I'll send that by Friday", every question from somebody who could not
///  unmute went away when the tab closed. For a school, a good half of what
///  they actually need from a class is in there.
///
///  So the transport is unchanged and a copy is POSTED here as well. The
///  meeting does not wait for it and does not fail if it does not arrive:
///  chat that is delivered but not stored is a worse meeting record, while
///  chat that is stored but not delivered is a broken meeting.
///
///  THE NAME IS DENORMALISED ON PURPOSE. It is what the person was called AT
///  THE TIME. A join to the user table would rewrite the minutes every time
///  somebody changed their display name, and minutes that change after the
///  fact are not minutes.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ConnectMeetingChat
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }

    /// <summary>
    /// The id the SENDER'S browser made up for this line.
    ///
    /// A guest cannot post to this API, so their lines are stored by one of
    /// the signed-in clients that received them — and 'one of' is a race the
    /// moment two of them try. Unique per meeting, inserted with ON CONFLICT
    /// DO NOTHING, so five clients storing the same line leave one row. It is
    /// the difference between minutes and minutes-in-triplicate.
    /// </summary>
    public Guid ClientId { get; set; }

    /// <summary>The LiveKit identity, which survives a rejoin. NOT a user id:
    /// guests have none, and guests are half the room.</summary>
    public string Identity { get; set; } = "";

    public string DisplayName { get; set; } = "";
    public bool IsGuest { get; set; }

    public string Body { get; set; } = "";

    /// <summary>When it was SAID, as the sender's browser saw it — not when
    /// the POST landed. A line typed during a thirty-second reconnect belongs
    /// where it was typed, or the transcript of the chat reads out of
    /// order.</summary>
    public DateTimeOffset SentAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

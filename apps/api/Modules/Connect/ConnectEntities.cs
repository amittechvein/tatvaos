using System.ComponentModel.DataAnnotations.Schema;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Connect's entities. Columns are snake_case by EF convention; the schema is
/// hand-written SQL (local/postgres/init/20260901-connect.sql) and this file
/// only has to agree with it.
///
/// Every table is mapped explicitly with ToTable(name, "connect") in
/// AppDbContext — never by default. A default schema is exactly how a Mail
/// table once silently landed in core.
/// </summary>
public sealed class ConnectMeeting
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }

    /// <summary>
    /// The shareable capability: 22 chars of base64url over 16 CSPRNG bytes.
    /// Stored in plaintext deliberately (see the migration header) — the host
    /// re-reads and re-shares it for the meeting's life, and the code alone
    /// mints nothing.
    /// </summary>
    public string Code { get; set; } = "";

    public string Title { get; set; } = "Meeting";
    public Guid? CreatedByUserId { get; set; }

    public string Kind { get; set; } = "instant";           // instant | scheduled
    public DateTimeOffset? ScheduledStart { get; set; }
    public DateTimeOffset? ScheduledEnd { get; set; }
    public string Timezone { get; set; } = "Asia/Kolkata";

    public string Status { get; set; } = "scheduled";       // scheduled|active|ended|cancelled

    /// <summary>Stamped by LiveKit's room_started webhook, not optimistically by us.</summary>
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }

    /// <summary>Argon2id via the platform's IPasswordHasher. NULL = no password.</summary>
    public string? PasswordHash { get; set; }

    public string WaitingRoom { get; set; } = "guests";     // everyone | guests | off
    public bool AllowGuests { get; set; } = true;
    public bool Locked { get; set; }

    /// <summary>Reserved for Phase 2's Calendar toggle; unused in Phase 1.</summary>
    public Guid? CalendarEventId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>The LiveKit room name. Never shown to a person, never in a URL.</summary>
    [NotMapped]
    public string RoomName => $"m-{Id}";
}

public sealed class ConnectParticipant
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }

    /// <summary>NULL for a guest — and for a colleague from another tenant,
    /// who is a guest as far as Phase 1 is concerned.</summary>
    public Guid? UserId { get; set; }

    public string DisplayName { get; set; } = "";
    public string Role { get; set; } = "participant";       // host | cohost | participant
    public bool IsGuest { get; set; }

    /// <summary>user:{userId} or guest:{participantId}. Stable across rejoins,
    /// which is what makes attendance aggregate correctly in Phase 3.</summary>
    public string Identity { get; set; } = "";

    // A convenience for the participant list. NOT the source of truth about
    // presence — connect.meeting_events is (see the migration header).
    public DateTimeOffset? FirstJoinedAt { get; set; }
    public DateTimeOffset? LastSeenAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class ConnectLobbyRequest
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }
    public Guid? UserId { get; set; }
    public string DisplayName { get; set; } = "";

    /// <summary>
    /// SHA-256 hex of the wait token, and only that. The plaintext exists
    /// exactly once, in the join response. No application code ever compares
    /// token strings — lookups go by hash, so an attacker must produce a
    /// preimage rather than win a timing race.
    /// </summary>
    public string WaitTokenHash { get; set; } = "";

    public string Status { get; set; } = "waiting";         // waiting|admitted|claimed|denied|expired|cancelled
    public Guid? DecidedByUserId { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class ConnectMeetingEvent
{
    public long Id { get; set; }
    public Guid MeetingId { get; set; }

    public string Kind { get; set; } = "";                  // room_started | participant_joined | ...
    public string? Identity { get; set; }
    public string? DisplayName { get; set; }

    /// <summary>When LiveKit says it happened, not when we stored it: a retry
    /// hours later must not move the attendance figures.</summary>
    public DateTimeOffset OccurredAt { get; set; }

    /// <summary>LiveKit's event id. Unique where present, so a retried webhook
    /// is a no-op rather than a second join.</summary>
    public string? WebhookId { get; set; }

    public string? Payload { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

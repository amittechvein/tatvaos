using System.ComponentModel.DataAnnotations.Schema;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Connect's entities. Columns are snake_case by EF convention; the schema is
/// hand-written SQL (local/postgres/init/20260817-connect.sql) and this file
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

    /// <summary>Start an audio recording when the room starts. A REQUEST, not
    /// a bypass: the room_started webhook re-reads the org's recording flag
    /// and the storage gate at that moment. See 20260819-connect-host-controls.</summary>
    public bool AutoRecord { get; set; }

    /// <summary>Who may share a screen: host | cohost | everyone. Enforced in
    /// the LiveKit token (canPublishSources), minted from the caller's role in
    /// the DATABASE — never from a client claim. See ConnectShare.</summary>
    public string SharePolicy { get; set; } = "everyone";

    /// <summary>Who may SEND chat: everyone | cohost | off. Everyone always
    /// reads. Enforced in the CLIENT, not in the token — chat shares the data
    /// channel with hands, reactions and files, and canPublishData cannot tell
    /// them apart. See ConnectChat and 20260823-connect-chat-policy.sql.</summary>
    public string ChatPolicy { get; set; } = ConnectChat.PolicyEveryone;

    /// <summary>
    /// Capture live captions from participants' browsers, so the meeting gets
    /// attributed minutes. Off by default.
    ///
    /// This REPLACED per-recording transcription rather than joining it: paid
    /// transcription was 97% of the bill and, coming from one mixed stream,
    /// could not say who spoke. Captions cost nothing and can. See
    /// 20260823-connect-live-minutes.sql.
    /// </summary>
    public bool MinutesLive { get; set; }

    /// <summary>
    /// recorded | private. Chosen at creation and IMMUTABLE — a database
    /// trigger refuses any change, because the mode is a promise made to
    /// everyone who already joined under it. See
    /// 20260820-connect-meeting-mode.sql.
    ///
    /// A plain string, mapping to a plain text column by EF convention, so
    /// nothing is needed in AppDbContext. That is deliberate:
    /// meeting_events.payload is jsonb, was never mapped, and every insert
    /// failed silently from the day the module shipped.
    /// </summary>
    public string Mode { get; set; } = ConnectModes.Recorded;

    /// <summary>True when the server may decode this meeting's media at all —
    /// the one question recording, transcription and notes all reduce to.</summary>
    [NotMapped]
    public bool MediaIsReadable => Mode != ConnectModes.Private;

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

/// <summary>
/// The two meeting modes, and the one sentence each is allowed to claim.
///
/// Named constants rather than bare strings because these values appear in
/// the migration's CHECK, in the API, and in the browser, and a typo in any
/// one of them is a meeting that behaves as the wrong kind.
/// </summary>
public static class ConnectModes
{
    /// <summary>Recording, transcription and AI notes are available, with the
    /// written and spoken notice. No E2EE.</summary>
    public const string Recorded = "recorded";

    /// <summary>End-to-end encrypted: the media server cannot decode the
    /// media, so there is nothing to record, transcribe or summarise. Not a
    /// policy — a property of the packets.</summary>
    public const string Private = "private";

    public static bool IsValid(string? mode) => mode is Recorded or Private;

    /// <summary>
    /// The refusal every media-touching endpoint gives for a Private meeting.
    /// One sentence, in one place, so the reason cannot drift between the
    /// three endpoints that say it — and so it never implies a setting the
    /// host could change, because there isn't one.
    /// </summary>
    public const string MediaRefusal =
        "This is a private meeting. Its audio and video are encrypted so that even "
        + "the meeting server cannot read them, which means it cannot be recorded, "
        + "transcribed or summarised. Create a recorded meeting if you need those.";
}

/// <summary>
/// Who a host has thrown out of a meeting — the row that makes "Remove" mean
/// removed rather than "removed until they click the link again".
///
/// Keyed on user_id because that is the only STABLE handle: a guest gets a
/// fresh participant row (and so a fresh identity) every time they come
/// through the door, so a guest cannot be usefully blocklisted. For guests the
/// waiting room is the control — Remove already cancels their admitted lobby
/// rows, so they land back in it and the host says no at the door.
/// </summary>
public sealed class ConnectMeetingBlock
{
    public Guid Id { get; set; }
    public Guid MeetingId { get; set; }

    /// <summary>NULL for a guest, whose block is an audit record only.</summary>
    public Guid? UserId { get; set; }

    /// <summary>Who they appeared as when they were removed. Audit, not a key.</summary>
    public string Identity { get; set; } = "";
    public string DisplayName { get; set; } = "";

    public Guid? BlockedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// The share policy, translated into LiveKit's canPublishSources grant.
///
/// The names are LiveKit's TrackSource strings as its access tokens spell
/// them — lower-case with underscores — verified against livekit-server-sdk's
/// TrackSource serialisation. An ABSENT canPublishSources claim means "all
/// sources", which is why the permitted case returns null rather than the
/// full list: emitting the list would pin us to today's spelling of every
/// source LiveKit will ever add.
/// </summary>
public static class ConnectShare
{
    public const string PolicyHost = "host";
    public const string PolicyCohost = "cohost";
    public const string PolicyEveryone = "everyone";

    public static bool IsValidPolicy(string? policy) =>
        policy is PolicyHost or PolicyCohost or PolicyEveryone;

    /// <summary>True when this role may share under this policy.</summary>
    public static bool MayShare(string policy, string? role) => policy switch
    {
        PolicyHost => role == "host",
        PolicyCohost => role is "host" or "cohost",
        _ => true,
    };

    /// <summary>
    /// The canPublishSources claim for a token: null (absent — everything) when
    /// sharing is permitted, camera-and-microphone-only when it is not.
    /// </summary>
    public static string[]? SourcesFor(string policy, string? role) =>
        MayShare(policy, role) ? null : ["camera", "microphone"];
}

/// <summary>
/// Who may type in the meeting's chat.
///
/// Shaped like ConnectShare on purpose — one idea to learn, not two — but it
/// is enforced somewhere else, and the difference matters. ConnectShare ends
/// up in the LiveKit token, where the client cannot argue with it. This one
/// cannot: chat, raised hands, reactions and file transfers all ride the one
/// data channel, and canPublishData is all four or none. Silencing chat by
/// token would also stop somebody raising a hand to ask why they had been
/// silenced.
///
/// So this is a courtesy the client keeps, in the same way a client already
/// reports its own raised hand honestly. It stops twenty people talking over
/// a presenter, which is what it was asked for. It is not a control, and no
/// caller should treat it as one.
/// </summary>
public static class ConnectChat
{
    public const string PolicyEveryone = "everyone";
    public const string PolicyCohost = "cohost";
    public const string PolicyOff = "off";

    public static bool IsValidPolicy(string? policy) =>
        policy is PolicyEveryone or PolicyCohost or PolicyOff;

    /// <summary>True when this role may send under this policy. Reading is
    /// never restricted — a meeting that closed chat halfway through should
    /// not lose what was said before it.</summary>
    public static bool MaySend(string policy, string? role) => policy switch
    {
        PolicyOff => false,
        PolicyCohost => role is "host" or "cohost",
        _ => true,
    };
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

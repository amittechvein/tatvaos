using System.ComponentModel.DataAnnotations;

namespace TatvaOS.Api.Shared.Data;

// ============================================================================
//  CALENDAR
// ============================================================================
//
//  Mirrors 20260816-calendar.sql. The three decisions that shape it are in
//  that file's header: recurrence is a rule not rows, every event carries UTC
//  AND its originating zone, and exceptions exist from day one.
//
//  Field names follow RFC 5545 where the standard has a name (Uid, Sequence,
//  Status, Transparency, PartStat) so producing a VEVENT is a copy rather
//  than a translation — an invitation Gmail and Outlook cannot read is a
//  broken product.
// ============================================================================

public class CalendarCalendar
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>NULL for an organisation calendar — it outlives its creator.</summary>
    public Guid? OwnerUserId { get; set; }

    [MaxLength(200)] public required string Name { get; set; }
    public string? Description { get; set; }
    [MaxLength(16)]  public string Colour { get; set; } = "#4285f4";

    /// <summary>personal | organisation | resource (a room is a calendar).</summary>
    [MaxLength(16)]  public string Kind { get; set; } = "personal";
    [MaxLength(64)]  public string Timezone { get; set; } = "Asia/Kolkata";

    public bool IsPrimary { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? DeletedAt { get; set; }
}

public class CalendarMember
{
    public Guid CalendarId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>
    /// free_busy | reader | writer | owner.
    ///
    /// free_busy is the one that makes "find a time" possible without
    /// exposing what anybody is doing: busy at 3, not "Interview: replacing
    /// Priya".
    /// </summary>
    [MaxLength(16)] public string Role { get; set; } = "free_busy";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class CalendarEvent
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CalendarId { get; set; }

    /// <summary>RFC 5545 UID — what an external reply quotes. Never changes.</summary>
    [MaxLength(256)] public required string Uid { get; set; }

    /// <summary>
    /// RFC 5545 SEQUENCE. Bumped on every material change; receivers use it
    /// to tell an update from a duplicate, and without it a re-sent
    /// invitation is ignored.
    /// </summary>
    public int Sequence { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? OrganiserUserId { get; set; }

    [MaxLength(300)] public required string Title { get; set; }
    public string? Description { get; set; }
    [MaxLength(300)] public string? Location { get; set; }
    [MaxLength(500)] public string? MeetingUrl { get; set; }

    public DateTimeOffset StartsAt { get; set; }
    public DateTimeOffset EndsAt { get; set; }

    /// <summary>The zone the event was CREATED in — see the migration header.</summary>
    [MaxLength(64)] public string Timezone { get; set; } = "Asia/Kolkata";

    public bool IsAllDay { get; set; }

    /// <summary>RFC 5545 RRULE, stored verbatim. Null for a one-off.</summary>
    [MaxLength(500)] public string? RecurrenceRule { get; set; }

    /// <summary>opaque blocks the organiser's time; transparent does not.</summary>
    [MaxLength(16)] public string Transparency { get; set; } = "opaque";
    [MaxLength(16)] public string Status { get; set; } = "confirmed";
    [MaxLength(16)] public string Visibility { get; set; } = "default";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? DeletedAt { get; set; }
}

/// <summary>
/// One changed occurrence of a series, keyed by its ORIGINAL start
/// (RFC 5545 RECURRENCE-ID). "Not this week" is IsCancelled; "this one is at
/// 11" is the nullable overrides.
/// </summary>
public class CalendarEventException
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid EventId { get; set; }
    public DateTimeOffset OccurrenceStartsAt { get; set; }

    public bool IsCancelled { get; set; }
    public DateTimeOffset? StartsAt { get; set; }
    public DateTimeOffset? EndsAt { get; set; }
    [MaxLength(300)] public string? Title { get; set; }
    [MaxLength(300)] public string? Location { get; set; }
}

public class CalendarAttendee
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid EventId { get; set; }

    /// <summary>Null for someone outside the organisation — email is the key.</summary>
    public Guid? UserId { get; set; }
    [MaxLength(320)] public required string Email { get; set; }
    [MaxLength(200)] public string? DisplayName { get; set; }

    /// <summary>RFC 5545 ROLE: req-participant | opt-participant | chair.</summary>
    [MaxLength(24)] public string Role { get; set; } = "req-participant";

    /// <summary>RFC 5545 PARTSTAT: needs-action | accepted | declined | tentative.</summary>
    [MaxLength(16)] public string Status { get; set; } = "needs-action";

    public DateTimeOffset? RespondedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public class CalendarReminder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid EventId { get; set; }

    /// <summary>Null means everyone on the event; a user id means one person.</summary>
    public Guid? UserId { get; set; }

    /// <summary>
    /// Minutes BEFORE the occurrence, not an absolute time — a reminder on a
    /// recurring event fires before every occurrence, and a timestamp can
    /// only describe one.
    /// </summary>
    public int MinutesBefore { get; set; }
    [MaxLength(16)] public string Method { get; set; } = "notification";
}

/// <summary>
/// Which reminder has already fired for which occurrence. Without it, a restart
/// re-sends every reminder in the window — and a reminder that arrives twice
/// teaches people to ignore reminders.
/// </summary>
public class CalendarReminderSend
{
    public Guid ReminderId { get; set; }
    public DateTimeOffset OccurrenceStartsAt { get; set; }
    public DateTimeOffset SentAt { get; set; } = DateTimeOffset.UtcNow;
}

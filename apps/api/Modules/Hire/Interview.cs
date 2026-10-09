namespace TatvaOS.Api.Modules.Hire;

/// <summary>
/// An interview on one application (hire.interviews, 20261009-s). Scheduled by
/// administrators and recruiters; cancelled, never deleted, until the candidate
/// is erased (cascade).
/// </summary>
public sealed class HireInterview
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid ApplicationId { get; set; }
    public DateTimeOffset ScheduledAt { get; set; }
    public int DurationMinutes { get; set; } = 60;
    /// <summary>in_person, video, phone.</summary>
    public string Mode { get; set; } = "in_person";
    /// <summary>An address, a room or a meeting link. Plain text.</summary>
    public string? Place { get; set; }
    /// <summary>scheduled or cancelled.</summary>
    public string Status { get; set; } = "scheduled";
    public string? CancelReason { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>Someone on an interview's panel. Feedback requires a row here (database FK).</summary>
public sealed class HireInterviewPanelMember
{
    public Guid TenantId { get; set; }
    public Guid InterviewId { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset AddedAt { get; set; }
}

/// <summary>One panel member's feedback on one interview. Never copied to the audit log.</summary>
public sealed class HireInterviewFeedback
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid InterviewId { get; set; }
    public Guid InterviewerId { get; set; }
    /// <summary>1 (poor) to 5 (excellent).</summary>
    public short Rating { get; set; }
    /// <summary>strong_yes, yes, no, strong_no.</summary>
    public string Recommendation { get; set; } = "";
    public string? Notes { get; set; }
    public DateTimeOffset SubmittedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

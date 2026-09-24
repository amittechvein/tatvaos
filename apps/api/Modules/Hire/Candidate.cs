namespace TatvaOS.Api.Modules.Hire;

// ============================================================================
//  Candidates, applications and the pipeline — TatvaOS Hire R1 (24 Sept 2026).
//  Tables in 20260924-d-hire-candidates.sql. Like job openings, none of these
//  has a DbSet on AppDbContext: HireAccess is the only route to them, so what
//  a hiring manager can see is decided in one place (check-job-gate.sh).
// ============================================================================

/// <summary>A stage in an organisation's pipeline. Table <c>hire.pipeline_stages</c>.</summary>
public sealed class HirePipelineStage
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public int Position { get; set; }
    /// <summary>The last stage (Joined) — where People will take over.</summary>
    public bool IsFinal { get; set; }
    public bool IsActive { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// A person being recruited. Table <c>hire.candidates</c>.
///
/// PERSONAL DATA. Contact and career details only — no identity documents,
/// no files (see the migration). Erased by deleting the row, which cascades
/// to applications and their history. Never copy the name, email or phone
/// into core.audit_logs: an erased candidate must stay erased.
/// </summary>
public sealed class HireCandidate
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string FullName { get; set; } = "";
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string? CurrentLocation { get; set; }
    public string? CurrentCompany { get; set; }
    public string? CurrentDesignation { get; set; }
    public short? ExperienceMonths { get; set; }
    public string? Education { get; set; }
    public string[] Skills { get; set; } = [];
    public string[] Tags { get; set; } = [];
    public decimal? ExpectedSalary { get; set; }
    public string SalaryCurrency { get; set; } = "INR";
    public short? NoticePeriodDays { get; set; }
    /// <summary>careers_page, referral, linkedin, job_board, agency, walk_in, other.</summary>
    public string Source { get; set; } = "other";
    public string? SourceDetail { get; set; }
    public string? LinkedinUrl { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// One candidate applying to one job opening. Table <c>hire.applications</c>.
/// Rejected requires a reason — the database refuses one without.
/// </summary>
public sealed class HireApplication
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid CandidateId { get; set; }
    public Guid JobId { get; set; }
    public Guid StageId { get; set; }
    /// <summary>active, rejected, withdrawn.</summary>
    public string Outcome { get; set; } = "active";
    public string? RejectionReason { get; set; }
    public DateTimeOffset AppliedAt { get; set; }
    public DateTimeOffset StageChangedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>What happened to an application, in order. Append-only (no UPDATE or DELETE grant).</summary>
public sealed class HireApplicationEvent
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid ApplicationId { get; set; }
    /// <summary>created, moved, rejected, withdrawn, reopened.</summary>
    public string Kind { get; set; } = "";
    public Guid? FromStageId { get; set; }
    public Guid? ToStageId { get; set; }
    public string? Reason { get; set; }
    public Guid? ActorId { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}

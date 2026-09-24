namespace TatvaOS.Api.Modules.Hire;

/// <summary>
/// A position an organisation is recruiting for — TatvaOS Hire R1
/// (24 September 2026). Table <c>hire.job_openings</c>.
///
/// Every reference (department, designation, location, hiring manager,
/// recruiter) is pinned to the job's own organisation by a composite foreign
/// key in the database, not only by the API's lookups — see the migration.
///
/// The three long text fields are PLAIN TEXT. They will be shown to strangers
/// on the careers page, so they are never treated as HTML anywhere.
/// </summary>
public sealed class JobOpening
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }

    public string Title { get; set; } = "";
    /// <summary>Public address on the careers page. Set once; never follows a title edit.</summary>
    public string Slug { get; set; } = "";

    public Guid? DepartmentId { get; set; }
    public Guid? DesignationId { get; set; }
    public Guid? LocationId { get; set; }

    /// <summary>full_time, part_time, contract, internship, temporary.</summary>
    public string EmploymentType { get; set; } = "full_time";

    public short? ExperienceMinYears { get; set; }
    public short? ExperienceMaxYears { get; set; }
    public string? Qualification { get; set; }
    public string[] Skills { get; set; } = [];

    public decimal? SalaryMin { get; set; }
    public decimal? SalaryMax { get; set; }
    public string SalaryCurrency { get; set; } = "INR";
    /// <summary>year or month.</summary>
    public string SalaryPeriod { get; set; } = "year";
    /// <summary>May the range appear on the careers page. Off unless chosen.</summary>
    public bool ShowSalary { get; set; }

    public int Vacancies { get; set; } = 1;

    public string? Description { get; set; }
    public string? Responsibilities { get; set; }
    public string? Requirements { get; set; }

    public Guid? HiringManagerId { get; set; }
    public Guid? RecruiterId { get; set; }

    public DateOnly? OpeningDate { get; set; }
    public DateOnly? ClosingDate { get; set; }

    /// <summary>draft, open, on_hold, closed.</summary>
    public string Status { get; set; } = "draft";
    /// <summary>filled or cancelled — set exactly when Status is closed.</summary>
    public string? ClosedReason { get; set; }
    /// <summary>First time it opened. Non-null forbids deleting it.</summary>
    public DateTimeOffset? PublishedAt { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }

    public Guid? CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

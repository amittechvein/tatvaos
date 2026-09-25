using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Hire;

/// <summary>A person's place on an organisation's hiring team. Table <c>hire.team_members</c>.</summary>
public sealed class HireTeamMember
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    /// <summary>recruiter or hiring_manager.</summary>
    public string Role { get; set; } = "";
    public Guid? AddedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>What a person may do in Hire, highest first.</summary>
public enum HireLevel { None = 0, HiringManager = 1, Recruiter = 2, Admin = 3 }

/// <summary>
/// The one place that decides what the signed-in person may do in Hire
/// (Amit, 24 September 2026: recruiters and hiring managers, not only
/// administrators).
///
/// ─────────────────────────────────────────────────────────────────────────
///  Admin           org_owner / org_admin / super_admin — everything, and the
///                  only level that may change the team.
///  Recruiter       every job opening in the organisation.
///  HiringManager   only jobs whose hiring_manager_id is them. Another job
///                  answers 404, not 403: whether a job exists is itself
///                  something they were not given.
///  None            403 on every Hire call.
///
///  THIS CLASS IS THE ONLY ROUTE TO hire.job_openings — enforced, not asked
///  (Mr. Singh, 24 Sept: "make the gate structural, not documented").
///    * AppDbContext has NO JobOpenings property. The table is mapped, so
///      EF knows it, but nothing outside this file can name it by accident.
///    * tests/hire/check-job-gate.sh fails CI if Set<JobOpening>(), a DbSet
///      of it, or SQL on hire.job_openings appears in any other C# file.
///      That is the backstop for the one route C# cannot close.
///  Why it matters: a handler reading the table directly would show a hiring
///  manager every job in the organisation, and nothing would look wrong —
///  the tenant filter would still be doing its job.
///
///  Two kinds of access leave this file, and only these:
///    * Jobs(level): what THIS person may see. Every Hire screen uses it.
///    * OrganisationWide: counts and ids for Core's administrative "is this
///      in use" checks (location, designation, department deletion). They
///      return numbers and ids, never a query, so they cannot be extended
///      into a listing.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class HireAccess(AppDbContext db, TenantContext tenant, IHttpContextAccessor http)
{
    private static readonly string[] AdminRoles = ["super_admin", "org_owner", "org_admin"];
    private HireLevel? _level;

    public Guid? UserId => tenant.UserId;

    public async Task<HireLevel> LevelAsync(CancellationToken ct)
    {
        if (_level is { } cached) return cached;

        var user = http.HttpContext?.User;
        if (user?.Identity?.IsAuthenticated != true || tenant.UserId is not Guid me)
            return (_level = HireLevel.None).Value;

        var role = user.FindFirst(ClaimTypes.Role)?.Value;
        if (role is not null && AdminRoles.Contains(role))
            return (_level = HireLevel.Admin).Value;

        var teamRole = await db.HireTeamMembers.AsNoTracking()
            .Where(m => m.UserId == me)
            .Select(m => m.Role)
            .FirstOrDefaultAsync(ct);

        _level = teamRole switch
        {
            "recruiter" => HireLevel.Recruiter,
            "hiring_manager" => HireLevel.HiringManager,
            _ => HireLevel.None,
        };
        return _level.Value;
    }

    /// <summary>The job openings this person may see. Always start here.</summary>
    public IQueryable<JobOpening> Jobs(HireLevel level)
    {
        var q = db.Set<JobOpening>().AsQueryable();
        if (level >= HireLevel.Recruiter) return q;
        if (level == HireLevel.HiringManager && tenant.UserId is Guid me)
            return q.Where(j => j.HiringManagerId == me);
        return q.Where(_ => false);
    }

    /// <summary>
    /// What the PUBLIC careers page may list: open jobs, not past their
    /// closing date, of the organisation the request was scoped to by
    /// hire.resolve_careers_site(). Drafts, on-hold and closed jobs are never
    /// in it. The caller projects to the public fields (CareersEndpoints).
    /// </summary>
    public IQueryable<JobOpening> PublicJobs(DateOnly today) =>
        db.Set<JobOpening>().Where(j => j.Status == "open" && j.Slug != null
                                     && (j.ClosingDate == null || j.ClosingDate >= today));

    /// <summary>This organisation's careers site, or null if not set up.</summary>
    public Task<HireCareersSite?> CareersSiteAsync(CancellationToken ct) =>
        db.Set<HireCareersSite>().AsNoTracking().FirstOrDefaultAsync(ct);

    /// <summary>Creates or updates this organisation's careers site (validated by the caller).</summary>
    public async Task SaveCareersSiteAsync(string slug, string name, string? contact, bool enabled, CancellationToken ct)
    {
        var row = await db.Set<HireCareersSite>().FirstOrDefaultAsync(ct);
        var now = DateTimeOffset.UtcNow;
        if (row is null)
        {
            row = new HireCareersSite { TenantId = tenant.TenantId, CreatedAt = now };
            db.Set<HireCareersSite>().Add(row);
        }
        row.Slug = slug;
        row.DisplayName = name;
        row.ErasureContact = contact;
        row.IsEnabled = enabled;
        row.UpdatedBy = tenant.UserId;
        row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>A new job, for the caller to save. The caller has already checked the level.</summary>
    public void Add(JobOpening job) => db.Set<JobOpening>().Add(job);

    /// <summary>Removes a job the caller loaded through <see cref="Jobs"/>.</summary>
    public void Remove(JobOpening job) => db.Set<JobOpening>().Remove(job);

    /// <summary>
    /// Is this public address taken anywhere in the organisation — including
    /// by jobs this person cannot see, which is why it is not Jobs(level).
    /// Answers yes or no only.
    /// </summary>
    public Task<bool> SlugTakenAsync(string slug, CancellationToken ct) =>
        db.Set<JobOpening>().AnyAsync(j => j.Slug == slug, ct);

    /// <summary>
    /// Organisation-wide facts for Core's administrative checks. Numbers and
    /// ids only — see the class comment. Still inside the tenant filter.
    /// </summary>
    public static class OrganisationWide
    {
        public static Task<int> CountNamingLocationAsync(AppDbContext db, Guid locationId, CancellationToken ct) =>
            db.Set<JobOpening>().CountAsync(j => j.LocationId == locationId, ct);

        public static Task<int> CountNamingDesignationAsync(AppDbContext db, Guid designationId, CancellationToken ct) =>
            db.Set<JobOpening>().CountAsync(j => j.DesignationId == designationId, ct);

        /// <summary>Per department, how many job openings name it. One query.</summary>
        public static Task<Dictionary<Guid, int>> CountsByDepartmentAsync(AppDbContext db, CancellationToken ct) =>
            db.Set<JobOpening>().AsNoTracking()
                .Where(j => j.DepartmentId != null)
                .GroupBy(j => j.DepartmentId!.Value)
                .Select(g => new { g.Key, N = g.Count() })
                .ToDictionaryAsync(x => x.Key, x => x.N, ct);

        /// <summary>
        /// The jobs a department's deletion will blank, for their audit rows:
        /// id, title and status — what an audit entry needs, nothing more.
        /// </summary>
        public static async Task<List<(Guid Id, string Title, string Status)>> NamingDepartmentAsync(
            AppDbContext db, Guid departmentId, CancellationToken ct)
        {
            var rows = await db.Set<JobOpening>().AsNoTracking()
                .Where(j => j.DepartmentId == departmentId)
                .Select(j => new { j.Id, j.Title, j.Status })
                .ToListAsync(ct);
            return rows.Select(r => (r.Id, r.Title, r.Status)).ToList();
        }
    }

    public static string Name(HireLevel level) => level switch
    {
        HireLevel.Admin => "admin",
        HireLevel.Recruiter => "recruiter",
        HireLevel.HiringManager => "hiring_manager",
        _ => "none",
    };

    public static IResult NoAccess() => Results.Json(new
    {
        error = "You are not on this organisation's hiring team. An administrator can add you under Hire → Team.",
    }, statusCode: StatusCodes.Status403Forbidden);
}

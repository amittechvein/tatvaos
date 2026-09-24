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
///  EVERY JOB READ GOES THROUGH <see cref="Jobs"/>. A handler that queried
///  db.JobOpenings directly would show a hiring manager every job in the
///  organisation, and nothing would look wrong — the tenant filter would
///  still be doing its job. That is the quiet failure to watch for when
///  adding an endpoint here.
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
        var q = db.JobOpenings.AsQueryable();
        if (level >= HireLevel.Recruiter) return q;
        if (level == HireLevel.HiringManager && tenant.UserId is Guid me)
            return q.Where(j => j.HiringManagerId == me);
        return q.Where(_ => false);
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

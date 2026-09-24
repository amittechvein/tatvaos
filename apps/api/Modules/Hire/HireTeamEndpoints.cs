using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Hire;

/// <summary>
/// The hiring team — who besides administrators may use Hire (Amit,
/// 24 September 2026).
///
/// Changing the team is ADMINISTRATORS ONLY. A recruiter who could add
/// people could hand Hire access (and with it candidates' personal details,
/// once applications exist) to anyone in the organisation; that decision
/// stays with whoever already holds the keys to the organisation.
/// Recruiters may LIST the team, so they know who else is hiring.
/// </summary>
public static class HireTeamEndpoints
{
    private static readonly string[] Roles = ["recruiter", "hiring_manager"];

    public static void MapHireTeamEndpoints(this IEndpointRouteBuilder app)
    {
        // Who am I in Hire — the web app decides what to show from this, and
        // the API re-checks on every call regardless.
        app.MapGet("/api/hire/me", MeAsync).RequireAuthorization("User").WithTags("Hire");

        var g = app.MapGroup("/api/hire/team").RequireAuthorization("User").WithTags("Hire");
        g.MapGet("/", ListAsync);
        g.MapPut("/{userId:guid}", SetAsync);
        g.MapDelete("/{userId:guid}", RemoveAsync);
    }

    private static async Task<IResult> MeAsync(HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        return Results.Ok(new
        {
            access = HireAccess.Name(level),
            canManageTeam = level == HireLevel.Admin,
            canSeeAllJobs = level >= HireLevel.Recruiter,
        });
    }

    private static async Task<IResult> ListAsync(HireAccess access, AppDbContext db, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) < HireLevel.Recruiter) return HireAccess.NoAccess();

        var members = await db.HireTeamMembers.AsNoTracking().ToListAsync(ct);
        var ids = members.Select(m => m.UserId).ToList();
        var people = await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email, u.Status })
            .ToDictionaryAsync(u => u.Id, ct);

        return Results.Ok(members
            .Where(m => people.ContainsKey(m.UserId))
            .Select(m => new
            {
                m.UserId,
                people[m.UserId].DisplayName,
                people[m.UserId].Email,
                active = people[m.UserId].Status == "active",
                m.Role,
                m.CreatedAt,
            })
            .OrderBy(m => m.Role).ThenBy(m => m.DisplayName));
    }

    private static async Task<IResult> SetAsync(
        Guid userId, SetTeamRoleRequest req, HireAccess access, AppDbContext db,
        TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) != HireLevel.Admin)
            return Results.Json(new { error = "Only an administrator can change the hiring team." },
                                statusCode: StatusCodes.Status403Forbidden);

        var role = req.Role?.Trim() ?? "";
        if (!Roles.Contains(role)) return Results.BadRequest(new { error = "Role must be recruiter or hiring manager." });

        // Through the tenant filter: another organisation's person is "not found".
        var person = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { u.DisplayName, u.Status, u.Role })
            .FirstOrDefaultAsync(ct);
        if (person is null) return Results.NotFound(new { error = "That person is not in this organisation." });
        if (person.Status != "active") return Results.BadRequest(new { error = $"{person.DisplayName} is not active." });

        var row = await db.HireTeamMembers.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        var before = row?.Role;
        var now = DateTimeOffset.UtcNow;
        if (row is null)
        {
            db.HireTeamMembers.Add(new HireTeamMember
            {
                TenantId = tenant.TenantId, UserId = userId, Role = role,
                AddedBy = tenant.UserId, CreatedAt = now, UpdatedAt = now,
            });
        }
        else
        {
            row.Role = role;
            row.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync(before is null ? "hire_team.added" : "hire_team.changed", "user", userId.ToString(),
            before: before is null ? null : new { role = before }, after: new { role },
            ct: ct, productCode: "hire");

        return Results.Ok(new { userId, role });
    }

    private static async Task<IResult> RemoveAsync(
        Guid userId, HireAccess access, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) != HireLevel.Admin)
            return Results.Json(new { error = "Only an administrator can change the hiring team." },
                                statusCode: StatusCodes.Status403Forbidden);

        var row = await db.HireTeamMembers.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (row is null) return Results.NotFound();

        db.HireTeamMembers.Remove(row);
        await db.SaveChangesAsync(ct);
        // Their name stays on any job as hiring manager or recruiter — that
        // is a record of who did the hiring — but they can no longer open it.
        await audit.WriteAsync("hire_team.removed", "user", userId.ToString(),
            before: new { role = row.Role }, ct: ct, productCode: "hire");

        return Results.Ok(new { removed = true });
    }
}

public sealed record SetTeamRoleRequest(string? Role);

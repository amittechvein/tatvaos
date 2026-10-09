using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.People;

/// <summary>An employee (people.employees, 20261009). Not a login: <see cref="UserId"/> is optional.</summary>
public sealed class Employee
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string EmployeeCode { get; set; } = "";
    public Guid? UserId { get; set; }
    public string FullName { get; set; } = "";
    public string? WorkEmail { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? DesignationId { get; set; }
    public Guid? LocationId { get; set; }
    /// <summary>Setting this grants access (0018): the manager may then see this record.</summary>
    public Guid? ReportsTo { get; set; }
    public string EmploymentType { get; set; } = "full_time";
    public string Status { get; set; } = "active";
    public DateOnly JoinedOn { get; set; }
    public DateOnly? ExitOn { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

/// <summary>One change of a reporting line. Written by the database's trigger only.</summary>
public sealed class ReportingChange
{
    public long Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid EmployeeId { get; set; }
    public Guid? FromManagerId { get; set; }
    public Guid? ToManagerId { get; set; }
    public Guid ChangedBy { get; set; }
    public DateTimeOffset ChangedAt { get; set; }
}

/// <summary>Someone named People HR in their organisation (0018 §4).</summary>
public sealed class PeopleHrMember
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public Guid? AddedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// The ONLY way to People's employee records (decision 0018 §4) — this lane's
/// HireAccess. Every handler asks it and nothing else; there is no DbSet, and
/// tests/people/check-people-gate.sh fails the build on a Set&lt;Employee&gt;
/// or a people.employees query anywhere outside this file.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHO SEES WHOM
///    * People HR (people.hr_members): everyone. NOT core.users.role: an
///      organisation owner is HR only after naming themselves (Amit, 9 Oct).
///    * Anyone else: themselves, and the people who report to them,
///      directly or further down — from people.employees.reports_to.
///
///  MANAGER COMES FROM THE DATA, NEVER FROM A ROLE (0018 §3, accepted). A
///  person is a manager of exactly the people whose reports_to says so.
///  core.users.role = 'manager' is not read here, deliberately: it cannot say
///  OF WHOM, and whatever it comes to mean elsewhere, People does not care.
///
///  ╔══════════════════════════════════════════════════════════════════════╗
///  ║ SETTING reports_to GRANTS ACCESS. It is an access change, not an      ║
///  ║ organisational detail, and it is audited as one (Mr. Singh, 9 Oct).   ║
///  ║ Only People HR may write it (EmployeeEndpoints), and the database     ║
///  ║ records every change in people.reporting_changes with the session's   ║
///  ║ user — by trigger, so no writer can skip it.                          ║
///  ╚══════════════════════════════════════════════════════════════════════╝
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class PeopleAccess(AppDbContext db, TenantContext tenant, IHttpContextAccessor http)
{
    private static readonly string[] AdminRoles = ["super_admin", "org_owner", "org_admin"];
    private bool? _hr;

    public Guid? UserId => tenant.UserId;

    /// <summary>Is the signed-in person People HR in this organisation.</summary>
    public async Task<bool> IsHrAsync(CancellationToken ct)
    {
        if (_hr is { } cached) return cached;
        if (http.HttpContext?.User?.Identity?.IsAuthenticated != true || tenant.UserId is not Guid me)
            return (_hr = false).Value;
        return (_hr = await db.Set<PeopleHrMember>().AnyAsync(m => m.UserId == me, ct)).Value;
    }

    /// <summary>
    /// May this person name People HR. Organisation administrators only — and
    /// naming is not being: an administrator who wants to see records names
    /// themselves, and that moment is audited.
    /// </summary>
    public bool CanNameHr()
    {
        var role = http.HttpContext?.User?.FindFirst(ClaimTypes.Role)?.Value;
        return role is not null && AdminRoles.Contains(role);
    }

    /// <summary>The employees this person may see. Always start here.</summary>
    public async Task<IQueryable<Employee>> VisibleAsync(CancellationToken ct)
    {
        if (await IsHrAsync(ct)) return db.Set<Employee>().AsQueryable();
        if (tenant.UserId is not Guid me) return db.Set<Employee>().Where(_ => false);
        // Themselves and everyone below them. UNION, not UNION ALL: even if a
        // loop ever got past the trigger, this stops instead of spinning.
        var t = tenant.TenantId;
        return db.Set<Employee>().FromSqlInterpolated($"""
            WITH RECURSIVE team(id) AS (
                SELECT id FROM people.employees WHERE tenant_id = {t} AND user_id = {me}
                UNION
                SELECT e.id FROM people.employees e JOIN team ON e.reports_to = team.id
                 WHERE e.tenant_id = {t}
            )
            SELECT e.* FROM people.employees e WHERE e.id IN (SELECT id FROM team)
            """);
    }

    /// <summary>The signed-in person's own employee record, if they have one.</summary>
    public Task<Employee?> MeAsync(CancellationToken ct) =>
        tenant.UserId is Guid me
            ? db.Set<Employee>().AsNoTracking().FirstOrDefaultAsync(e => e.UserId == me, ct)
            : Task.FromResult<Employee?>(null);

    /// <summary>For HR writes: the tracked row, any employee in the organisation.</summary>
    public Task<Employee?> ForHrEditAsync(Guid id, CancellationToken ct) =>
        db.Set<Employee>().FirstOrDefaultAsync(e => e.Id == id, ct);

    public Task<bool> ExistsAsync(Guid id, CancellationToken ct) =>
        db.Set<Employee>().AnyAsync(e => e.Id == id, ct);

    public Task<bool> UserLinkedAsync(Guid userId, Guid? except, CancellationToken ct) =>
        db.Set<Employee>().AnyAsync(e => e.UserId == userId && e.Id != except, ct);

    public Task<int> DirectReportsAsync(Guid id, CancellationToken ct) =>
        db.Set<Employee>().CountAsync(e => e.ReportsTo == id && e.Status != "exited", ct);

    /// <summary>The next code from the organisation's scheme, inside the caller's transaction.</summary>
    public Task<string> NextCodeAsync(CancellationToken ct) =>
        db.Database.SqlQuery<string>($"""SELECT people.next_employee_code() AS "Value" """).SingleAsync(ct);

    public Task<string?> SchemeModeAsync(CancellationToken ct) =>
        db.Set<EmployeeIdSettings>().Select(s => s.Mode).FirstOrDefaultAsync(ct);

    public void Add(Employee e) => db.Set<Employee>().Add(e);
    public Task<int> SaveAsync(CancellationToken ct) => db.SaveChangesAsync(ct);

    /// <summary>Reporting history of one employee, newest first. The caller has checked who may read it.</summary>
    public Task<List<ReportingChange>> ReportingHistoryAsync(Guid id, CancellationToken ct) =>
        db.Set<ReportingChange>().AsNoTracking().Where(r => r.EmployeeId == id)
            .OrderByDescending(r => r.ChangedAt).ThenByDescending(r => r.Id).ToListAsync(ct);

    public Task<List<PeopleHrMember>> HrMembersAsync(CancellationToken ct) =>
        db.Set<PeopleHrMember>().AsNoTracking().OrderBy(m => m.CreatedAt).ToListAsync(ct);

    public async Task<bool> AddHrAsync(Guid userId, CancellationToken ct)
    {
        if (await db.Set<PeopleHrMember>().AnyAsync(m => m.UserId == userId, ct)) return false;
        db.Set<PeopleHrMember>().Add(new PeopleHrMember
        {
            TenantId = tenant.TenantId, UserId = userId, AddedBy = tenant.UserId, CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);
        _hr = null;
        return true;
    }

    public async Task<bool> RemoveHrAsync(Guid userId, CancellationToken ct)
    {
        var row = await db.Set<PeopleHrMember>().FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (row is null) return false;
        db.Set<PeopleHrMember>().Remove(row);
        await db.SaveChangesAsync(ct);
        _hr = null;
        return true;
    }

    /// <summary>
    /// Counts for Core's "is this in use" checks and #409's scheme rule. They
    /// return numbers, never a query, so they cannot be extended into a
    /// listing of anyone.
    /// </summary>
    public static class OrganisationWide
    {
        public static Task<int> CountNamingLocationAsync(AppDbContext db, Guid id, CancellationToken ct) =>
            db.Set<Employee>().CountAsync(e => e.LocationId == id, ct);

        public static Task<int> CountNamingDesignationAsync(AppDbContext db, Guid id, CancellationToken ct) =>
            db.Set<Employee>().CountAsync(e => e.DesignationId == id, ct);

        public static Task<int> CountNamingDepartmentAsync(AppDbContext db, Guid id, CancellationToken ct) =>
            db.Set<Employee>().CountAsync(e => e.DepartmentId == id, ct);

        /// <summary>
        /// The highest number already issued under this prefix (codes that are
        /// the prefix followed only by digits), or null. #409's scheme may not
        /// be set to issue that number or a lower one again.
        /// </summary>
        public static Task<long?> HighestIssuedAsync(AppDbContext db, string prefix, CancellationToken ct)
        {
            var start = prefix.Length + 1;
            var like = prefix.ToUpperInvariant() + "%";
            return db.Database.SqlQuery<long?>($"""
                SELECT max(substring(employee_code FROM {start})::bigint) AS "Value"
                  FROM people.employees
                 WHERE upper(employee_code) LIKE {like}
                   AND substring(employee_code FROM {start}) ~ '^[0-9]+$'
                   AND length(substring(employee_code FROM {start})) <= 9
                """).SingleAsync(ct);
        }
    }
}

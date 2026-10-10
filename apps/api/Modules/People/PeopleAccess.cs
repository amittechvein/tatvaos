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

/// <summary>How much of the staff directory colleagues see (people.directory_settings, 0018 §5).</summary>
public sealed class DirectorySettings
{
    public Guid TenantId { get; set; }
    /// <summary>"everyone" (default) or "hr_only".</summary>
    public string VisibleTo { get; set; } = "everyone";
    public bool ShowManager { get; set; } = true;
    public Guid? UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// One person in the staff directory — and ONLY these fields (0018 §5,
/// Amit 9 Oct 2026). Employee code, status, joining and exit dates and
/// employment type are deliberately absent: "on notice" in a staff list tells
/// everyone that someone is leaving before they have said so. Adding a field
/// here is a change to what every colleague sees — tests/people step 13
/// asserts this exact set.
/// </summary>
public sealed record DirectoryEntry(
    Guid Id, string Name, string? Designation, string? Department, string? Location,
    string? WorkEmail, string? Manager);

/// <summary>
/// An employee asks People HR to correct their record
/// (people.correction_requests, 20261009-c). Own record only.
/// </summary>
public sealed class CorrectionRequest
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid EmployeeId { get; set; }
    public string Field { get; set; } = "";
    public string Requested { get; set; } = "";
    public string Status { get; set; } = "open";
    public string? Response { get; set; }
    public Guid RequestedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public Guid? HandledBy { get; set; }
    public DateTimeOffset? HandledAt { get; set; }
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
public sealed class PeopleAccess(
    AppDbContext db, TenantContext tenant, IHttpContextAccessor http,
    IdentifierCrypto crypto, ILogger<PeopleAccess> log)
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
    /// The signed-in person's own record with names in place of ids, for "My
    /// record". Their own record shows every field of it, including the ones
    /// the directory hides from colleagues (code, status, dates, type).
    /// </summary>
    public async Task<object?> MyRecordAsync(CancellationToken ct)
    {
        if (tenant.UserId is not Guid me) return null;
        return await db.Set<Employee>().AsNoTracking().Where(e => e.UserId == me)
            .Select(e => new
            {
                e.Id, e.EmployeeCode, e.FullName, e.WorkEmail, e.EmploymentType, e.Status, e.JoinedOn, e.ExitOn,
                Department = db.Departments.Where(x => x.Id == e.DepartmentId).Select(x => x.Name).FirstOrDefault(),
                Designation = db.OrgDesignations.Where(x => x.Id == e.DesignationId).Select(x => x.Title).FirstOrDefault(),
                Location = db.OrgLocations.Where(x => x.Id == e.LocationId).Select(x => x.Name).FirstOrDefault(),
                Manager = db.Set<Employee>().Where(m => m.Id == e.ReportsTo).Select(m => m.FullName).FirstOrDefault(),
            })
            .FirstOrDefaultAsync(ct);
    }

    // ------------------------------------------------------ correction requests

    /// <summary>The signed-in person's own requests, newest first. Empty if they have no record.</summary>
    public async Task<List<CorrectionRequest>> MyCorrectionsAsync(CancellationToken ct)
    {
        var me = await MeAsync(ct);
        if (me is null) return [];
        return await db.Set<CorrectionRequest>().AsNoTracking().Where(c => c.EmployeeId == me.Id)
            .OrderByDescending(c => c.CreatedAt).ToListAsync(ct);
    }

    /// <summary>
    /// Files a request about the signed-in person's OWN record. The employee
    /// is the session's record, never an id from the request: there is no way
    /// to ask about someone else. Null when they have no record, or have left.
    /// </summary>
    public async Task<CorrectionRequest?> FileCorrectionAsync(string field, string requested, CancellationToken ct)
    {
        var me = await MeAsync(ct);
        if (me is null || me.Status == "exited" || tenant.UserId is not Guid user) return null;
        var row = new CorrectionRequest
        {
            Id = Guid.NewGuid(), TenantId = tenant.TenantId, EmployeeId = me.Id, Field = field,
            Requested = requested, Status = "open", RequestedBy = user, CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Set<CorrectionRequest>().Add(row);
        await db.SaveChangesAsync(ct);
        return row;
    }

    public async Task<int> OpenCorrectionCountForMeAsync(CancellationToken ct)
    {
        var me = await MeAsync(ct);
        return me is null ? 0 : await db.Set<CorrectionRequest>().CountAsync(c => c.EmployeeId == me.Id && c.Status == "open", ct);
    }

    /// <summary>Every request in the organisation, for People HR. The caller has checked IsHrAsync.</summary>
    public async Task<List<(CorrectionRequest Request, string EmployeeName)>> CorrectionsForHrAsync(string? status, CancellationToken ct)
    {
        var q = db.Set<CorrectionRequest>().AsNoTracking().AsQueryable();
        if (!string.IsNullOrEmpty(status)) q = q.Where(c => c.Status == status);
        var rows = await q.OrderBy(c => c.Status == "open" ? 0 : 1).ThenByDescending(c => c.CreatedAt)
            .Take(500)
            .Select(c => new { c, name = db.Set<Employee>().Where(e => e.Id == c.EmployeeId).Select(e => e.FullName).FirstOrDefault() })
            .ToListAsync(ct);
        return rows.Select(r => (r.c, r.name ?? "")).ToList();
    }

    /// <summary>For HR: the tracked request, to answer it.</summary>
    public Task<CorrectionRequest?> CorrectionForHrAsync(Guid id, CancellationToken ct) =>
        db.Set<CorrectionRequest>().FirstOrDefaultAsync(c => c.Id == id, ct);

    // ------------------------------------------------------------ directory

    /// <summary>This organisation's directory settings, or the defaults (not saved by reading).</summary>
    public async Task<DirectorySettings> DirectorySettingsAsync(CancellationToken ct) =>
        await db.Set<DirectorySettings>().AsNoTracking().FirstOrDefaultAsync(ct)
        ?? new DirectorySettings { TenantId = tenant.TenantId };

    /// <summary>
    /// May this person see the directory. 'everyone': anyone signed in to the
    /// organisation. 'hr_only': People HR — and administrators are not HR
    /// until they name themselves, here as everywhere in People.
    /// </summary>
    public async Task<bool> CanSeeDirectoryAsync(CancellationToken ct)
    {
        if (http.HttpContext?.User?.Identity?.IsAuthenticated != true || tenant.UserId is null) return false;
        var s = await DirectorySettingsAsync(ct);
        return s.VisibleTo == "everyone" || await IsHrAsync(ct);
    }

    /// <summary>
    /// The staff directory: everyone still here (not 'exited'), with the
    /// directory's fields only. On notice is included and indistinguishable
    /// from active, by design. The caller has checked CanSeeDirectoryAsync.
    /// </summary>
    public async Task<List<DirectoryEntry>> DirectoryAsync(
        string? q, Guid? departmentId, Guid? locationId, CancellationToken ct)
    {
        var showManager = (await DirectorySettingsAsync(ct)).ShowManager;
        var people = db.Set<Employee>().AsNoTracking().Where(e => e.Status != "exited");
        if (departmentId is Guid d) people = people.Where(e => e.DepartmentId == d);
        if (locationId is Guid l) people = people.Where(e => e.LocationId == l);

        var rows = people.Select(e => new
        {
            e.Id,
            Name = e.FullName,
            Designation = db.OrgDesignations.Where(x => x.Id == e.DesignationId).Select(x => x.Title).FirstOrDefault(),
            Department = db.Departments.Where(x => x.Id == e.DepartmentId).Select(x => x.Name).FirstOrDefault(),
            Location = db.OrgLocations.Where(x => x.Id == e.LocationId).Select(x => x.Name).FirstOrDefault(),
            e.WorkEmail,
            Manager = db.Set<Employee>().Where(m => m.Id == e.ReportsTo).Select(m => m.FullName).FirstOrDefault(),
        });
        if (!string.IsNullOrWhiteSpace(q))
        {
            var k = q.Trim().ToLower();
            rows = rows.Where(r => r.Name.ToLower().Contains(k)
                || (r.Designation != null && r.Designation.ToLower().Contains(k))
                || (r.Department != null && r.Department.ToLower().Contains(k))
                || (r.Location != null && r.Location.ToLower().Contains(k))
                || (showManager && r.Manager != null && r.Manager.ToLower().Contains(k)));
        }
        var list = await rows.OrderBy(r => r.Name).Take(1000).ToListAsync(ct);
        return list.Select(r => new DirectoryEntry(r.Id, r.Name, r.Designation, r.Department, r.Location,
                                                   r.WorkEmail, showManager ? r.Manager : null)).ToList();
    }

    public async Task SaveDirectorySettingsAsync(string visibleTo, bool showManager, CancellationToken ct)
    {
        var row = await db.Set<DirectorySettings>().FirstOrDefaultAsync(ct);
        if (row is null)
        {
            row = new DirectorySettings { TenantId = tenant.TenantId };
            db.Set<DirectorySettings>().Add(row);
        }
        row.VisibleTo = visibleTo;
        row.ShowManager = showManager;
        row.UpdatedBy = tenant.UserId;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    // ============================================ identifiers (decision 0015)

    /// <summary>Both identifier keys are set. False = every save and reveal is refused.</summary>
    public bool IdentifiersConfigured => crypto.IsConfigured;

    /// <summary>Named by the organisation to reveal full values (Amit, 10 Oct 2026).</summary>
    public async Task<bool> IsIdentifierReaderAsync(CancellationToken ct) =>
        tenant.UserId is Guid me && await db.Set<IdentifierReader>().AnyAsync(r => r.UserId == me, ct);

    private async Task<bool> IsOwnRecordAsync(Guid employeeId, CancellationToken ct) =>
        (await MeAsync(ct))?.Id == employeeId;

    /// <summary>
    /// Who sees the MASKED view (kind, last four, verified): People HR, the
    /// named readers, and the employee. Not a manager - a manager's view of a
    /// report never includes identity or bank details.
    /// </summary>
    public async Task<bool> CanSeeIdentifiersAsync(Guid employeeId, CancellationToken ct) =>
        await ExistsAsync(employeeId, ct)
        && (await IsHrAsync(ct) || await IsIdentifierReaderAsync(ct) || await IsOwnRecordAsync(employeeId, ct));

    /// <summary>Who may REVEAL a full value: the named readers, and the employee for their own.</summary>
    public async Task<bool> CanRevealAsync(Guid employeeId, CancellationToken ct) =>
        await ExistsAsync(employeeId, ct)
        && (await IsIdentifierReaderAsync(ct) || await IsOwnRecordAsync(employeeId, ct));

    /// <summary>Who may enter or replace a value: People HR, and the employee for their own (pre-joining).</summary>
    public async Task<bool> CanSetIdentifierAsync(Guid employeeId, CancellationToken ct) =>
        await ExistsAsync(employeeId, ct) && (await IsHrAsync(ct) || await IsOwnRecordAsync(employeeId, ct));

    public Task<List<EmployeeIdentifier>> MaskedIdentifiersAsync(Guid employeeId, CancellationToken ct) =>
        db.Set<EmployeeIdentifier>().AsNoTracking().Where(i => i.EmployeeId == employeeId)
            .OrderBy(i => i.Kind).ToListAsync(ct);

    /// <summary>This organisation's newest data key, created (and wrapped) on first use.</summary>
    private async Task<(short Version, byte[] Key)> DataKeyAsync(CancellationToken ct)
    {
        var row = await db.Set<IdentifierKey>().AsNoTracking().OrderByDescending(k => k.Version).FirstOrDefaultAsync(ct);
        if (row is null)
        {
            var fresh = IdentifierCrypto.NewDataKey();
            db.Set<IdentifierKey>().Add(new IdentifierKey
            {
                TenantId = tenant.TenantId, Version = 1, CreatedAt = DateTimeOffset.UtcNow,
                WrappedKey = crypto.WrapDataKey(tenant.TenantId, 1, fresh),
            });
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException)
            {
                // Two first saves at once: the other made version 1. Use theirs.
                db.ChangeTracker.Clear();
            }
            row = await db.Set<IdentifierKey>().AsNoTracking().OrderByDescending(k => k.Version).FirstAsync(ct);
        }
        var key = crypto.UnwrapDataKey(tenant.TenantId, row.Version, row.WrappedKey)
                  ?? throw new InvalidOperationException("This organisation's identifier data key will not open with the configured master key.");
        return (row.Version, key);
    }

    /// <summary>
    /// Encrypts and stores (or replaces) one identifier. The value is sealed
    /// here, before Entity Framework sees it: no parameter log can hold it.
    /// Replacing clears "verified": HR must see the new original.
    /// </summary>
    public async Task SaveIdentifierAsync(Guid employeeId, string kind, string value, string last4, string? ifsc, CancellationToken ct)
    {
        var (version, key) = await DataKeyAsync(ct);
        var sealedValue = crypto.Encrypt(key, tenant.TenantId, employeeId, kind, value);
        var hash = kind == "aadhaar" ? null : crypto.LookupHash(tenant.TenantId, kind, value);
        var now = DateTimeOffset.UtcNow;
        var row = await db.Set<EmployeeIdentifier>().FirstOrDefaultAsync(i => i.EmployeeId == employeeId && i.Kind == kind, ct);
        if (row is null)
        {
            row = new EmployeeIdentifier { TenantId = tenant.TenantId, EmployeeId = employeeId, Kind = kind, CreatedAt = now, CreatedBy = tenant.UserId };
            db.Set<EmployeeIdentifier>().Add(row);
        }
        row.Ciphertext = sealedValue;
        row.KeyVersion = version;
        row.Last4 = last4;
        row.LookupHash = hash;
        row.Ifsc = kind == "bank_account" ? ifsc : null;
        row.VerifiedAt = null;
        row.VerifiedBy = null;
        row.UpdatedAt = now;
        row.UpdatedBy = tenant.UserId;
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> MarkVerifiedAsync(Guid employeeId, string kind, CancellationToken ct)
    {
        var row = await db.Set<EmployeeIdentifier>().FirstOrDefaultAsync(i => i.EmployeeId == employeeId && i.Kind == kind, ct);
        if (row is null) return false;
        row.VerifiedAt = DateTimeOffset.UtcNow;
        row.VerifiedBy = tenant.UserId;
        await db.SaveChangesAsync(ct);
        return true;
    }

    // ---- Prove it is you before a reveal (Mr. Singh, 10 Oct 2026, ruling 1 on #448) ----
    //
    //  The person proves they are present (authenticator code if they have
    //  one, password if not - AuthEndpoints.RequireActorProofAsync, the same
    //  check and the same lock as sign-in), and that unlocks TEN MINUTES from
    //  the proof - fixed, not sliding - for this person in this sign-in.
    //  Counted only while (a) it has not expired, (b) it is the caller's own
    //  row, and (c) the sign-in it names still has a live refresh token. So
    //  sign-out, "sign out everywhere", a password change or a replay kill
    //  ends it at once, and nothing has to remember to delete the row.

    public static readonly TimeSpan UnlockWindow = TimeSpan.FromMinutes(10);

    /// <summary>
    /// The sign-in this request belongs to: the access token's "sid" claim
    /// (the refresh-token family). Null for a token issued before the claim
    /// existed - those expire within fifteen minutes and simply cannot unlock.
    /// Read under both names in case the bearer handler maps inbound claims.
    /// </summary>
    public Guid? SessionId
    {
        get
        {
            var principal = http.HttpContext?.User;
            var raw = principal?.FindFirst(Shared.Auth.TokenIssuer.SessionClaim)?.Value
                   ?? principal?.FindFirst(ClaimTypes.Sid)?.Value;
            return Guid.TryParse(raw, out var sid) ? sid : null;
        }
    }

    /// <summary>When this person's window in this sign-in closes, or null if it is not open.</summary>
    public async Task<DateTimeOffset?> UnlockedUntilAsync(CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid || SessionId is not Guid sid) return null;
        var now = DateTimeOffset.UtcNow;
        var row = await db.Set<IdentifierUnlock>().AsNoTracking()
            .FirstOrDefaultAsync(u => u.UserId == uid && u.SessionId == sid && u.ExpiresAt > now, ct);
        if (row is null) return null;
        var signedIn = await db.RefreshTokens.AsNoTracking()
            .AnyAsync(t => t.FamilyId == sid && t.UserId == uid && t.RevokedAt == null && t.ExpiresAt > now, ct);
        return signedIn ? row.ExpiresAt : null;
    }

    /// <summary>Opens (or restarts) the window. Call only after the proof has passed.</summary>
    public async Task<DateTimeOffset> UnlockAsync(string proof, CancellationToken ct)
    {
        var uid = tenant.UserId!.Value;
        var sid = SessionId!.Value;
        var now = DateTimeOffset.UtcNow;
        var row = await db.Set<IdentifierUnlock>().FirstOrDefaultAsync(u => u.UserId == uid && u.SessionId == sid, ct);
        if (row is null)
        {
            row = new IdentifierUnlock { TenantId = tenant.TenantId, UserId = uid, SessionId = sid };
            db.Set<IdentifierUnlock>().Add(row);
        }
        row.Proof = proof;
        row.UnlockedAt = now;
        row.ExpiresAt = now.Add(UnlockWindow);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // Two tabs proved at once and the other inserted first: theirs stands.
            db.ChangeTracker.Clear();
            return await UnlockedUntilAsync(ct) ?? throw new InvalidOperationException("Unlock row vanished after a concurrent insert.");
        }
        return row.ExpiresAt;
    }

    /// <summary>
    /// Decrypts one value for display and writes ONE read row, shown or
    /// failed, in the same save - there is no path to the value without the
    /// row. A value that will not open (a moved ciphertext, a wrong key) is
    /// logged at Error and audited as failed; it is never shown as empty.
    /// Null = nothing stored, or it failed (the caller can tell from Outcome).
    /// </summary>
    public async Task<(string? Value, string Outcome)> RevealAsync(
        Guid employeeId, string kind, string reason, string? note, CancellationToken ct)
    {
        var row = await db.Set<EmployeeIdentifier>().AsNoTracking().FirstOrDefaultAsync(i => i.EmployeeId == employeeId && i.Kind == kind, ct);
        if (row is null) return (null, "absent");
        var keyRow = await db.Set<IdentifierKey>().AsNoTracking().FirstOrDefaultAsync(k => k.Version == row.KeyVersion, ct);
        var key = keyRow is null ? null : crypto.UnwrapDataKey(tenant.TenantId, keyRow.Version, keyRow.WrappedKey);
        var value = key is null ? null : crypto.Decrypt(key, tenant.TenantId, employeeId, kind, row.Ciphertext);
        var outcome = value is null ? "failed" : "shown";
        if (value is null)
            log.LogError("Identifier would not decrypt: tenant {Tenant}, employee {Employee}, kind {Kind}, key version {Version}. "
                + "A moved ciphertext or a wrong master key. Audited as failed; nothing shown.",
                tenant.TenantId, employeeId, kind, row.KeyVersion);
        db.Set<IdentifierRead>().Add(new IdentifierRead
        {
            TenantId = tenant.TenantId, EmployeeId = employeeId, Kind = kind, ReaderId = tenant.UserId!.Value,
            Reason = reason, Note = note, Outcome = outcome, ReadAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);
        return (value, outcome);
    }

    public Task<List<IdentifierRead>> IdentifierReadsAsync(Guid employeeId, CancellationToken ct) =>
        db.Set<IdentifierRead>().AsNoTracking().Where(r => r.EmployeeId == employeeId)
            .OrderByDescending(r => r.ReadAt).Take(500).ToListAsync(ct);

    public Task<List<IdentifierReader>> IdentifierReadersAsync(CancellationToken ct) =>
        db.Set<IdentifierReader>().AsNoTracking().OrderBy(r => r.CreatedAt).ToListAsync(ct);

    public async Task<bool> AddIdentifierReaderAsync(Guid userId, CancellationToken ct)
    {
        if (await db.Set<IdentifierReader>().AnyAsync(r => r.UserId == userId, ct)) return false;
        db.Set<IdentifierReader>().Add(new IdentifierReader { TenantId = tenant.TenantId, UserId = userId, AddedBy = tenant.UserId, CreatedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> RemoveIdentifierReaderAsync(Guid userId, CancellationToken ct)
    {
        var row = await db.Set<IdentifierReader>().FirstOrDefaultAsync(r => r.UserId == userId, ct);
        if (row is null) return false;
        db.Set<IdentifierReader>().Remove(row);
        await db.SaveChangesAsync(ct);
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

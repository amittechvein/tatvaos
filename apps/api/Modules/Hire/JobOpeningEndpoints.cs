using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Hire;

/// <summary>
/// Job openings — TatvaOS Hire R1 (24 September 2026).
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHO — HireAccess decides (Amit, 24 Sept 2026). Administrators and
///  recruiters see every job; a hiring manager sees only the jobs that name
///  them, and anything else answers 404. EVERY job lookup here starts from
///  access.Jobs(level), never from db.JobOpenings — see HireAccess.
///
///  STATUS IS ITS OWN CALL. Editing a job and publishing it are different
///  acts with different consequences — one changes words, the other puts
///  the job in front of the public once the careers page exists. So the
///  status moves only through POST /{id}/status, which checks the job is
///  fit to be seen, and never as a side effect of a save.
///
///      draft ──open──▶ open ◀──▶ on_hold
///                       │            │
///                       └──close──▶ closed (filled | cancelled) ──reopen──▶ open
///
///  A job that has EVER been open cannot be deleted, only closed:
///  applications (the next change) must never lose the job they were made
///  to. published_at records that it was open.
///
///  AN OPEN JOB STAYS FIT TO BE SEEN. Saving an open or on-hold job applies
///  the same checks as publishing — otherwise "publish, then blank the
///  description" gets around them in two clicks.
///
///  REFERENCES ARE CHECKED HERE AND PINNED IN THE DATABASE. The lookups below
///  go through the tenant query filter, so another organisation's id reads as
///  "does not exist"; the composite foreign keys in the migration refuse it
///  even if a future caller skips these checks.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class JobOpeningEndpoints
{
    private const string Product = "hire";

    private static readonly string[] EmploymentTypes =
        ["full_time", "part_time", "contract", "internship", "temporary"];
    private static readonly string[] Statuses = ["draft", "open", "on_hold", "closed"];

    public static void MapJobOpeningEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/hire/jobs")
            .RequireAuthorization("User")
            .WithTags("Hire");

        g.MapGet("/", ListAsync);
        g.MapGet("/options", OptionsAsync);
        g.MapGet("/{id:guid}", GetAsync);
        g.MapPost("/", CreateAsync);
        g.MapPut("/{id:guid}", UpdateAsync);
        g.MapPost("/{id:guid}/status", ChangeStatusAsync);
        g.MapDelete("/{id:guid}", DeleteAsync);
    }

    // ------------------------------------------------------------------ list
    private static async Task<IResult> ListAsync(
        string? status, string? q, HireAccess access, AppDbContext db, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();

        var counts = await access.Jobs(level).AsNoTracking()
            .GroupBy(j => j.Status)
            .Select(g => new { Status = g.Key, N = g.Count() })
            .ToDictionaryAsync(x => x.Status, x => x.N, ct);

        var query = access.Jobs(level).AsNoTracking();
        if (!string.IsNullOrWhiteSpace(status) && status != "all")
        {
            if (!Statuses.Contains(status))
                return Results.BadRequest(new { error = $"Unknown status '{status}'." });
            query = query.Where(j => j.Status == status);
        }
        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = $"%{q.Trim()}%";
            query = query.Where(j => EF.Functions.ILike(j.Title, term));
        }

        var jobs = await query
            .OrderByDescending(j => j.UpdatedAt)
            .Take(500)
            .ToListAsync(ct);

        var names = await NamesAsync(db, jobs, ct);

        return Results.Ok(new
        {
            counts = Statuses.ToDictionary(s => s, s => counts.GetValueOrDefault(s)),
            jobs = jobs.Select(j => new
            {
                j.Id, j.Title, j.Status, j.ClosedReason, j.EmploymentType, j.Vacancies,
                location = Name(names.Locations, j.LocationId),
                department = Name(names.Departments, j.DepartmentId),
                designation = Name(names.Designations, j.DesignationId),
                hiringManager = Name(names.People, j.HiringManagerId),
                j.OpeningDate, j.ClosingDate, j.PublishedAt, j.UpdatedAt,
            }),
        });
    }

    // --------------------------------------------------------------- options
    /// <summary>
    /// Everything the job form offers, in one call, so Hire's screens never
    /// need the admin console's own endpoints. Archived locations and
    /// designations are INCLUDED with isActive=false: the form offers them
    /// only when a job already names one, so editing an older job does not
    /// silently drop its location.
    /// </summary>
    private static async Task<IResult> OptionsAsync(HireAccess access, AppDbContext db, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) == HireLevel.None) return HireAccess.NoAccess();

        var departments = await db.Departments.AsNoTracking()
            .OrderBy(d => d.Name).Select(d => new { d.Id, d.Name }).ToListAsync(ct);
        var designations = await db.OrgDesignations.AsNoTracking()
            .OrderBy(d => d.Title).Select(d => new { d.Id, d.Title, d.IsActive }).ToListAsync(ct);
        var locations = await db.OrgLocations.AsNoTracking()
            .OrderBy(l => l.Name).Select(l => new { l.Id, l.Name, l.IsRemote, l.IsActive }).ToListAsync(ct);
        var people = await db.Users.AsNoTracking()
            .Where(u => u.Status == "active")
            .OrderBy(u => u.DisplayName)
            .Select(u => new { u.Id, u.DisplayName, u.Email })
            .ToListAsync(ct);

        return Results.Ok(new
        {
            departments, designations, locations, people,
            employmentTypes = EmploymentTypes,
        });
    }

    // ------------------------------------------------------------------- get
    private static async Task<IResult> GetAsync(Guid id, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var job = await access.Jobs(level).AsNoTracking().FirstOrDefaultAsync(j => j.Id == id, ct);
        return job is null ? Results.NotFound() : Results.Ok(Shape(job));
    }

    // ---------------------------------------------------------------- create
    private static async Task<IResult> CreateAsync(
        SaveJobRequest req, HireAccess access, AppDbContext db, TenantContext tenant, AuditWriter audit,
        CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();

        // A hiring manager's own job names them, or they could not open it
        // again after saving. Left empty, it is filled in; naming someone
        // else is refused rather than silently overwritten.
        if (level == HireLevel.HiringManager)
        {
            if (req.HiringManagerId is Guid hm && hm != access.UserId)
                return Results.BadRequest(new { error = "As a hiring manager you can only create jobs you manage yourself." });
            req = req with { HiringManagerId = access.UserId };
        }

        var job = new JobOpening
        {
            Id = Guid.NewGuid(),
            TenantId = tenant.TenantId,
            CreatedBy = tenant.UserId,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        var error = await ApplyAsync(job, req, db, isNew: true, ct);
        if (error is not null) return Results.BadRequest(new { error });

        job.Slug = await NewSlugAsync(db, job.Title, ct);

        db.JobOpenings.Add(job);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("job.created", "job_opening", job.Id.ToString(),
            after: new { job.Title, job.Status }, ct: ct, productCode: Product);

        return Results.Created($"/api/hire/jobs/{job.Id}", Shape(job));
    }

    // ---------------------------------------------------------------- update
    private static async Task<IResult> UpdateAsync(
        Guid id, SaveJobRequest req, HireAccess access, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var job = await access.Jobs(level).FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();

        // Handing the job to someone else would lock its hiring manager out
        // of it mid-edit; that is a recruiter's or an administrator's call.
        if (level == HireLevel.HiringManager && req.HiringManagerId != access.UserId)
            return Results.BadRequest(new { error = "Only a recruiter or an administrator can change a job's hiring manager." });

        var before = new { job.Title, job.LocationId, job.Vacancies, job.ClosingDate };

        var error = await ApplyAsync(job, req, db, isNew: false, ct);
        if (error is not null) return Results.BadRequest(new { error });

        if (job.Status is "open" or "on_hold" && PublishProblem(job) is { } problem)
            return Results.BadRequest(new { error = $"This job is {Words(job.Status)}, so it must stay complete: {problem}" });

        job.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("job.updated", "job_opening", id.ToString(),
            before, new { job.Title, job.LocationId, job.Vacancies, job.ClosingDate }, ct, Product);

        return Results.Ok(Shape(job));
    }

    // ---------------------------------------------------------------- status
    private static async Task<IResult> ChangeStatusAsync(
        Guid id, ChangeJobStatusRequest req, HireAccess access, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var job = await access.Jobs(level).FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();

        var to = req.Status?.Trim() ?? "";
        var from = job.Status;
        if (!Statuses.Contains(to)) return Results.BadRequest(new { error = $"Unknown status '{to}'." });
        if (to == from) return Results.Ok(Shape(job));

        var allowed = (from, to) switch
        {
            ("draft", "open") => true,
            ("open", "on_hold") => true,
            ("on_hold", "open") => true,
            ("open", "closed") or ("on_hold", "closed") => true,
            ("closed", "open") => true,
            _ => false,
        };
        if (!allowed)
            return Results.Conflict(new
            {
                error = from == "draft" && to != "open"
                    ? "A draft can only be published. To get rid of it, delete it."
                    : $"A job that is {Words(from)} cannot be moved to {Words(to)}.",
            });

        var now = DateTimeOffset.UtcNow;
        if (to == "open")
        {
            if (PublishProblem(job) is { } problem)
                return Results.BadRequest(new { error = $"Not ready to publish: {problem}" });
            job.PublishedAt ??= now;
            job.ClosedReason = null;
            job.ClosedAt = null;
            job.OpeningDate ??= Today();
        }
        else if (to == "closed")
        {
            var reason = req.Reason?.Trim();
            if (reason is not ("filled" or "cancelled"))
                return Results.BadRequest(new { error = "Say why it is closing: filled or cancelled." });
            job.ClosedReason = reason;
            job.ClosedAt = now;
        }

        job.Status = to;
        job.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync($"job.{(to == "open" && from == "draft" ? "published" : to == "open" ? "reopened" : to)}",
            "job_opening", id.ToString(),
            before: new { status = from }, after: new { status = to, reason = job.ClosedReason },
            ct: ct, productCode: Product);

        return Results.Ok(Shape(job));
    }

    // ---------------------------------------------------------------- delete
    private static async Task<IResult> DeleteAsync(
        Guid id, HireAccess access, AppDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var job = await access.Jobs(level).FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();

        if (job.PublishedAt is not null)
            return Results.Conflict(new
            {
                error = "This job has been published, so it is kept. Close it instead — "
                      + "anyone who applied must still be able to see what they applied for.",
            });

        db.JobOpenings.Remove(job);
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("job.deleted", "job_opening", id.ToString(),
            before: new { job.Title }, ct: ct, productCode: Product);

        return Results.Ok(new { deleted = true });
    }

    // ============================================================== helpers

    /// <summary>
    /// Copies an edit onto the job after checking it. A full replacement:
    /// every field is sent every time, so an optional field can be cleared.
    /// Returns a sentence for the person, or null when it is all acceptable.
    /// </summary>
    private static async Task<string?> ApplyAsync(
        JobOpening job, SaveJobRequest req, AppDbContext db, bool isNew, CancellationToken ct)
    {
        var title = Clean(req.Title);
        if (title is null || title.Length > 150) return "A job title is required (up to 150 characters).";

        var type = req.EmploymentType?.Trim() ?? "full_time";
        if (!EmploymentTypes.Contains(type)) return "Choose an employment type.";

        if (req.ExperienceMinYears is < 0 or > 60 || req.ExperienceMaxYears is < 0 or > 60)
            return "Experience must be between 0 and 60 years.";
        if (req.ExperienceMinYears is { } emin && req.ExperienceMaxYears is { } emax && emax < emin)
            return "The most experience cannot be less than the least.";

        if (req.SalaryMin is < 0 || req.SalaryMax is < 0) return "Salary cannot be negative.";
        if (req.SalaryMin is > 999_999_999_999m || req.SalaryMax is > 999_999_999_999m) return "That salary is too large.";
        if (req.SalaryMin is { } smin && req.SalaryMax is { } smax && smax < smin)
            return "The top of the salary range cannot be below the bottom.";
        var currency = (Clean(req.SalaryCurrency) ?? "INR").ToUpperInvariant();
        if (!Regex.IsMatch(currency, "^[A-Z]{3}$")) return "Currency must be a three-letter code, such as INR.";
        var period = req.SalaryPeriod?.Trim() ?? "year";
        if (period is not ("year" or "month")) return "Salary period must be per year or per month.";
        if (req.ShowSalary == true && req.SalaryMin is null && req.SalaryMax is null)
            return "There is no salary to show. Enter a range or switch off showing it.";

        var vacancies = req.Vacancies ?? 1;
        if (vacancies is < 1 or > 10000) return "Vacancies must be between 1 and 10,000.";

        if (req.OpeningDate is { } od && req.ClosingDate is { } cd && cd < od)
            return "The closing date cannot be before the opening date.";

        string? qualification = Clean(req.Qualification);
        if (qualification?.Length > 300) return "Qualification can be at most 300 characters.";
        foreach (var (label, text) in new[] { ("Description", req.Description),
                                              ("Responsibilities", req.Responsibilities),
                                              ("Requirements", req.Requirements) })
            if (text?.Length > 20000) return $"{label} can be at most 20,000 characters.";

        var skills = (req.Skills ?? [])
            .Select(s => s?.Trim() ?? "")
            .Where(s => s.Length > 0)
            .DistinctBy(s => s.ToLowerInvariant())
            .ToArray();
        if (skills.Length > 50) return "At most 50 skills.";
        if (skills.Any(s => s.Length > 50)) return "Each skill can be at most 50 characters.";

        // References. Looked up through the tenant filter, so another
        // organisation's id is simply "not found". An archived location or
        // designation may be KEPT on a job that already names it, but not
        // newly chosen.
        if (req.LocationId is Guid loc)
        {
            var l = await db.OrgLocations.AsNoTracking().FirstOrDefaultAsync(x => x.Id == loc, ct);
            if (l is null) return "That location does not exist.";
            if (!l.IsActive && (isNew || job.LocationId != loc)) return $"{l.Name} is archived. Choose a location in use.";
        }
        if (req.DesignationId is Guid des)
        {
            var d = await db.OrgDesignations.AsNoTracking().FirstOrDefaultAsync(x => x.Id == des, ct);
            if (d is null) return "That designation does not exist.";
            if (!d.IsActive && (isNew || job.DesignationId != des)) return $"{d.Title} is archived. Choose a designation in use.";
        }
        if (req.DepartmentId is Guid dep && !await db.Departments.AnyAsync(x => x.Id == dep, ct))
            return "That department does not exist.";
        foreach (var (label, pid, current) in new[] { ("hiring manager", req.HiringManagerId, job.HiringManagerId),
                                                      ("recruiter", req.RecruiterId, job.RecruiterId) })
        {
            if (pid is not Guid p) continue;
            var person = await db.Users.AsNoTracking()
                .Where(u => u.Id == p).Select(u => new { u.Status }).FirstOrDefaultAsync(ct);
            if (person is null) return $"That {label} is not in this organisation.";
            if (person.Status != "active" && (isNew || current != p)) return $"That {label} is not an active person.";
        }

        job.Title = title;
        job.EmploymentType = type;
        job.DepartmentId = req.DepartmentId;
        job.DesignationId = req.DesignationId;
        job.LocationId = req.LocationId;
        job.ExperienceMinYears = (short?)req.ExperienceMinYears;
        job.ExperienceMaxYears = (short?)req.ExperienceMaxYears;
        job.Qualification = qualification;
        job.Skills = skills;
        job.SalaryMin = req.SalaryMin;
        job.SalaryMax = req.SalaryMax;
        job.SalaryCurrency = currency;
        job.SalaryPeriod = period;
        job.ShowSalary = req.ShowSalary ?? false;
        job.Vacancies = vacancies;
        job.Description = Clean(req.Description);
        job.Responsibilities = Clean(req.Responsibilities);
        job.Requirements = Clean(req.Requirements);
        job.HiringManagerId = req.HiringManagerId;
        job.RecruiterId = req.RecruiterId;
        job.OpeningDate = req.OpeningDate;
        job.ClosingDate = req.ClosingDate;
        return null;
    }

    /// <summary>
    /// What stops a job being shown to the public, in words, or null. The
    /// bar is "a candidate could decide whether to apply": what it is, where
    /// it is, and that it is not already past its closing date.
    /// </summary>
    private static string? PublishProblem(JobOpening job)
    {
        if (string.IsNullOrWhiteSpace(job.Description)) return "add a description.";
        if (job.LocationId is null) return "choose a location.";
        if (job.ClosingDate is { } cd && cd < Today()) return "the closing date has passed.";
        return null;
    }

    /// <summary>
    /// Today in India. The server runs in UTC, and between midnight and 05:30
    /// IST a UTC "today" is still yesterday — a job closing today would read
    /// as already closed for the first five and a half hours of the day.
    /// </summary>
    private static DateOnly Today() =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Ist).DateTime);

    private static readonly TimeZoneInfo Ist = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");

    /// <summary>
    /// "senior-backend-engineer-k3x9q". The title's latin letters and digits,
    /// then five random characters — so two "Teacher" openings do not collide
    /// and the address cannot be guessed from the title alone. A title with no
    /// latin letters (हिंदी शिक्षक) becomes "job-k3x9q", which still works.
    /// </summary>
    private static async Task<string> NewSlugAsync(AppDbContext db, string title, CancellationToken ct)
    {
        var stem = Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        if (stem.Length > 100) stem = stem[..100].TrimEnd('-');
        if (stem.Length == 0) stem = "job";

        const string alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var sb = new StringBuilder(stem).Append('-');
            for (var i = 0; i < 5; i++) sb.Append(alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)]);
            var slug = sb.ToString();
            if (!await db.JobOpenings.AnyAsync(j => j.Slug == slug, ct)) return slug;
        }
        // 32^5 is 33 million per title; five collisions in a row means
        // something other than chance, and it should be loud.
        throw new InvalidOperationException("Could not find a free job address after five attempts.");
    }

    private sealed record NameMaps(
        Dictionary<Guid, string> Locations, Dictionary<Guid, string> Departments,
        Dictionary<Guid, string> Designations, Dictionary<Guid, string> People);

    private static async Task<NameMaps> NamesAsync(AppDbContext db, List<JobOpening> jobs, CancellationToken ct)
    {
        var locIds = jobs.Where(j => j.LocationId != null).Select(j => j.LocationId!.Value).Distinct().ToList();
        var depIds = jobs.Where(j => j.DepartmentId != null).Select(j => j.DepartmentId!.Value).Distinct().ToList();
        var desIds = jobs.Where(j => j.DesignationId != null).Select(j => j.DesignationId!.Value).Distinct().ToList();
        var pplIds = jobs.Where(j => j.HiringManagerId != null).Select(j => j.HiringManagerId!.Value).Distinct().ToList();

        return new NameMaps(
            await db.OrgLocations.AsNoTracking().Where(x => locIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Name, ct),
            await db.Departments.AsNoTracking().Where(x => depIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Name, ct),
            await db.OrgDesignations.AsNoTracking().Where(x => desIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Title, ct),
            await db.Users.AsNoTracking().Where(x => pplIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.DisplayName, ct));
    }

    private static string? Name(Dictionary<Guid, string> map, Guid? id) =>
        id is Guid g && map.TryGetValue(g, out var n) ? n : null;

    private static object Shape(JobOpening j) => new
    {
        j.Id, j.Title, j.Slug, j.Status, j.ClosedReason,
        j.DepartmentId, j.DesignationId, j.LocationId,
        j.EmploymentType, j.ExperienceMinYears, j.ExperienceMaxYears,
        j.Qualification, j.Skills,
        j.SalaryMin, j.SalaryMax, j.SalaryCurrency, j.SalaryPeriod, j.ShowSalary,
        j.Vacancies, j.Description, j.Responsibilities, j.Requirements,
        j.HiringManagerId, j.RecruiterId, j.OpeningDate, j.ClosingDate,
        j.PublishedAt, j.ClosedAt, j.CreatedAt, j.UpdatedAt,
        canDelete = j.PublishedAt is null,
    };

    private static string Words(string status) => status switch
    {
        "on_hold" => "on hold",
        "draft" => "a draft",
        _ => status,
    };

    private static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

/// <summary>Full replacement on update — every field every time.</summary>
public sealed record SaveJobRequest(
    string? Title,
    Guid? DepartmentId,
    Guid? DesignationId,
    Guid? LocationId,
    string? EmploymentType,
    int? ExperienceMinYears,
    int? ExperienceMaxYears,
    string? Qualification,
    string[]? Skills,
    decimal? SalaryMin,
    decimal? SalaryMax,
    string? SalaryCurrency,
    string? SalaryPeriod,
    bool? ShowSalary,
    int? Vacancies,
    string? Description,
    string? Responsibilities,
    string? Requirements,
    Guid? HiringManagerId,
    Guid? RecruiterId,
    DateOnly? OpeningDate,
    DateOnly? ClosingDate);

/// <summary>status: open | on_hold | closed. reason (closing only): filled | cancelled.</summary>
public sealed record ChangeJobStatusRequest(string? Status, string? Reason);

using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Hire;

/// <summary>
/// Candidates, applications and the pipeline — TatvaOS Hire R1 (24 Sept 2026).
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHO (defaults, flagged to Amit as his to change):
///    Admin, Recruiter   every candidate; add, edit, apply to jobs, move,
///                       reject. Only an ADMIN may erase a candidate.
///    Hiring manager     only candidates with an application to a job that
///                       names them, and only those applications. May move,
///                       reject, withdraw and reopen them; may NOT add or edit
///                       candidates — the talent pool is the recruiter's.
///  Everything a person cannot see answers 404, as for job openings.
///
///  PERSONAL DATA STAYS OUT OF core.audit_logs. Audit rows name the candidate
///  by id only; names, emails, phones and rejection reasons live in the Hire
///  tables and die with an erasure. An audit log that kept them would make
///  "erase me" impossible to honour.
///
///  A REJECTION NEEDS A REASON, three characters or more, and the database
///  refuses a rejected application without one. It is the first decision
///  about a person this product records, and the Hire & People welcome is
///  explicit that such decisions must be explainable.
///
///  THE PIPELINE MOVES ONLY WHILE THE JOB IS OPEN OR ON HOLD. A closed job's
///  pipeline is the record of how it was filled; a draft has no applicants.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class CandidateEndpoints
{
    private const string Product = "hire";
    private static readonly string[] Sources =
        ["referral", "linkedin", "job_board", "agency", "walk_in", "other"];

    public static void MapCandidateEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/hire/pipeline", PipelineAsync).RequireAuthorization("User").WithTags("Hire");

        var c = app.MapGroup("/api/hire/candidates").RequireAuthorization("User").WithTags("Hire");
        c.MapGet("/", ListAsync);
        c.MapPost("/", CreateAsync);
        c.MapGet("/{id:guid}", GetAsync);
        c.MapPut("/{id:guid}", UpdateAsync);
        c.MapDelete("/{id:guid}", EraseAsync);

        var a = app.MapGroup("/api/hire/applications").RequireAuthorization("User").WithTags("Hire");
        a.MapPost("/", ApplyAsync);
        a.MapGet("/{id:guid}/history", HistoryAsync);
        a.MapPost("/{id:guid}/move", MoveAsync);
        a.MapPost("/{id:guid}/reject", RejectAsync);
        a.MapPost("/{id:guid}/withdraw", WithdrawAsync);
        a.MapPost("/{id:guid}/reopen", ReopenAsync);

        app.MapGet("/api/hire/jobs/{jobId:guid}/applications", JobPipelineAsync)
            .RequireAuthorization("User").WithTags("Hire");
    }

    // ============================================================ pipeline

    private static async Task<IResult> PipelineAsync(HireAccess access, CancellationToken ct)
    {
        if (await access.LevelAsync(ct) == HireLevel.None) return HireAccess.NoAccess();
        var stages = await access.PipelineAsync(ct);
        return Results.Ok(stages.Where(s => s.IsActive)
            .Select(s => new { s.Id, s.Key, s.Name, s.Position, s.IsFinal }));
    }

    // ========================================================== candidates

    private static async Task<IResult> ListAsync(string? q, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();

        var query = access.Candidates(level).AsNoTracking();
        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = $"%{q.Trim()}%";
            query = query.Where(c => EF.Functions.ILike(c.FullName, term)
                                  || (c.Email != null && EF.Functions.ILike(c.Email, term))
                                  || (c.Phone != null && EF.Functions.ILike(c.Phone, term))
                                  || (c.CurrentCompany != null && EF.Functions.ILike(c.CurrentCompany, term)));
        }

        // Counted through Applications(level): a hiring manager sees how many
        // of THEIR applications a person has, not how many roles elsewhere in
        // the organisation that person is being considered for.
        var apps = access.Applications(level);
        var rows = await query
            .OrderByDescending(c => c.UpdatedAt)
            .Take(500)
            .Select(c => new
            {
                c.Id, c.FullName, c.Email, c.Phone, c.CurrentCompany, c.CurrentDesignation,
                c.Source, c.Tags, c.UpdatedAt,
                applications = apps.Count(a => a.CandidateId == c.Id),
                active = apps.Count(a => a.CandidateId == c.Id && a.Outcome == "active"),
            })
            .ToListAsync(ct);
        return Results.Ok(rows);
    }

    private static async Task<IResult> GetAsync(Guid id, HireAccess access, AppDbContext db, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();

        var c = await access.Candidates(level).AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();

        var stages = (await access.PipelineAsync(ct)).ToDictionary(s => s.Id, s => s.Name);
        var jobs = access.Jobs(level);
        var applications = await access.Applications(level).AsNoTracking()
            .Where(a => a.CandidateId == id)
            .OrderByDescending(a => a.AppliedAt)
            .Select(a => new
            {
                a.Id, a.JobId, a.StageId, a.Outcome, a.RejectionReason, a.AppliedAt, a.StageChangedAt,
                jobTitle = jobs.Where(j => j.Id == a.JobId).Select(j => j.Title).FirstOrDefault(),
                jobStatus = jobs.Where(j => j.Id == a.JobId).Select(j => j.Status).FirstOrDefault(),
            })
            .ToListAsync(ct);

        return Results.Ok(new
        {
            candidate = Shape(c),
            applications = applications.Select(a => new
            {
                a.Id, a.JobId, jobTitle = a.jobTitle, jobStatus = a.jobStatus, a.StageId,
                stage = stages.GetValueOrDefault(a.StageId),
                a.Outcome, a.RejectionReason, a.AppliedAt, a.StageChangedAt,
            }),
            canEdit = level >= HireLevel.Recruiter,
            canErase = level == HireLevel.Admin,
        });
    }

    private static async Task<IResult> CreateAsync(
        SaveCandidateRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        if (level < HireLevel.Recruiter)
            return Results.Json(new { error = "Only a recruiter or an administrator can add candidates." }, statusCode: 403);

        var c = new HireCandidate
        {
            Id = Guid.NewGuid(), TenantId = tenant.TenantId, CreatedBy = tenant.UserId,
            CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        };
        var error = Apply(c, req);
        if (error is not null) return Results.BadRequest(new { error });

        if (c.Email is not null)
        {
            var (taken, existing) = await access.CandidateEmailTakenAsync(level, c.Email, null, ct);
            if (taken)
                return Results.Conflict(new
                {
                    error = "A candidate with this email already exists. Add this application to them instead of creating a second profile.",
                    existingId = existing,
                });
        }

        access.AddCandidate(c);
        await access.SaveAsync(ct);
        await audit.WriteAsync("candidate.created", "candidate", c.Id.ToString(),
            after: new { c.Source }, ct: ct, productCode: Product);
        return Results.Created($"/api/hire/candidates/{c.Id}", Shape(c));
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, SaveCandidateRequest req, HireAccess access, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var c = await access.Candidates(level).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();
        if (level < HireLevel.Recruiter)
            return Results.Json(new { error = "Only a recruiter or an administrator can edit a candidate." }, statusCode: 403);

        var error = Apply(c, req);
        if (error is not null) return Results.BadRequest(new { error });
        if (c.Email is not null)
        {
            var (taken, _) = await access.CandidateEmailTakenAsync(level, c.Email, id, ct);
            if (taken) return Results.Conflict(new { error = "Another candidate already has this email." });
        }

        c.UpdatedAt = DateTimeOffset.UtcNow;
        await access.SaveAsync(ct);
        // Which fields changed, never their values: see the class comment.
        await audit.WriteAsync("candidate.updated", "candidate", id.ToString(), ct: ct, productCode: Product);
        return Results.Ok(Shape(c));
    }

    /// <summary>
    /// Erasure — the DPDP "delete my data" request, or a mistaken entry.
    /// Administrators only. Removes the candidate, every application and every
    /// history row (database cascade). The audit row keeps that it happened,
    /// by whom, and how many applications went with it — nothing that
    /// identifies the person.
    /// </summary>
    private static async Task<IResult> EraseAsync(
        Guid id, HireAccess access, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var c = await access.Candidates(level).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (c is null) return Results.NotFound();
        if (level != HireLevel.Admin)
            return Results.Json(new { error = "Only an administrator can erase a candidate." }, statusCode: 403);

        var applications = await access.Applications(level).CountAsync(a => a.CandidateId == id, ct);
        access.RemoveCandidate(c);
        await access.SaveAsync(ct);
        await audit.WriteAsync("candidate.erased", "candidate", id.ToString(),
            before: new { applications }, ct: ct, productCode: Product);
        return Results.Ok(new { erased = true, applications });
    }

    // ======================================================== applications

    private static async Task<IResult> ApplyAsync(
        ApplyRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        if (level < HireLevel.Recruiter)
            return Results.Json(new { error = "Only a recruiter or an administrator can add a candidate to a job." }, statusCode: 403);

        if (req.CandidateId is not Guid cid || req.JobId is not Guid jid)
            return Results.BadRequest(new { error = "Choose a candidate and a job." });
        if (!await access.Candidates(level).AnyAsync(c => c.Id == cid, ct))
            return Results.NotFound(new { error = "That candidate does not exist." });
        var job = await access.Jobs(level).AsNoTracking()
            .Where(j => j.Id == jid).Select(j => new { j.Status, j.Title }).FirstOrDefaultAsync(ct);
        if (job is null) return Results.NotFound(new { error = "That job opening does not exist." });
        if (job.Status is not ("open" or "on_hold"))
            return Results.Conflict(new
            {
                error = job.Status == "draft"
                    ? "This job is still a draft. Publish it before adding candidates."
                    : "This job is closed. Reopen it to add candidates.",
            });
        if (await access.Applications(level).AnyAsync(a => a.CandidateId == cid && a.JobId == jid, ct))
            return Results.Conflict(new { error = "This candidate has already applied to this job." });

        var first = (await access.PipelineAsync(ct)).Where(s => s.IsActive).OrderBy(s => s.Position).First();
        var now = DateTimeOffset.UtcNow;
        var app = new HireApplication
        {
            Id = Guid.NewGuid(), TenantId = tenant.TenantId, CandidateId = cid, JobId = jid,
            StageId = first.Id, Outcome = "active", AppliedAt = now, StageChangedAt = now,
            CreatedBy = tenant.UserId, CreatedAt = now, UpdatedAt = now,
        };
        access.AddApplication(app);
        access.AddEvent(Event(tenant, app.Id, "created", null, first.Id, null, now));
        await access.SaveAsync(ct);
        await audit.WriteAsync("application.created", "application", app.Id.ToString(),
            after: new { candidateId = cid, jobId = jid }, ct: ct, productCode: Product);
        return Results.Created($"/api/hire/applications/{app.Id}", new { app.Id, app.StageId, stage = first.Name });
    }

    /// <summary>
    /// A job's pipeline: its stages in order and every application to it, for
    /// the board. The job must be one this person can see.
    /// </summary>
    private static async Task<IResult> JobPipelineAsync(Guid jobId, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        var job = await access.Jobs(level).AsNoTracking()
            .Where(j => j.Id == jobId).Select(j => new { j.Id, j.Title, j.Status }).FirstOrDefaultAsync(ct);
        if (job is null) return Results.NotFound();

        var stages = await access.PipelineAsync(ct);
        var candidates = access.Candidates(level);
        var applications = await access.Applications(level).AsNoTracking()
            .Where(a => a.JobId == jobId)
            .OrderBy(a => a.StageChangedAt)
            .Select(a => new
            {
                a.Id, a.CandidateId, a.StageId, a.Outcome, a.RejectionReason, a.AppliedAt, a.StageChangedAt,
                candidate = candidates.Where(c => c.Id == a.CandidateId)
                    .Select(c => new { c.FullName, c.CurrentCompany, c.CurrentDesignation }).FirstOrDefault(),
            })
            .ToListAsync(ct);

        return Results.Ok(new
        {
            job,
            canManage = level >= HireLevel.HiringManager,
            canAdd = level >= HireLevel.Recruiter && job.Status is "open" or "on_hold",
            stages = stages.Where(s => s.IsActive || applications.Any(a => a.StageId == s.Id))
                .Select(s => new { s.Id, s.Name, s.Position, s.IsFinal }),
            applications,
        });
    }

    private static async Task<IResult> HistoryAsync(Guid id, HireAccess access, AppDbContext db, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        if (!await access.Applications(level).AnyAsync(a => a.Id == id, ct)) return Results.NotFound();

        var stages = (await access.PipelineAsync(ct)).ToDictionary(s => s.Id, s => s.Name);
        var events = await access.Events(level).AsNoTracking()
            .Where(e => e.ApplicationId == id).OrderBy(e => e.Id).ToListAsync(ct);
        var actorIds = events.Where(e => e.ActorId != null).Select(e => e.ActorId!.Value).Distinct().ToList();
        var actors = await db.Users.AsNoTracking().Where(u => actorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        return Results.Ok(events.Select(e => new
        {
            e.Kind,
            from = e.FromStageId is Guid f ? stages.GetValueOrDefault(f) : null,
            to = e.ToStageId is Guid t ? stages.GetValueOrDefault(t) : null,
            e.Reason,
            by = e.ActorId is Guid a ? actors.GetValueOrDefault(a) : null,
            e.OccurredAt,
        }));
    }

    private static async Task<IResult> MoveAsync(
        Guid id, MoveRequest req, HireAccess access, TenantContext tenant, CancellationToken ct)
    {
        var (app, error) = await LoadForChangeAsync(id, access, ct);
        if (error is not null) return error;
        if (app!.Outcome != "active")
            return Results.Conflict(new { error = $"This application was {app.Outcome}. Reopen it before moving it." });

        var stage = (await access.PipelineAsync(ct)).FirstOrDefault(s => s.Id == req.StageId);
        if (stage is null || !stage.IsActive) return Results.BadRequest(new { error = "Choose a stage in this organisation's pipeline." });
        if (stage.Id == app.StageId) return Results.Ok(new { app.Id, app.StageId, stage = stage.Name });

        var now = DateTimeOffset.UtcNow;
        access.AddEvent(Event(tenant, app.Id, "moved", app.StageId, stage.Id, null, now));
        app.StageId = stage.Id;
        app.StageChangedAt = now;
        app.UpdatedAt = now;
        await access.SaveAsync(ct);
        return Results.Ok(new { app.Id, app.StageId, stage = stage.Name });
    }

    private static async Task<IResult> RejectAsync(
        Guid id, ReasonRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var (app, error) = await LoadForChangeAsync(id, access, ct);
        if (error is not null) return error;
        if (app!.Outcome != "active") return Results.Conflict(new { error = $"This application is already {app.Outcome}." });

        var reason = req.Reason?.Trim() ?? "";
        if (reason.Length is < 3 or > 1000)
            return Results.BadRequest(new
            {
                error = "Write the reason for rejecting (at least a few words, at most 1,000 characters). "
                      + "It is kept with the application, so the decision can be explained later.",
            });

        var now = DateTimeOffset.UtcNow;
        access.AddEvent(Event(tenant, app.Id, "rejected", app.StageId, app.StageId, reason, now));
        app.Outcome = "rejected";
        app.RejectionReason = reason;
        app.DecidedAt = now;   // the retention clock starts here
        app.UpdatedAt = now;
        await access.SaveAsync(ct);
        // The reason stays in the Hire tables; the audit row says only that it happened.
        await audit.WriteAsync("application.rejected", "application", id.ToString(), ct: ct, productCode: Product);
        return Results.Ok(new { app.Id, app.Outcome });
    }

    private static async Task<IResult> WithdrawAsync(
        Guid id, ReasonRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var (app, error) = await LoadForChangeAsync(id, access, ct);
        if (error is not null) return error;
        if (app!.Outcome != "active") return Results.Conflict(new { error = $"This application is already {app.Outcome}." });

        var reason = req.Reason?.Trim();
        if (reason?.Length > 1000) return Results.BadRequest(new { error = "The note can be at most 1,000 characters." });

        var now = DateTimeOffset.UtcNow;
        access.AddEvent(Event(tenant, app.Id, "withdrawn", app.StageId, app.StageId,
            string.IsNullOrEmpty(reason) ? null : reason, now));
        app.Outcome = "withdrawn";
        app.DecidedAt = now;   // the retention clock starts here
        app.UpdatedAt = now;
        await access.SaveAsync(ct);
        await audit.WriteAsync("application.withdrawn", "application", id.ToString(), ct: ct, productCode: Product);
        return Results.Ok(new { app.Id, app.Outcome });
    }

    private static async Task<IResult> ReopenAsync(
        Guid id, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var (app, error) = await LoadForChangeAsync(id, access, ct);
        if (error is not null) return error;
        if (app!.Outcome == "active") return Results.Ok(new { app.Id, app.Outcome });

        var now = DateTimeOffset.UtcNow;
        // The rejection reason leaves the application but NOT the history:
        // the "rejected" event still carries it, so "why was this person
        // rejected in March" stays answerable after they are reconsidered.
        access.AddEvent(Event(tenant, app.Id, "reopened", app.StageId, app.StageId, null, now));
        app.Outcome = "active";
        app.RejectionReason = null;
        app.DecidedAt = null;  // back under consideration: no clock running
        app.UpdatedAt = now;
        await access.SaveAsync(ct);
        await audit.WriteAsync("application.reopened", "application", id.ToString(), ct: ct, productCode: Product);
        return Results.Ok(new { app.Id, app.Outcome });
    }

    // ============================================================= helpers

    /// <summary>
    /// An application this person may change: visible to them (else 404), on
    /// a job that is open or on hold (else 409). Hiring managers qualify for
    /// their own jobs' applications.
    /// </summary>
    private static async Task<(HireApplication? App, IResult? Error)> LoadForChangeAsync(
        Guid id, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return (null, HireAccess.NoAccess());
        var app = await access.Applications(level).FirstOrDefaultAsync(a => a.Id == id, ct);
        if (app is null) return (null, Results.NotFound());
        var status = await access.Jobs(level).Where(j => j.Id == app.JobId).Select(j => j.Status).FirstOrDefaultAsync(ct);
        if (status is not ("open" or "on_hold"))
            return (null, Results.Conflict(new { error = "This job is closed, so its pipeline is kept as it was. Reopen the job to change it." }));
        return (app, null);
    }

    private static HireApplicationEvent Event(
        TenantContext tenant, Guid appId, string kind, Guid? from, Guid? to, string? reason, DateTimeOffset at) => new()
    {
        TenantId = tenant.TenantId, ApplicationId = appId, Kind = kind,
        FromStageId = from, ToStageId = to, Reason = reason, ActorId = tenant.UserId, OccurredAt = at,
    };

    /// <summary>Copies an edit onto a candidate after checking it; a sentence on failure.</summary>
    private static string? Apply(HireCandidate c, SaveCandidateRequest req)
    {
        var name = Clean(req.FullName);
        if (name is null || name.Length > 200) return "A name is required (up to 200 characters).";

        var email = Clean(req.Email)?.ToLowerInvariant();
        if (email is not null && (email.Length > 320 || !Regex.IsMatch(email, @"^[^@\s]+@[^@\s]+\.[^@\s]+$")))
            return "That email address does not look right.";
        var phone = Clean(req.Phone);
        if (phone is not null && !Regex.IsMatch(phone, @"^\+?[0-9 ()-]{7,20}$"))
            return "That phone number does not look right. Use digits, with + and a country code if outside India.";
        if (email is null && phone is null) return "Give an email address or a phone number, so the candidate can be reached.";

        var source = Clean(req.Source) ?? "other";
        // careers_page is written only by the careers portal, never by hand:
        // it is how a recruiter will tell self-applications apart.
        // A candidate who came through the portal keeps that source on edit.
        var keepsPortal = source == "careers_page" && c.Source == "careers_page";
        if (!Sources.Contains(source) && !keepsPortal) return "Choose where this candidate came from.";

        var linkedin = Clean(req.LinkedinUrl);
        if (linkedin is not null && (linkedin.Length > 300 || !linkedin.StartsWith("https://", StringComparison.Ordinal)))
            return "The LinkedIn link must start with https://.";

        if (req.ExperienceMonths is < 0 or > 720) return "Experience must be between 0 and 60 years.";
        if (req.NoticePeriodDays is < 0 or > 365) return "Notice period must be between 0 and 365 days.";
        if (req.ExpectedSalary is < 0 or > 999_999_999_999m) return "Expected salary is out of range.";
        var currency = (Clean(req.SalaryCurrency) ?? "INR").ToUpperInvariant();
        if (!Regex.IsMatch(currency, "^[A-Z]{3}$")) return "Currency must be a three-letter code, such as INR.";

        foreach (var (label, text, max) in new[]
                 {
                     ("Location", req.CurrentLocation, 120), ("Company", req.CurrentCompany, 150),
                     ("Designation", req.CurrentDesignation, 150), ("Education", req.Education, 500),
                     ("Source detail", req.SourceDetail, 200),
                 })
            if (Clean(text)?.Length > max) return $"{label} can be at most {max} characters.";

        string[] List(string[]? xs, int maxItems, int maxLen, string what, out string? err)
        {
            err = null;
            var list = (xs ?? []).Select(x => x?.Trim() ?? "").Where(x => x.Length > 0)
                .DistinctBy(x => x.ToLowerInvariant()).ToArray();
            if (list.Length > maxItems) err = $"At most {maxItems} {what}.";
            else if (list.Any(x => x.Length > maxLen)) err = $"Each of the {what} can be at most {maxLen} characters.";
            return list;
        }
        var skills = List(req.Skills, 50, 50, "skills", out var e1);
        if (e1 is not null) return e1;
        var tags = List(req.Tags, 20, 30, "tags", out var e2);
        if (e2 is not null) return e2;

        c.FullName = name;
        c.Email = email;
        c.Phone = phone;
        c.CurrentLocation = Clean(req.CurrentLocation);
        c.CurrentCompany = Clean(req.CurrentCompany);
        c.CurrentDesignation = Clean(req.CurrentDesignation);
        c.ExperienceMonths = (short?)req.ExperienceMonths;
        c.Education = Clean(req.Education);
        c.Skills = skills;
        c.Tags = tags;
        c.ExpectedSalary = req.ExpectedSalary;
        c.SalaryCurrency = currency;
        c.NoticePeriodDays = (short?)req.NoticePeriodDays;
        c.Source = source;
        c.SourceDetail = Clean(req.SourceDetail);
        c.LinkedinUrl = linkedin;
        return null;
    }

    private static object Shape(HireCandidate c) => new
    {
        c.Id, c.FullName, c.Email, c.Phone, c.CurrentLocation, c.CurrentCompany, c.CurrentDesignation,
        c.ExperienceMonths, c.Education, c.Skills, c.Tags, c.ExpectedSalary, c.SalaryCurrency,
        c.NoticePeriodDays, c.Source, c.SourceDetail, c.LinkedinUrl, c.CreatedAt, c.UpdatedAt,
    };

    private static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

/// <summary>Full replacement on update — every field every time.</summary>
public sealed record SaveCandidateRequest(
    string? FullName, string? Email, string? Phone,
    string? CurrentLocation, string? CurrentCompany, string? CurrentDesignation,
    int? ExperienceMonths, string? Education, string[]? Skills, string[]? Tags,
    decimal? ExpectedSalary, string? SalaryCurrency, int? NoticePeriodDays,
    string? Source, string? SourceDetail, string? LinkedinUrl);

public sealed record ApplyRequest(Guid? CandidateId, Guid? JobId);
public sealed record MoveRequest(Guid StageId);
public sealed record ReasonRequest(string? Reason);

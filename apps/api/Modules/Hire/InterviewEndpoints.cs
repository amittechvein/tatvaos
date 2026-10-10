using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Hire;

/// <summary>
/// Interviews and interview feedback (roadmap Phase 2; 20261009-s).
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHO DOES WHAT — the access table Amit confirmed on 2 Oct, plus one thing:
///    * schedule, change, cancel: administrators and recruiters. A hiring
///      manager moves or rejects on their own jobs; running the process is
///      not theirs.
///    * see: whoever may see the application (HireAccess.Interviews).
///    * the panel: only people who can ALREADY see that application —
///      administrators, recruiters, the job's own hiring manager — so a panel
///      seat never shows anyone a new candidate.
///    * feedback (the new ability): a panel member, about themselves only.
///      The database refuses feedback without a panel row (FK).
///
///  INDEPENDENT FEEDBACK. A panel member who has not yet given their own
///  feedback does not see their colleagues' on that interview, so the first
///  opinion written does not become everyone's. Once they have given theirs,
///  they see all of it. People not on the panel who may see the application
///  (the recruiters, the job's hiring manager) see all of it.
///
///  Feedback is personal data about a candidate: it is never put in the audit
///  log (only that it was given), and it goes when the candidate goes.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class InterviewEndpoints
{
    private const string Product = "hire";
    private static readonly string[] Modes = ["in_person", "video", "phone"];
    private static readonly string[] Recommendations = ["strong_yes", "yes", "no", "strong_no"];
    public const int MaxPanel = 10;

    public sealed record SaveInterviewRequest(
        DateTimeOffset? ScheduledAt, int? DurationMinutes, string? Mode, string? Place, List<Guid>? Panel);
    public sealed record CancelInterviewRequest(string? Reason);
    public sealed record FeedbackRequest(short? Rating, string? Recommendation, string? Notes);

    public static void MapInterviewEndpoints(this IEndpointRouteBuilder app)
    {
        var a = app.MapGroup("/api/hire/applications").RequireAuthorization("User").WithTags("Hire");
        a.MapGet("/{id:guid}/interviews", ListAsync);
        a.MapPost("/{id:guid}/interviews", ScheduleAsync);
        a.MapGet("/{id:guid}/interviews/panel-options", PanelOptionsAsync);

        var i = app.MapGroup("/api/hire/interviews").RequireAuthorization("User").WithTags("Hire");
        i.MapPut("/{id:guid}", UpdateAsync);
        i.MapPost("/{id:guid}/cancel", CancelAsync);
        i.MapPut("/{id:guid}/feedback", FeedbackAsync);
    }

    // ================================================================ reads

    private static async Task<IResult> ListAsync(Guid id, HireAccess access, AppDbContext db, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return HireAccess.NoAccess();
        if (!await access.Applications(level).AnyAsync(x => x.Id == id, ct)) return Results.NotFound();

        var interviews = await access.Interviews(level).AsNoTracking()
            .Where(x => x.ApplicationId == id).OrderBy(x => x.ScheduledAt).ToListAsync(ct);
        var ids = interviews.Select(x => x.Id).ToList();
        var panels = await access.PanelsAsync(ids, ct);
        var feedback = await access.FeedbackAsync(ids, ct);
        var people = panels.Select(p => p.UserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var me = access.UserId;

        return Results.Ok(interviews.Select(x =>
        {
            var panel = panels.Where(p => p.InterviewId == x.Id).ToList();
            var all = feedback.Where(f => f.InterviewId == x.Id).ToList();
            var onPanel = me is Guid m && panel.Any(p => p.UserId == m);
            var gaveMine = me is Guid m2 && all.Any(f => f.InterviewerId == m2);
            // Independent feedback: a panel member sees colleagues' only after giving their own.
            var visible = onPanel && !gaveMine ? all.Where(f => f.InterviewerId == me).ToList() : all;
            return new
            {
                x.Id, x.ScheduledAt, x.DurationMinutes, x.Mode, x.Place, x.Status, x.CancelReason,
                panel = panel.Select(p => new { p.UserId, name = names.GetValueOrDefault(p.UserId) }),
                feedback = visible.Select(f => new
                {
                    f.InterviewerId, name = names.GetValueOrDefault(f.InterviewerId),
                    f.Rating, f.Recommendation, f.Notes, f.SubmittedAt, f.UpdatedAt,
                }),
                feedbackGiven = all.Count,
                feedbackHidden = onPanel && !gaveMine ? all.Count(f => f.InterviewerId != me) : 0,
                youAreOnPanel = onPanel,
            };
        }));
    }

    private static async Task<IResult> PanelOptionsAsync(Guid id, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level < HireLevel.Recruiter) return Forbidden("Only recruiters and administrators schedule interviews.");
        var jobId = await access.Applications(level).Where(x => x.Id == id).Select(x => (Guid?)x.JobId).FirstOrDefaultAsync(ct);
        if (jobId is null) return Results.NotFound();
        var people = await access.PanelCandidatesAsync(jobId.Value, ct);
        return Results.Ok(people.Select(p => new { id = p.Id, name = p.Name }));
    }

    // ================================================================ writes

    private static async Task<IResult> ScheduleAsync(
        Guid id, SaveInterviewRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var (app, error) = await LoadApplicationForSchedulingAsync(id, access, ct);
        if (error is not null) return error;
        var invalid = await ValidateAsync(req, app!.JobId, access, ct);
        if (invalid is not null) return Results.BadRequest(new { error = invalid });

        var now = DateTimeOffset.UtcNow;
        var iv = new HireInterview
        {
            Id = Guid.NewGuid(), TenantId = tenant.TenantId, ApplicationId = app.Id,
            CreatedBy = tenant.UserId, CreatedAt = now, UpdatedAt = now,
        };
        Apply(iv, req);
        access.AddInterview(iv);
        foreach (var u in req.Panel!.Distinct())
            access.AddPanelMember(new HireInterviewPanelMember { TenantId = tenant.TenantId, InterviewId = iv.Id, UserId = u, AddedAt = now });
        await access.SaveAsync(ct);
        await audit.WriteAsync("interview.scheduled", "application", app.Id.ToString(),
            after: new { iv.Id, iv.Mode, panelSize = req.Panel!.Distinct().Count() }, ct: ct, productCode: Product);
        return Results.Created($"/api/hire/interviews/{iv.Id}", new { iv.Id });
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, SaveInterviewRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var (iv, app, error) = await LoadInterviewForChangeAsync(id, access, ct);
        if (error is not null) return error;
        var invalid = await ValidateAsync(req, app!.JobId, access, ct);
        if (invalid is not null) return Results.BadRequest(new { error = invalid });

        Apply(iv!, req);
        iv!.UpdatedAt = DateTimeOffset.UtcNow;
        var wanted = req.Panel!.Distinct().ToHashSet();
        var current = await access.PanelForChangeAsync(iv.Id, ct);
        // Removing someone from the panel removes their feedback with them (FK cascade).
        foreach (var p in current.Where(p => !wanted.Contains(p.UserId))) access.RemovePanelMember(p);
        foreach (var u in wanted.Where(u => current.All(p => p.UserId != u)))
            access.AddPanelMember(new HireInterviewPanelMember { TenantId = tenant.TenantId, InterviewId = iv.Id, UserId = u, AddedAt = iv.UpdatedAt });
        await access.SaveAsync(ct);
        await audit.WriteAsync("interview.changed", "application", app.Id.ToString(),
            after: new { iv.Id, panelSize = wanted.Count }, ct: ct, productCode: Product);
        return Results.Ok(new { iv.Id });
    }

    private static async Task<IResult> CancelAsync(
        Guid id, CancelInterviewRequest req, HireAccess access, AuditWriter audit, CancellationToken ct)
    {
        var (iv, app, error) = await LoadInterviewForChangeAsync(id, access, ct);
        if (error is not null) return error;
        var reason = req.Reason?.Trim();
        if (reason is { Length: > 500 }) return Results.BadRequest(new { error = "The reason can be at most 500 characters." });
        iv!.Status = "cancelled";
        iv.CancelReason = string.IsNullOrEmpty(reason) ? null : reason;
        iv.UpdatedAt = DateTimeOffset.UtcNow;
        await access.SaveAsync(ct);
        await audit.WriteAsync("interview.cancelled", "application", app!.Id.ToString(),
            after: new { iv.Id }, ct: ct, productCode: Product);
        return Results.Ok(new { iv.Id, iv.Status });
    }

    /// <summary>
    /// Give or change your own feedback. Only a panel member, only for
    /// themselves; the database refuses any other row (FK to the panel).
    /// </summary>
    private static async Task<IResult> FeedbackAsync(
        Guid id, FeedbackRequest req, HireAccess access, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None || tenant.UserId is not Guid me) return HireAccess.NoAccess();
        var iv = await access.Interviews(level).FirstOrDefaultAsync(x => x.Id == id, ct);
        if (iv is null) return Results.NotFound();
        if (iv.Status == "cancelled") return Results.Conflict(new { error = "This interview was cancelled." });
        var panel = await access.PanelsAsync([iv.Id], ct);
        if (panel.All(p => p.UserId != me))
            return Forbidden("Only the interview's panel give feedback on it.");
        if (req.Rating is not (>= 1 and <= 5)) return Results.BadRequest(new { error = "Give a rating from 1 to 5." });
        if (req.Recommendation is null || !Recommendations.Contains(req.Recommendation))
            return Results.BadRequest(new { error = "Choose a recommendation: strong yes, yes, no or strong no." });
        var notes = req.Notes?.Trim();
        if (notes is { Length: > 2000 }) return Results.BadRequest(new { error = "Notes can be at most 2,000 characters." });

        var now = DateTimeOffset.UtcNow;
        var f = await access.MyFeedbackForChangeAsync(iv.Id, ct);
        var first = f is null;
        if (f is null)
        {
            f = new HireInterviewFeedback { Id = Guid.NewGuid(), TenantId = tenant.TenantId, InterviewId = iv.Id, InterviewerId = me, SubmittedAt = now };
            access.AddFeedback(f);
        }
        f.Rating = req.Rating.Value;
        f.Recommendation = req.Recommendation;
        f.Notes = string.IsNullOrEmpty(notes) ? null : notes;
        f.UpdatedAt = now;
        await access.SaveAsync(ct);
        // That feedback was given - never what it said.
        await audit.WriteAsync(first ? "interview.feedback_given" : "interview.feedback_changed", "application",
            iv.ApplicationId.ToString(), after: new { interviewId = iv.Id }, ct: ct, productCode: Product);
        return Results.Ok(new { saved = true });
    }

    // ================================================================ helpers

    private static IResult Forbidden(string msg) =>
        Results.Json(new { error = msg }, statusCode: StatusCodes.Status403Forbidden);

    private static void Apply(HireInterview iv, SaveInterviewRequest req)
    {
        // To UTC: Npgsql refuses a DateTimeOffset with any other offset, and
        // the form sends India time (+05:30). The first test run answered 500
        // here (9 Oct) - the same trap as the meetings API (PR 186).
        iv.ScheduledAt = req.ScheduledAt!.Value.ToUniversalTime();
        iv.DurationMinutes = req.DurationMinutes ?? 60;
        iv.Mode = req.Mode ?? "in_person";
        iv.Place = string.IsNullOrWhiteSpace(req.Place) ? null : req.Place.Trim();
    }

    private static async Task<string?> ValidateAsync(SaveInterviewRequest req, Guid jobId, HireAccess access, CancellationToken ct)
    {
        if (req.ScheduledAt is null) return "Choose when the interview is.";
        if (req.DurationMinutes is { } d && (d < 15 || d > 480)) return "An interview lasts between 15 minutes and 8 hours.";
        if (req.Mode is not null && !Modes.Contains(req.Mode)) return "The interview is in person, on video or by phone.";
        if (req.Place is { Length: > 300 }) return "The place or link can be at most 300 characters.";
        var panel = req.Panel?.Distinct().ToList() ?? [];
        if (panel.Count is 0 or > MaxPanel) return $"Choose who interviews: 1 to {MaxPanel} people.";
        var eligible = (await access.PanelCandidatesAsync(jobId, ct)).Select(p => p.Id).ToHashSet();
        if (panel.Any(u => !eligible.Contains(u)))
            return "Someone on the panel cannot see this application. Panels are administrators, recruiters and this job's hiring manager.";
        return null;
    }

    /// <summary>Recruiter level, the application visible, active, and its job open or on hold.</summary>
    private static async Task<(HireApplication? App, IResult? Error)> LoadApplicationForSchedulingAsync(
        Guid applicationId, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return (null, HireAccess.NoAccess());
        if (level < HireLevel.Recruiter) return (null, Forbidden("Only recruiters and administrators schedule interviews."));
        var app = await access.Applications(level).FirstOrDefaultAsync(x => x.Id == applicationId, ct);
        if (app is null) return (null, Results.NotFound());
        if (app.Outcome != "active")
            return (null, Results.Conflict(new { error = $"This application was {app.Outcome}. Reopen it to schedule interviews." }));
        var status = await access.Jobs(level).Where(j => j.Id == app.JobId).Select(j => j.Status).FirstOrDefaultAsync(ct);
        if (status is not ("open" or "on_hold"))
            return (null, Results.Conflict(new { error = "This job is closed, so its pipeline is kept as it was." }));
        return (app, null);
    }

    private static async Task<(HireInterview? Iv, HireApplication? App, IResult? Error)> LoadInterviewForChangeAsync(
        Guid interviewId, HireAccess access, CancellationToken ct)
    {
        var level = await access.LevelAsync(ct);
        if (level == HireLevel.None) return (null, null, HireAccess.NoAccess());
        if (level < HireLevel.Recruiter) return (null, null, Forbidden("Only recruiters and administrators change interviews."));
        var iv = await access.Interviews(level).FirstOrDefaultAsync(x => x.Id == interviewId, ct);
        if (iv is null) return (null, null, Results.NotFound());
        if (iv.Status == "cancelled") return (null, null, Results.Conflict(new { error = "This interview was cancelled." }));
        var (app, error) = await LoadApplicationForSchedulingAsync(iv.ApplicationId, access, ct);
        return error is not null ? (null, null, error) : (iv, app, null);
    }
}

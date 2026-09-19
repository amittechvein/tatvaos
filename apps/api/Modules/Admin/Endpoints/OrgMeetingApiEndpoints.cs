using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Modules.Connect.Endpoints;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Admin.Endpoints;

/// <summary>
/// Meetings on the organisation API — a school's ERP scheduling classes and
/// handing students the link to join them.
///
/// Amit, 18 September 2026: "api for meeting schedule and make sure schedule
/// meeting visible on calendar and join api also — i will give api to erp
/// developer, teacher able to create meeting via erp and students also able
/// to join the meeting using erp so need both options".
///
/// ── THE TWO HALVES, AND WHY THEY ARE TWO SCOPES ──────────────────────────
///
///  A timetable system has a staff half and a student half, and they do not
///  deserve the same power. The staff half schedules; the student half reads
///  a timetable and shows a Join button. So:
///
///     meetings:schedule   create, reschedule, cancel
///     meetings:join       read a meeting, get its join link
///
///  Two keys, and the student-facing half of the ERP carries only the second.
///  If reading came free with scheduling, the key sitting in a student portal
///  could cancel every class in the school.
///
/// ── WHOSE MEETING IS IT ──────────────────────────────────────────────────
///
///  Every meeting has a host who is a real person in the organisation, named
///  by their email address. The key does not become the host: a meeting owned
///  by "the ERP" would be a meeting no teacher could edit in TatvaOS, and the
///  first thing anybody would ask for is the ability to change one by hand.
///
///  So hostEmail is required, must be an ACTIVE person in this tenant, and
///  the meeting is created exactly as if they had created it themselves —
///  through Connect's own CreateMeetingForAsync, not a copy of it.
///
/// ── HOW A STUDENT ACTUALLY GETS IN ───────────────────────────────────────
///
///  The join link is the meeting link. There is no per-student token, and
///  that is a decision rather than an omission:
///
///   * a student who has a TatvaOS account (the same ERP admits them through
///     /api/v1/org/people) signs in and walks straight into the room — the
///     waiting room at its default setting holds guests, not colleagues;
///   * a student who does not gives their name at the door and waits to be
///     let in, or walks in if the teacher set waitingRoom to off.
///
///  A per-student single-use token would make attendance attributable and a
///  forwarded link useless. It would also be a new credential type minting
///  admission to a live room, which is the kind of thing this codebase builds
///  after somebody has asked for it, not before. The join endpoint below is
///  shaped so that adding one later changes its RESPONSE and not its callers.
///
///  What the join endpoint adds over printing the link yourself is what to
///  tell the student — whether this meeting holds guests at the door — so an
///  ERP can say so BEFORE the class starts, rather than after.
///
/// ── WHAT THE STUDENT KEY MAY LEARN (CTO review, 18 Sept 2026) ────────────
///
///  The key in a student portal is the most exposed credential in this
///  design: it sits in whatever the ERP vendor built. So what it can read is
///  a decision, not a consequence of which endpoints were convenient:
///
///   * it cannot list the organisation's meetings at all. The timetable is
///     the staff half's view and needs meetings:schedule; the student half
///     already holds the ids of the classes it scheduled;
///   * a meeting it reads names the teacher by DISPLAY NAME only — that is
///     what a class shows a student — never by email or id;
///   * the join call takes NO email. The first version accepted one and
///     answered "recognised: true/false", which made a compromised portal
///     key an oracle for whether any address belongs to the school. Removed.
///     The ERP knows whether a student has an account, because it is the
///     thing that created it (people API), and the waiting-room setting
///     tells it the rest.
/// </summary>
public static class OrgMeetingApiEndpoints
{
    public const string MeetingsPath = "/api/v1/org/meetings";

    private const string ScheduleRefusal =
        "This key is not allowed to schedule meetings. Create a key with that ticked, in Organisation then API keys.";
    private const string ReadRefusal =
        "This key is not allowed to read meetings. Create a key with 'Read meetings and hand out join links' ticked, in Organisation then API keys.";

    public static void MapOrgMeetingApiEndpoints(this IEndpointRouteBuilder app)
    {
        // AllowAnonymous because the credential is the key, not a session —
        // the same shape as the people endpoint beside it. The rate limiter is
        // the org-api one, keyed on the address Caddy wrote.
        app.MapPost(MeetingsPath, ScheduleAsync)
            .AllowAnonymous().RequireRateLimiting("org-api").WithTags("Organisation API");

        app.MapGet(MeetingsPath, ListAsync)
            .AllowAnonymous().RequireRateLimiting("org-api").WithTags("Organisation API");

        app.MapGet(MeetingsPath + "/{id:guid}", GetAsync)
            .AllowAnonymous().RequireRateLimiting("org-api").WithTags("Organisation API");

        app.MapPost(MeetingsPath + "/{id:guid}/join", JoinAsync)
            .AllowAnonymous().RequireRateLimiting("org-api").WithTags("Organisation API");

        app.MapDelete(MeetingsPath + "/{id:guid}", CancelAsync)
            .AllowAnonymous().RequireRateLimiting("org-api").WithTags("Organisation API");
    }

    // ==================================================================
    //  Schedule
    // ==================================================================
    private static async Task<IResult> ScheduleAsync(
        ScheduleMeetingRequest req, HttpContext http, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, ConnectRoomKey roomKeys, AuditWriter audit,
        ILoggerFactory logs, CancellationToken ct)
    {
        var auth = await OrgApiAuth.AuthenticateAsync(
            http, db, tenant, OrgApiKey.ScopeMeetingsSchedule, ScheduleRefusal, ct);
        if (auth.Caller is not { } caller) return auth.Refusal!;

        var host = await FindPersonAsync(db, req.HostEmail, ct);
        if (host is null)
            return Results.BadRequest(new
            {
                error = "hostEmail must be the address of an active person in this organisation. "
                      + "Add them first, through the people API or the console.",
            });

        if (req.StartsAt is null)
            return Results.BadRequest(new { error = "startsAt is required — a scheduled meeting needs a start time." });

        // Connect's own creation path, with every rule it applies: the title
        // length, the end-before-start check, the waiting-room values, the
        // password length, the mode lock and the private-meeting refusal when
        // the server has no room key. A copy of those rules here would start
        // identical and drift.
        //
        // Mode is NOT offered to the ERP. It is chosen once and can never
        // change (a trigger on connect.meetings enforces that), so it is the
        // last thing to expose on an API before anybody has asked for it;
        // meetings land on the product default.
        var sink = new ConnectEndpoints.Sink();
        var created = await ConnectEndpoints.CreateMeetingForAsync(
            host.Id,
            new ConnectEndpoints.CreateMeetingRequest(
                Title: req.Title,
                Kind: "scheduled",
                ScheduledStart: req.StartsAt,
                ScheduledEnd: req.EndsAt,
                Timezone: req.Timezone,
                Password: req.Password,
                WaitingRoom: req.WaitingRoom,
                AllowGuests: req.AllowGuests,
                AutoRecord: null,
                SharePolicy: null,
                ChatPolicy: null,
                MinutesLive: null,
                Mode: null),
            db, tenant, hasher, roomKeys, audit, logs, ct, sink);

        // A refusal from Connect is already the right answer, in words; it is
        // passed through rather than translated, because translating it is how
        // the API and the console end up disagreeing about the same rule.
        if (sink.Meeting is not { } meeting) return created;

        await audit.WriteAsync("org.api_meeting_scheduled", "org_api_key", caller.KeyId.ToString(),
            after: new
            {
                meetingId = meeting.Id,
                host = req.HostEmail,
                meeting.ScheduledStart,
                from = OrgApiAuth.ClientAddress(http),
            }, ct: ct);

        return Results.Created($"{MeetingsPath}/{meeting.Id}", Shape(meeting, host, full: true));
    }

    // ==================================================================
    //  Read
    // ==================================================================
    private static async Task<IResult> ListAsync(
        HttpContext http, AppDbContext db, TenantContext tenant,
        DateTimeOffset? from, DateTimeOffset? to, string? hostEmail, CancellationToken ct)
    {
        // meetings:schedule, not meetings:join. The whole organisation's
        // timetable — every class, every teacher, every time — is the staff
        // half's view. A student portal that could read it would be a way to
        // enumerate a school's staff from a compromised key.
        var auth = await OrgApiAuth.AuthenticateAsync(
            http, db, tenant, OrgApiKey.ScopeMeetingsSchedule, ScheduleRefusal, ct);
        if (auth.Caller is null) return auth.Refusal!;

        // Defaults chosen for the question an ERP asks: "what is on". Not
        // everything ever scheduled — a school with three years of history
        // would get a response nobody can page through, and the caller who
        // wanted history can say so with from/to.
        var start = from ?? DateTimeOffset.UtcNow.AddHours(-12);
        var end = to ?? start.AddDays(30);
        if (end <= start)
            return Results.BadRequest(new { error = "`to` must be after `from`." });

        Guid? hostId = null;
        if (!string.IsNullOrWhiteSpace(hostEmail))
        {
            var host = await FindPersonAsync(db, hostEmail, ct);
            // An unknown teacher is an empty timetable, not an error: an ERP
            // asking for somebody who left should show "no classes", not fail
            // the page.
            if (host is null) return Results.Ok(new { meetings = Array.Empty<object>() });
            hostId = host.Id;
        }

        var rows = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Kind == "scheduled"
                        && m.Status != "cancelled"
                        && m.ScheduledStart != null
                        && m.ScheduledStart >= start
                        && m.ScheduledStart < end
                        && (hostId == null || m.CreatedByUserId == hostId))
            .OrderBy(m => m.ScheduledStart)
            .Take(500)
            .ToListAsync(ct);

        var hostIds = rows.Select(m => m.CreatedByUserId).Where(x => x != null).Select(x => x!.Value).Distinct().ToList();
        var hosts = await db.Users.AsNoTracking()
            .Where(u => hostIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, ct);

        return Results.Ok(new
        {
            meetings = rows.Select(m => Shape(
                m,
                m.CreatedByUserId is Guid h ? hosts.GetValueOrDefault(h) : null,
                full: true)).ToList(),
        });
    }

    private static async Task<IResult> GetAsync(
        Guid id, HttpContext http, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        // Either key may read one meeting: the one that scheduled it holds
        // its id, and so does the one that hands out its link.
        var auth = await OrgApiAuth.AuthenticateAsync(
            http, db, tenant, [OrgApiKey.ScopeMeetingsJoin, OrgApiKey.ScopeMeetingsSchedule], ReadRefusal, ct);
        if (auth.Caller is not { } caller) return auth.Refusal!;

        var meeting = await db.ConnectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == id, ct);
        if (meeting is null) return NotFound();

        var host = meeting.CreatedByUserId is Guid h
            ? await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == h, ct)
            : null;

        // A key that may schedule sees the host as a person; a key that may
        // only join sees a teacher's name on a class.
        return Results.Ok(Shape(meeting, host, full: caller.Scopes.Contains(OrgApiKey.ScopeMeetingsSchedule)));
    }

    // ==================================================================
    //  Join
    // ==================================================================
    private static async Task<IResult> JoinAsync(
        Guid id, HttpContext http, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var auth = await OrgApiAuth.AuthenticateAsync(
            http, db, tenant, OrgApiKey.ScopeMeetingsJoin, ReadRefusal, ct);
        if (auth.Caller is null) return auth.Refusal!;

        var meeting = await db.ConnectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == id, ct);
        if (meeting is null) return NotFound();

        // A link to a meeting that is over is worse than no link: the student
        // clicks it, gets a refusal at the door, and asks the teacher why the
        // ERP is broken.
        if (meeting.Status is "ended" or "cancelled")
            return Results.Conflict(new { error = "That meeting is over." });

        var hostName = meeting.CreatedByUserId is Guid h
            ? await db.Users.AsNoTracking().Where(u => u.Id == h).Select(u => u.DisplayName).FirstOrDefaultAsync(ct)
            : null;

        // What the ERP should tell the student, from the meeting alone. The
        // waiting room holds guests by default; a colleague who is signed in
        // is not a guest. 'everyone' holds them too, and 'off' holds nobody.
        // Whether THIS student is a guest is the ERP's knowledge, not ours to
        // confirm — see the header.
        var guidance = meeting.WaitingRoom switch
        {
            "off" => "Open the link to join.",
            "everyone" => "Open the link, then sign in or give your name. The host will let you in.",
            _ => meeting.AllowGuests
                ? "Open the link. Sign in to TatvaOS to go straight in; otherwise give your name and the host will let you in."
                : "Open the link and sign in to TatvaOS to join. This meeting does not admit guests.",
        };

        return Results.Ok(new
        {
            joinUrl = ConnectEndpoints.JoinUrlOf(meeting),
            meetingId = meeting.Id,
            meeting.Code,
            meeting.Title,
            startsAt = meeting.ScheduledStart,
            endsAt = meeting.ScheduledEnd,
            meeting.Timezone,
            hostName,
            meeting.WaitingRoom,
            meeting.AllowGuests,
            needsPassword = meeting.PasswordHash != null,
            guidance,
        });
    }

    // ==================================================================
    //  Cancel
    // ==================================================================
    private static async Task<IResult> CancelAsync(
        Guid id, HttpContext http, AppDbContext db, TenantContext tenant,
        AuditWriter audit, ILoggerFactory logs, CancellationToken ct)
    {
        var auth = await OrgApiAuth.AuthenticateAsync(
            http, db, tenant, OrgApiKey.ScopeMeetingsSchedule, ScheduleRefusal, ct);
        if (auth.Caller is not { } caller) return auth.Refusal!;

        var meeting = await db.ConnectMeetings.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (meeting is null) return NotFound();

        // Ending a LIVE meeting is a different act with different consequences
        // for the people currently in it, and it is not on this API: an ERP
        // batch job must not be able to hang up on a class in progress.
        if (meeting.Status == "active")
            return Results.Conflict(new { error = "That meeting is running. It can only be ended from Connect." });
        if (meeting.Status is "ended" or "cancelled") return Results.NoContent();

        meeting.Status = "cancelled";
        meeting.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // Off the host's calendar as well. The emailed CANCEL that the console
        // sends is NOT sent here: this API does not invite anybody, so there is
        // nobody it invited to tell. A meeting the ERP scheduled and whose
        // teacher separately invited a class from Connect is the case that
        // would need it, and that is a question for the CTO rather than a
        // guess made here.
        try { await ConnectCalendarMirror.CancelAsync(db, meeting.Id, ct); }
        catch (Exception ex)
        {
            logs.CreateLogger(typeof(OrgMeetingApiEndpoints)).LogWarning(
                ex, "Meeting {MeetingId} was cancelled but its calendar entry was not removed.", meeting.Id);
        }

        await audit.WriteAsync("org.api_meeting_cancelled", "org_api_key", caller.KeyId.ToString(),
            after: new { meetingId = meeting.Id, from = OrgApiAuth.ClientAddress(http) }, ct: ct);

        return Results.NoContent();
    }

    // ==================================================================
    //  Shared
    // ==================================================================

    /// <summary>
    /// A person in THIS organisation, by address. Tenant scope is already
    /// entered, so row-level security is what keeps one customer's ERP from
    /// naming another customer's teacher — not a filter written here that
    /// could be forgotten on the next query.
    /// </summary>
    private static async Task<User?> FindPersonAsync(AppDbContext db, string? email, CancellationToken ct)
    {
        var address = (email ?? "").Trim().ToLowerInvariant();
        if (address.Length == 0) return null;
        return await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Email == address && u.Status == "active", ct);
    }

    /// <summary>
    /// The organisation API's own shape. Deliberately not Connect's: an ERP
    /// integrator should not have to learn share policies, chat policies,
    /// minutes or modes to put a class on a timetable, and every field
    /// published here is one that can never quietly change meaning.
    /// </summary>
    private static object Shape(ConnectMeeting m, User? host, bool full) => new
    {
        id = m.Id,
        m.Code,
        joinUrl = ConnectEndpoints.JoinUrlOf(m),
        m.Title,
        m.Status,
        startsAt = m.ScheduledStart,
        endsAt = m.ScheduledEnd,
        m.Timezone,
        // `full` is the schedule scope. The join scope gets the teacher's
        // name, which is what a class shows a student, and nothing that
        // identifies an account.
        host = host is null ? null
             : full ? (object)new { host.Id, email = host.Email, name = host.DisplayName }
             : new { name = host.DisplayName },
        m.WaitingRoom,
        m.AllowGuests,
        needsPassword = m.PasswordHash != null,
        // True whenever the meeting has a time: ConnectCalendarMirror puts it
        // on the host's calendar as part of creating it. Reported rather than
        // assumed by the caller, so that if it ever stops being true the
        // response says so instead of the ERP believing it.
        onCalendar = m.ScheduledStart != null,
    };

    private static IResult NotFound() =>
        Results.Json(new { error = "No such meeting in this organisation." }, statusCode: 404);
}

/// <summary>
/// What an ERP sends to schedule a class.
///
/// NO mode, share policy, chat policy or minutes setting. Those are meeting
/// controls a host changes in the room, and the mode in particular can never
/// be changed once set — the smallest surface that does the job is the one
/// that can grow later without breaking anybody.
/// </summary>
public sealed record ScheduleMeetingRequest(
    string? HostEmail,
    string? Title,
    DateTimeOffset? StartsAt,
    DateTimeOffset? EndsAt,
    string? Timezone,
    string? WaitingRoom,
    bool? AllowGuests,
    string? Password);


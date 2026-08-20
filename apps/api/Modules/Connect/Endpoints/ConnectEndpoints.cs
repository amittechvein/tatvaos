using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// TatvaOS Connect — meetings.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE LIVEKIT SECRET NEVER LEAVES THE SERVER.
///
///  Every path that hands a browser the ability to join goes through
///  LiveKitTokenService, which mints a short-lived token scoped to ONE room,
///  and only after this file has decided the caller may be in that room. The
///  meeting code is a doorstep, not a key.
///
///  VISIBILITY IS RLS; PERMISSION IS HERE. A meeting the caller cannot see is
///  a 404 — never a 403, which would confirm it exists. A meeting they can see
///  but may not command is a 403. Same division Space uses.
///
///  THE GUEST PATH HAS ONE FAILURE ANSWER. Unknown code, malformed code,
///  cancelled meeting, guests disabled on the meeting, guests disabled for the
///  organisation, suspended tenant — all of them are the same 404 with the
///  same sentence. Anything else is an oracle: a way to ask our server whether
///  an organisation exists and holds meetings.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectEndpoints
{
    public static void MapConnectEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect")
            .RequireAuthorization("User")
            .WithTags("Connect");

        g.MapGet("/meetings", ListMeetingsAsync);
        g.MapPost("/meetings", CreateMeetingAsync);
        // BEFORE the {id:guid} route, and constrained, so "by-code" can never
        // be read as an id. It is only unambiguous because :guid rejects it —
        // an unconstrained {id} route would swallow this path instead.
        g.MapGet("/meetings/by-code/{code}", GetByCodeAsync);
        g.MapGet("/meetings/{id:guid}", GetMeetingAsync);
        g.MapPatch("/meetings/{id:guid}", UpdateMeetingAsync);
        g.MapDelete("/meetings/{id:guid}", CancelMeetingAsync);

        g.MapGet("/meetings/{id:guid}/participants", ListParticipantsAsync);
        g.MapPost("/meetings/{id:guid}/join", JoinAsync);

        g.MapGet("/meetings/{id:guid}/lobby", ListLobbyAsync);
        g.MapPost("/meetings/{id:guid}/lobby/{requestId:guid}/admit", AdmitAsync);
        g.MapPost("/meetings/{id:guid}/lobby/{requestId:guid}/deny", DenyAsync);

        g.MapPost("/meetings/{id:guid}/participants/{identity}/mute", MuteAsync);
        g.MapDelete("/meetings/{id:guid}/participants/{identity}", RemoveAsync);
        g.MapPut("/meetings/{id:guid}/participants/{identity}/role", SetRoleAsync);
        // Handing the meeting itself to somebody else — distinct from /role,
        // which deliberately refuses 'host'. Two different acts: /role shares
        // the controls, this one gives them away.
        g.MapPost("/meetings/{id:guid}/host", TransferHostAsync);
        g.MapPost("/meetings/{id:guid}/end", EndAsync);
    }

    // ==================================================================
    //  Shapes
    // ==================================================================
    public sealed record CreateMeetingRequest(
        string? Title, string? Kind,
        DateTimeOffset? ScheduledStart, DateTimeOffset? ScheduledEnd,
        string? Timezone, string? Password, string? WaitingRoom, bool? AllowGuests,
        bool? AutoRecord, string? SharePolicy, string? Mode);

    // ── NO Mode FIELD HERE, AND IT MUST STAY THAT WAY. ───────────────────
    // The mode is chosen once and cannot change: a host who could flip
    // 'private' to 'recorded' mid-meeting would make recordable a
    // conversation people joined believing it could not be. Its absence from
    // this record is the first lock; a trigger on connect.meetings is the one
    // that still holds if somebody adds the field back without knowing why it
    // was missing (20260908-connect-meeting-mode.sql).
    public sealed record UpdateMeetingRequest(
        string? Title, DateTimeOffset? ScheduledStart, DateTimeOffset? ScheduledEnd,
        string? Timezone, string? Password, string? WaitingRoom,
        bool? AllowGuests, bool? Locked, bool? AutoRecord, string? SharePolicy);

    public sealed record JoinRequest(string? Password);
    public sealed record MuteRequest(string? Kind);
    public sealed record RoleRequest(string? Role);
    public sealed record TransferHostRequest(string? Identity);

    private const string PublicBase = "https://connect.tatvaos.com";

    private static object Shape(ConnectMeeting m, string? myRole) => new
    {
        m.Id,
        m.Code,
        joinUrl = $"{PublicBase}/connect/room/{m.Code}",
        m.Title,
        m.Kind,
        m.Status,
        m.ScheduledStart,
        m.ScheduledEnd,
        m.Timezone,
        m.StartedAt,
        m.EndedAt,
        hasPassword = m.PasswordHash is not null,
        m.WaitingRoom,
        m.AllowGuests,
        m.Locked,
        m.AutoRecord,
        m.SharePolicy,
        m.Mode,
        m.CreatedByUserId,
        myRole,
        m.CreatedAt,
        m.UpdatedAt,
    };

    // ==================================================================
    //  Listing and reading
    // ==================================================================
    private static async Task<IResult> ListMeetingsAsync(
        string? range, int? page, int? pageSize,
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var take = Math.Clamp(pageSize ?? 50, 1, 200);
        var skip = Math.Max(0, (Math.Max(1, page ?? 1) - 1) * take);
        var which = (range ?? "upcoming").Trim().ToLowerInvariant();
        if (which is not ("upcoming" or "today" or "past"))
            return Results.BadRequest(new { error = "Ask for upcoming, today or past." });

        // Meetings I created, or ones I am on the participant list of. RLS has
        // already limited this to my tenant; this narrows it to me.
        var mineIds = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.UserId == uid)
            .Select(p => p.MeetingId)
            .ToListAsync(ct);

        var all = db.ConnectMeetings.AsNoTracking()
            .Where(m => m.CreatedByUserId == uid || mineIds.Contains(m.Id));

        var now = DateTimeOffset.UtcNow;
        all = which switch
        {
            // Live meetings first, then what is coming. A meeting happening
            // right now is the thing the person most likely wants.
            "upcoming" => all.Where(m => m.Status == "active"
                                      || (m.Status == "scheduled"
                                          && (m.ScheduledStart == null || m.ScheduledStart >= now.AddHours(-2)))),
            "today" => all.Where(m => m.ScheduledStart != null
                                   && m.ScheduledStart >= now.Date
                                   && m.ScheduledStart < now.Date.AddDays(1)),
            _ => all.Where(m => m.Status == "ended" || m.Status == "cancelled"),
        };

        var total = await all.CountAsync(ct);
        var rows = which == "past"
            ? await all.OrderByDescending(m => m.EndedAt ?? m.CreatedAt).Skip(skip).Take(take).ToListAsync(ct)
            : await all.OrderBy(m => m.ScheduledStart ?? m.CreatedAt).Skip(skip).Take(take).ToListAsync(ct);

        var roles = await RolesForAsync(db, uid, rows.Select(r => r.Id).ToList(), ct);
        return Results.Ok(new
        {
            meetings = rows.Select(m => Shape(m, roles.GetValueOrDefault(m.Id))).ToList(),
            page = Math.Max(1, page ?? 1),
            pageSize = take,
            total,
        });
    }

    private static async Task<IResult> GetMeetingAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();

        var role = await RoleOfAsync(db, meeting.Id, uid, ct);
        return Results.Ok(Shape(meeting, role));
    }

    /// <summary>
    /// Resolve a meeting CODE for somebody who is signed in.
    ///
    /// A shareable link carries the code, never the id — so a colleague who
    /// clicks one arrives at /connect/room/{code} holding the wrong kind of
    /// handle for every authenticated route, all of which key on the id. This
    /// closes that gap and is the only reason it exists.
    ///
    /// It is NOT the guest doorstep and must not grow into it. This route is
    /// inside the authorised group, so RLS scopes it to the caller's own
    /// organisation: a code belonging to another tenant is simply not visible
    /// and answers 404 — the same answer as a code that never existed, which
    /// is what keeps it from becoming an oracle. Guests continue to use
    /// /api/connect/g/{code}, which applies the guest predicate (allow_guests,
    /// the org kill-switch, tenant status) that this deliberately does not.
    /// </summary>
    private static async Task<IResult> GetByCodeAsync(
        string code, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        // Shape check first, so a scanner costs no query — the same order the
        // guest path uses, and what keeps its rate limit meaningful.
        if (!ConnectCodes.IsWellFormed(code)) return NotFound();

        var meeting = await db.ConnectMeetings
            .Where(m => m.Code == code)
            .FirstOrDefaultAsync(ct);
        if (meeting is null) return NotFound();

        var role = await RoleOfAsync(db, meeting.Id, uid, ct);
        return Results.Ok(Shape(meeting, role));
    }

    private static async Task<IResult> ListParticipantsAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await FindAsync(db, id, ct) is null) return NotFound();

        var people = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == id)
            .OrderBy(p => p.DisplayName)
            .ToListAsync(ct);

        // "Connected" is DERIVED, never stored: the last event for this
        // identity decides. A running flag would be wrong the moment a webhook
        // is missed, and could not answer "how many times did she rejoin".
        var events = await db.ConnectMeetingEvents.AsNoTracking()
            .Where(e => e.MeetingId == id && e.Identity != null)
            .OrderBy(e => e.OccurredAt)
            .ToListAsync(ct);

        var connected = new Dictionary<string, bool>();
        foreach (var e in events)
        {
            if (e.Identity is null) continue;
            if (e.Kind == "participant_joined") connected[e.Identity] = true;
            else if (e.Kind == "participant_left") connected[e.Identity] = false;
        }

        return Results.Ok(new
        {
            participants = people.Select(p => new
            {
                p.Identity,
                p.DisplayName,
                p.Role,
                p.IsGuest,
                connected = connected.GetValueOrDefault(p.Identity),
                p.FirstJoinedAt,
                p.LastSeenAt,
            }).ToList(),
        });
    }

    // ==================================================================
    //  Creating and changing
    // ==================================================================
    private static async Task<IResult> CreateMeetingAsync(
        CreateMeetingRequest req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, ConnectRoomKey roomKeys, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var title = string.IsNullOrWhiteSpace(req.Title) ? "Meeting" : req.Title.Trim();
        if (title.Length > 200) return Results.BadRequest(new { error = "That title is too long." });

        var kind = (req.Kind ?? "instant").Trim().ToLowerInvariant();
        if (kind is not ("instant" or "scheduled"))
            return Results.BadRequest(new { error = "A meeting is either instant or scheduled." });
        if (kind == "scheduled" && req.ScheduledStart is null)
            return Results.BadRequest(new { error = "A scheduled meeting needs a start time." });
        if (req.ScheduledStart is DateTimeOffset s && req.ScheduledEnd is DateTimeOffset e && e < s)
            return Results.BadRequest(new { error = "The meeting cannot end before it starts." });

        var waiting = (req.WaitingRoom ?? "guests").Trim().ToLowerInvariant();
        if (waiting is not ("everyone" or "guests" or "off"))
            return Results.BadRequest(new { error = "Unknown waiting-room setting." });

        if (req.Password is { Length: > 0 } p && (p.Length < 4 || p.Length > 100))
            return Results.BadRequest(new { error = "A meeting password is between 4 and 100 characters." });

        var share = (req.SharePolicy ?? ConnectShare.PolicyEveryone).Trim().ToLowerInvariant();
        if (!ConnectShare.IsValidPolicy(share))
            return Results.BadRequest(new { error = "Sharing is open to the host, the host and co-hosts, or everyone." });

        // ── THE MODE. The only place it is ever set. ─────────────────────
        var mode = (req.Mode ?? ConnectModes.Recorded).Trim().ToLowerInvariant();
        if (!ConnectModes.IsValid(mode))
            return Results.BadRequest(new { error = "A meeting is either recorded or private." });

        // A server with no room-key secret cannot encrypt anything, so it says
        // so rather than creating a meeting labelled private that is not.
        // Recorded meetings are unaffected — this is a per-feature refusal,
        // the same shape as recording being off.
        if (mode == ConnectModes.Private && !roomKeys.IsConfigured)
            return Results.Json(new
            {
                error = "Private meetings are not switched on for this server. "
                      + "An administrator can enable them.",
            }, statusCode: 503);

        // The database refuses this combination too (meetings_private_no_autorecord).
        // Refusing it HERE is what makes a person meet a sentence instead of a
        // 23514: the constraint is the backstop, not the user interface.
        var autoRecord = req.AutoRecord ?? false;
        if (mode == ConnectModes.Private && autoRecord)
            return Results.BadRequest(new { error = ConnectModes.MediaRefusal });

        var meeting = new ConnectMeeting
        {
            TenantId = tenant.TenantId,
            Code = ConnectCodes.New(),
            Title = title,
            CreatedByUserId = uid,
            Kind = kind,
            ScheduledStart = req.ScheduledStart,
            ScheduledEnd = req.ScheduledEnd,
            Timezone = string.IsNullOrWhiteSpace(req.Timezone) ? "Asia/Kolkata" : req.Timezone.Trim(),
            Status = "scheduled",
            PasswordHash = string.IsNullOrEmpty(req.Password) ? null : hasher.Hash(req.Password),
            WaitingRoom = waiting,
            AllowGuests = req.AllowGuests ?? true,
            // A request, not a bypass — the room_started webhook re-checks the
            // org's recording flag and the storage gate when the room actually
            // starts. Accepted here even if recording is off right now, because
            // "on for the org by Monday's meeting" is a normal sequence.
            AutoRecord = autoRecord,
            SharePolicy = share,
            Mode = mode,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ConnectMeetings.Add(meeting);

        // The creator is the host, and is a participant from the start so the
        // meeting appears in their list before anyone has joined anything.
        db.ConnectParticipants.Add(new ConnectParticipant
        {
            Id = Guid.NewGuid(),
            MeetingId = meeting.Id,
            UserId = uid,
            DisplayName = await NameOfAsync(db, uid, ct),
            Role = "host",
            IsGuest = false,
            Identity = ConnectCodes.IdentityForUser(uid),
            CreatedAt = DateTimeOffset.UtcNow,
        });

        await db.SaveChangesAsync(ct);
        // The mode is in the audit row because "was this meeting recordable"
        // is a question somebody will ask months later, and the row is the
        // only place that can still answer it.
        await audit.WriteAsync("connect.meeting.created", "connect.meeting", meeting.Id.ToString(),
            after: new { meeting.Title, meeting.Kind, meeting.ScheduledStart, meeting.Mode },
            ct: ct, productCode: "connect");

        return Results.Created($"/api/connect/meetings/{meeting.Id}", Shape(meeting, "host"));
    }

    private static async Task<IResult> UpdateMeetingAsync(
        Guid id, UpdateMeetingRequest req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, LiveKitRoomClient rooms, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();

        var role = await RoleOfAsync(db, id, uid, ct);
        if (role is not ("host" or "cohost")) return Forbidden();
        if (meeting.Status is "ended" or "cancelled")
            return Results.Conflict(new { error = "That meeting is over." });

        if (req.Title is { } t)
        {
            var title = t.Trim();
            if (title.Length is 0 or > 200)
                return Results.BadRequest(new { error = "Give the meeting a title of up to 200 characters." });
            meeting.Title = title;
        }
        if (req.ScheduledStart is not null) meeting.ScheduledStart = req.ScheduledStart;
        if (req.ScheduledEnd is not null) meeting.ScheduledEnd = req.ScheduledEnd;
        if (meeting.ScheduledStart is DateTimeOffset ss && meeting.ScheduledEnd is DateTimeOffset ee && ee < ss)
            return Results.BadRequest(new { error = "The meeting cannot end before it starts." });

        if (!string.IsNullOrWhiteSpace(req.Timezone)) meeting.Timezone = req.Timezone.Trim();

        var waitingChanged = false;
        if (req.WaitingRoom is { } w)
        {
            var waiting = w.Trim().ToLowerInvariant();
            if (waiting is not ("everyone" or "guests" or "off"))
                return Results.BadRequest(new { error = "Unknown waiting-room setting." });
            waitingChanged = waiting != meeting.WaitingRoom;
            meeting.WaitingRoom = waiting;
        }
        if (req.AllowGuests is bool ag) meeting.AllowGuests = ag;

        // A password of "" clears it; null leaves it alone. Two different
        // intentions, and conflating them is how a password silently survives
        // an edit that meant to remove it.
        if (req.Password is not null)
        {
            if (req.Password.Length == 0) meeting.PasswordHash = null;
            else if (req.Password.Length is < 4 or > 100)
                return Results.BadRequest(new { error = "A meeting password is between 4 and 100 characters." });
            else meeting.PasswordHash = hasher.Hash(req.Password);
        }

        var lockChanged = req.Locked is bool l && l != meeting.Locked;
        if (req.Locked is bool lk) meeting.Locked = lk;

        // Auto-record on a private meeting is refused in words. Without this
        // the database's CHECK would answer instead, and a person would meet
        // a 500 carrying SQLSTATE 23514 rather than a sentence.
        if (req.AutoRecord is bool ar)
        {
            if (ar && !meeting.MediaIsReadable)
                return Results.BadRequest(new { error = ConnectModes.MediaRefusal });
            meeting.AutoRecord = ar;
        }

        var shareChanged = false;
        if (req.SharePolicy is { } sp)
        {
            var share = sp.Trim().ToLowerInvariant();
            if (!ConnectShare.IsValidPolicy(share))
                return Results.BadRequest(new { error = "Sharing is open to the host, the host and co-hosts, or everyone." });
            shareChanged = share != meeting.SharePolicy;
            meeting.SharePolicy = share;
        }

        meeting.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        if (lockChanged)
            await audit.WriteAsync(meeting.Locked ? "connect.meeting.locked" : "connect.meeting.unlocked",
                "connect.meeting", meeting.Id.ToString(), ct: ct, productCode: "connect");

        // ── A POLICY CHANGE REACHES THE ROOM, NOT JUST THE NEXT JOINER. ────
        //
        // Tokens already minted cannot be recalled, so everyone currently
        // connected is re-permissioned through UpdateParticipant. Best effort,
        // after the save: the row is the truth and the next join reads it; a
        // LiveKit hiccup here costs one participant the live update, and they
        // pick up the policy on their next token. Roles come from OUR rows,
        // never from what LiveKit believes.
        if (shareChanged)
        {
            var present = await rooms.TryListParticipantsAsync(id, ct);
            if (present is { Count: > 0 })
            {
                var roles = await db.ConnectParticipants.AsNoTracking()
                    .Where(p => p.MeetingId == id)
                    .Select(p => new { p.Identity, p.Role })
                    .ToListAsync(ct);
                var roleOf = roles.ToDictionary(r => r.Identity, r => r.Role);

                foreach (var person in present)
                {
                    if (person.Identity is not { Length: > 0 } who) continue;
                    var sources = ConnectShare.SourcesFor(
                        meeting.SharePolicy, roleOf.GetValueOrDefault(who));
                    await rooms.SetPublishSourcesAsync(id, who, sources, ct);
                }
            }
            await audit.WriteAsync("connect.meeting.share_policy", "connect.meeting",
                meeting.Id.ToString(), after: new { meeting.SharePolicy },
                ct: ct, productCode: "connect");
        }

        // ── OPENING THE DOOR REACHES THE PEOPLE ALREADY AT IT. ─────────────
        //
        // The setting was PATCHable before this block existed, but a change
        // only governed the NEXT knock: everyone already parked kept polling
        // "waiting" forever, because the wait loop frees a person only when
        // their lobby row says 'admitted'. A host who turns the waiting room
        // off mid-meeting means "stop making people wait" — including the
        // people currently waiting — so the rows the new setting would no
        // longer park are admitted here, through the SAME status machine the
        // Admit button drives. No new path for the guest: their next poll
        // claims the one-shot admission exactly as if the host had clicked.
        //
        // Three deliberate edges:
        //   · 'everyone' → 'guests' frees only COLLEAGUES (rows with a
        //     user_id); guests are exactly whom 'guests' still parks.
        //   · A REMOVED colleague stays parked. Removed means removed —
        //     DecideAsync refuses to admit them by hand, and a bulk admit
        //     must not be the back door. They are left 'waiting', not
        //     denied: the toggle is not a decision about a person.
        //   · The same 30-minute cutoff as ListLobbyAsync, so this admits
        //     precisely the people the host could see waiting — never a
        //     stale token from someone who knocked and left an hour ago.
        if (waitingChanged)
        {
            var released = 0;
            if (meeting.WaitingRoom is "off" or "guests")
            {
                var cutoff = DateTimeOffset.UtcNow.AddMinutes(-30);
                var parked = await db.ConnectLobbyRequests
                    .Where(r => r.MeetingId == id && r.Status == "waiting" && r.CreatedAt > cutoff)
                    .ToListAsync(ct);
                var freeable = meeting.WaitingRoom == "off"
                    ? parked
                    : parked.Where(r => r.UserId is not null).ToList();
                if (freeable.Count > 0)
                {
                    // KNOWN PROPERTY (review finding, accepted, no change):
                    // blocks are keyed by user_id, so a GUEST cannot be
                    // blocked — "remove" never sticks for a guest, whose only
                    // control is the waiting room itself. Turning the room
                    // 'off' therefore frees a previously-removed guest along
                    // with everyone else. That is inherent to what 'off'
                    // means — anyone with the link walks in — and it predates
                    // this block; the toggle just makes it visible for the
                    // first time. If "remove sticks for guests" is ever
                    // wanted, it needs a block keyed on something a guest
                    // actually has, which is a design question, not a fix
                    // here.
                    var blockedIds = await db.ConnectMeetingBlocks.AsNoTracking()
                        .Where(b => b.MeetingId == id)
                        .Select(b => b.UserId)
                        .ToListAsync(ct);
                    foreach (var request in freeable)
                    {
                        if (request.UserId is Guid parkedUid && blockedIds.Contains(parkedUid)) continue;
                        request.Status = "admitted";
                        request.DecidedByUserId = uid;
                        request.DecidedAt = DateTimeOffset.UtcNow;
                        released++;
                    }
                    await db.SaveChangesAsync(ct);
                }
            }
            // The count is in the audit row because "who let these people in"
            // has an answer — the host who changed the setting — and it should
            // be findable without diffing lobby rows against a clock.
            await audit.WriteAsync("connect.meeting.waiting_room", "connect.meeting",
                meeting.Id.ToString(), after: new { meeting.WaitingRoom, released },
                ct: ct, productCode: "connect");
        }

        return Results.Ok(Shape(meeting, role));
    }

    private static async Task<IResult> CancelMeetingAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) != "host") return Forbidden();

        // Ending a LIVE meeting is /end — a different intent, with different
        // consequences for the people currently in it.
        if (meeting.Status == "active")
            return Results.Conflict(new { error = "That meeting is running. End it for everyone instead." });
        if (meeting.Status is "ended" or "cancelled") return Results.NoContent();

        meeting.Status = "cancelled";
        meeting.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("connect.meeting.cancelled", "connect.meeting", meeting.Id.ToString(),
            ct: ct, productCode: "connect");
        return Results.NoContent();
    }

    // ==================================================================
    //  Joining — the token mint for people with an account
    // ==================================================================
    private static async Task<IResult> JoinAsync(
        Guid id, JoinRequest? req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, LiveKitTokenService tokens, ConnectRoomKey roomKeys,
        CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!tokens.IsConfigured)
            return Results.Problem("Connect is not configured on this server.", statusCode: 503);

        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();
        if (meeting.Status is "ended" or "cancelled")
            return Results.Conflict(new { error = "That meeting is over." });

        var role = await RoleOfAsync(db, id, uid, ct);
        var isHost = role is "host" or "cohost";

        // Removed means removed. Checked before the lock and the password so a
        // blocked person learns nothing about either. 403 with a plain
        // sentence, not 404: they were IN this meeting, so its existence is
        // not a secret from them, and "the link is broken" would send them to
        // the host asking for a new link that will not work either.
        if (!isHost)
        {
            var blocked = await db.ConnectMeetingBlocks.AsNoTracking()
                .AnyAsync(x => x.MeetingId == id && x.UserId == uid, ct);
            if (blocked)
                return Results.Json(
                    new { error = "The host removed you from this meeting." }, statusCode: 403);
        }

        // A lock keeps latecomers out; it must not lock the host out of their
        // own meeting.
        if (meeting.Locked && !isHost)
            return Results.Conflict(new { error = "This meeting is locked." });

        if (meeting.PasswordHash is { } hash && !isHost)
        {
            if (string.IsNullOrEmpty(req?.Password) || !hasher.Verify(req.Password, hash))
                return Results.StatusCode(403);
        }

        var identity = ConnectCodes.IdentityForUser(uid);
        var participant = await db.ConnectParticipants
            .Where(p => p.MeetingId == id && p.UserId == uid)
            .FirstOrDefaultAsync(ct);

        if (participant is null)
        {
            participant = new ConnectParticipant
            {
                Id = Guid.NewGuid(),
                MeetingId = id,
                UserId = uid,
                DisplayName = await NameOfAsync(db, uid, ct),
                Role = "participant",
                IsGuest = false,
                Identity = identity,
                CreatedAt = DateTimeOffset.UtcNow,
            };
            db.ConnectParticipants.Add(participant);
            await db.SaveChangesAsync(ct);
            role = "participant";
        }

        // waiting_room = 'everyone' parks colleagues too — except the people
        // who would have to admit them.
        if (meeting.WaitingRoom == "everyone" && !isHost)
        {
            var (waitToken, _) = await ParkAsync(db, id, uid, participant.DisplayName, ct);
            return Results.Ok(new { status = "waiting", waitToken });
        }

        return Results.Ok(new
        {
            status = "joined",
            token = tokens.MintJoinToken(new LiveKitGrantOptions(
                ConnectCodes.RoomName(id), identity, participant.DisplayName, RoomAdmin: isHost,
                // The share policy, decided here from the role in OUR row.
                // null = all sources; ["camera","microphone"] keeps them off
                // screen share without touching their face or voice.
                CanPublishSources: ConnectShare.SourcesFor(meeting.SharePolicy, role))),
            wsUrl = tokens.PublicUrl,
            identity,
            role = role ?? "participant",
            meeting.Mode,
            // ── THE MEDIA KEY, and only for a private meeting. ───────────
            // Null on a recorded meeting: absent rather than unused, so a
            // client cannot silently encrypt a room the server expects to be
            // able to record. It rides this one response and dies with the
            // tab — it is never logged, never audited, never in a webhook.
            roomKey = meeting.MediaIsReadable ? null : roomKeys.For(id),
        });
    }

    // ==================================================================
    //  The waiting room, host side
    // ==================================================================
    private static async Task<IResult> ListLobbyAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await FindAsync(db, id, ct) is null) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost")) return Forbidden();

        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-30);
        var waiting = await db.ConnectLobbyRequests.AsNoTracking()
            .Where(r => r.MeetingId == id && r.Status == "waiting" && r.CreatedAt > cutoff)
            .OrderBy(r => r.CreatedAt)
            .ToListAsync(ct);

        return Results.Ok(new
        {
            waiting = waiting.Select(r => new
            {
                requestId = r.Id,
                r.DisplayName,
                isGuest = r.UserId is null,
                requestedAt = r.CreatedAt,
            }).ToList(),
        });
    }

    private static Task<IResult> AdmitAsync(
        Guid id, Guid requestId, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
        => DecideAsync(id, requestId, "admitted", db, tenant, audit, ct);

    private static Task<IResult> DenyAsync(
        Guid id, Guid requestId, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
        => DecideAsync(id, requestId, "denied", db, tenant, audit, ct);

    private static async Task<IResult> DecideAsync(
        Guid id, Guid requestId, string decision, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await FindAsync(db, id, ct) is null) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost")) return Forbidden();

        var request = await db.ConnectLobbyRequests
            .Where(r => r.Id == requestId && r.MeetingId == id)
            .FirstOrDefaultAsync(ct);
        if (request is null) return NotFound();

        // Idempotent: a host double-clicking Admit must not be an error, and
        // must not un-deny someone.
        if (request.Status != "waiting") return Results.NoContent();

        // A removed person cannot be waved back in from the lobby. 409 with a
        // sentence rather than silently denying: the host clicked Admit and
        // deserves to know why nothing happened. (Guests carry no user_id and
        // are not blockable — for them the lobby itself is the control.)
        if (decision == "admitted" && request.UserId is Guid ruid)
        {
            var blocked = await db.ConnectMeetingBlocks.AsNoTracking()
                .AnyAsync(x => x.MeetingId == id && x.UserId == ruid, ct);
            if (blocked)
                return Results.Json(new
                {
                    error = "That person was removed from this meeting and cannot rejoin.",
                }, statusCode: 409);
        }

        request.Status = decision;
        request.DecidedByUserId = uid;
        request.DecidedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync($"connect.lobby.{decision}", "connect.meeting", id.ToString(),
            after: new { request.DisplayName, isGuest = request.UserId is null },
            ct: ct, productCode: "connect");
        return Results.NoContent();
    }

    // ==================================================================
    //  Host controls. Every one of them decides HERE, then asks LiveKit.
    // ==================================================================
    private static async Task<IResult> MuteAsync(
        Guid id, string identity, MuteRequest? req, AppDbContext db, TenantContext tenant,
        LiveKitRoomClient rooms, AuditWriter audit, CancellationToken ct)
    {
        var guard = await HostGuardAsync(db, tenant, id, identity, ct);
        if (guard is not null) return guard;

        // 'screen' stops a share without touching the person's camera — the
        // host control the share policy does not cover: policy says who MAY
        // share, this says "not this, not now".
        var kind = (req?.Kind ?? "audio").Trim().ToLowerInvariant();
        if (kind is not ("audio" or "video" or "screen"))
            return Results.BadRequest(new { error = "Mute audio, video, or a screen share." });

        if (!await rooms.MuteAsync(id, identity, kind, ct))
            return Results.Problem("The media server did not accept that.", statusCode: 502);

        await audit.WriteAsync("connect.participant.muted", "connect.meeting", id.ToString(),
            after: new { identity, kind }, ct: ct, productCode: "connect");
        return Results.NoContent();
    }

    private static async Task<IResult> RemoveAsync(
        Guid id, string identity, AppDbContext db, TenantContext tenant,
        LiveKitRoomClient rooms, AuditWriter audit, CancellationToken ct)
    {
        var guard = await HostGuardAsync(db, tenant, id, identity, ct);
        if (guard is not null) return guard;

        if (!await rooms.RemoveAsync(id, identity, ct))
            return Results.Problem("The media server did not accept that.", statusCode: 502);

        // Removal must survive the removal: a guest who is thrown out and
        // rejoins with the same link goes back to the waiting room rather than
        // straight into the meeting.
        var pending = await db.ConnectLobbyRequests
            .Where(r => r.MeetingId == id && r.Status == "admitted")
            .ToListAsync(ct);
        foreach (var r in pending) r.Status = "cancelled";

        // And removal must survive a REJOIN. The block row is what the join
        // path and the admit path read. Keyed on user_id — the only stable
        // handle; a guest's identity is minted fresh at every door, so for
        // guests the waiting room is the control and this row is audit only.
        // The host and any cohost are not blockable: /role and /host are how
        // their standing changes, not the Remove button.
        var removed = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == id && p.Identity == identity)
            .FirstOrDefaultAsync(ct);
        if (removed is not null && removed.Role == "participant")
        {
            var already = removed.UserId is Guid ruid
                && await db.ConnectMeetingBlocks.AsNoTracking()
                    .AnyAsync(x => x.MeetingId == id && x.UserId == ruid, ct);
            if (!already)
            {
                db.ConnectMeetingBlocks.Add(new ConnectMeetingBlock
                {
                    Id = Guid.NewGuid(),
                    MeetingId = id,
                    UserId = removed.UserId,
                    Identity = removed.Identity,
                    DisplayName = removed.DisplayName,
                    BlockedByUserId = tenant.UserId,
                    CreatedAt = DateTimeOffset.UtcNow,
                });
            }
        }
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("connect.participant.removed", "connect.meeting", id.ToString(),
            after: new { identity }, ct: ct, productCode: "connect");
        return Results.NoContent();
    }

    private static async Task<IResult> SetRoleAsync(
        Guid id, string identity, RoleRequest req, AppDbContext db, TenantContext tenant,
        LiveKitRoomClient rooms, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();

        // Promotion is the HOST's alone. A cohost who could appoint cohosts
        // could hand the meeting away.
        if (await RoleOfAsync(db, id, uid, ct) != "host") return Forbidden();

        var role = (req.Role ?? "").Trim().ToLowerInvariant();
        if (role is not ("cohost" or "participant"))
            return Results.BadRequest(new { error = "A person is either a cohost or a participant." });

        var person = await db.ConnectParticipants
            .Where(p => p.MeetingId == id && p.Identity == identity)
            .FirstOrDefaultAsync(ct);
        if (person is null) return NotFound();
        if (person.Role == "host")
            return Results.BadRequest(new { error = "The host cannot be demoted." });
        // A guest cannot hold controls: every control keys on user_id, and a
        // guest has none — a cohost who cannot actually call any host endpoint
        // is a title, not a role.
        if (role == "cohost" && person.UserId is null)
            return Results.BadRequest(new { error = "A guest cannot be a co-host." });

        person.Role = role;
        await db.SaveChangesAsync(ct);
        await audit.WriteAsync("connect.participant.role_changed", "connect.meeting", id.ToString(),
            after: new { identity, role }, ct: ct, productCode: "connect");

        // Server-side controls read the row and are correct immediately. The
        // one grant a role change moves NOW is publishing: under a 'cohost'
        // share policy, promotion should let them share this minute, not on
        // their next token. Best effort — the row is already the truth.
        await rooms.SetPublishSourcesAsync(id, identity,
            ConnectShare.SourcesFor(meeting.SharePolicy, role), ct);

        return Results.NoContent();
    }

    /// <summary>
    /// Hand the meeting to somebody else. This is the endpoint behind
    /// "Leave and assign a new host" — the dialog's other button is /end.
    ///
    /// Host only; the target must be a SIGNED-IN participant of this meeting.
    /// The old host becomes a cohost rather than a participant: they were
    /// trusted with the room a moment ago, and stripping every control on the
    /// way out serves nobody — the new host can demote them if it matters.
    /// </summary>
    private static async Task<IResult> TransferHostAsync(
        Guid id, TransferHostRequest req, AppDbContext db, TenantContext tenant,
        LiveKitRoomClient rooms, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) != "host") return Forbidden();

        var identity = (req.Identity ?? "").Trim();
        if (identity.Length == 0)
            return Results.BadRequest(new { error = "Say who the new host is." });

        var target = await db.ConnectParticipants
            .Where(p => p.MeetingId == id && p.Identity == identity)
            .FirstOrDefaultAsync(ct);
        if (target is null) return NotFound();
        if (target.UserId is null)
            return Results.BadRequest(new { error = "A guest cannot host a meeting." });
        if (target.UserId == uid)
            return Results.BadRequest(new { error = "You are already the host." });

        var me = await db.ConnectParticipants
            .Where(p => p.MeetingId == id && p.UserId == uid)
            .FirstOrDefaultAsync(ct);
        if (me is null) return Forbidden();

        // Both rows in ONE SaveChanges: a meeting with two hosts or none is
        // not a state that may exist between two commits.
        target.Role = "host";
        me.Role = "cohost";
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("connect.meeting.host_transferred", "connect.meeting", id.ToString(),
            after: new { from = me.Identity, to = target.Identity }, ct: ct, productCode: "connect");

        // Live publish grants for both, same best-effort rule as SetRoleAsync.
        await rooms.SetPublishSourcesAsync(id, target.Identity,
            ConnectShare.SourcesFor(meeting.SharePolicy, "host"), ct);
        await rooms.SetPublishSourcesAsync(id, me.Identity,
            ConnectShare.SourcesFor(meeting.SharePolicy, "cohost"), ct);

        return Results.NoContent();
    }

    private static async Task<IResult> EndAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        LiveKitRoomClient rooms, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var meeting = await FindAsync(db, id, ct);
        if (meeting is null) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost")) return Forbidden();

        if (!await rooms.EndAsync(id, ct))
            return Results.Problem("The media server did not accept that.", statusCode: 502);

        // ended_at is left for the room_finished webhook: the media server is
        // the authority on when the meeting actually stopped.
        meeting.Status = "ended";
        meeting.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("connect.meeting.ended", "connect.meeting", id.ToString(),
            ct: ct, productCode: "connect");
        return Results.NoContent();
    }

    // ==================================================================
    //  Helpers
    // ==================================================================
    private static IResult NotFound() => Results.NotFound(new { error = "That meeting does not exist." });
    private static IResult Forbidden() => Results.Json(
        new { error = "Only the host can do that." }, statusCode: 403);

    /// <summary>
    /// The person's own name, for the tile everyone else reads.
    ///
    /// This used to be the literal "Host" / "Participant". It shipped, and the
    /// organiser's own tile in a live meeting said "Host (you)" — a role where
    /// a name belongs. The name is copied onto the participant row at join
    /// time rather than joined at read time, deliberately: a guest has no user
    /// to join to, and attendance has to keep reading correctly years later
    /// even after somebody leaves the organisation and their row is gone.
    /// </summary>
    private static async Task<string> NameOfAsync(AppDbContext db, Guid userId, CancellationToken ct)
    {
        var name = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.DisplayName)
            .FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(name) ? "Someone" : name;
    }

    private static Task<ConnectMeeting?> FindAsync(AppDbContext db, Guid id, CancellationToken ct)
        => db.ConnectMeetings.Where(m => m.Id == id).FirstOrDefaultAsync(ct);

    private static async Task<string?> RoleOfAsync(AppDbContext db, Guid meetingId, Guid userId, CancellationToken ct)
    {
        var person = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == meetingId && p.UserId == userId)
            .FirstOrDefaultAsync(ct);
        return person?.Role;
    }

    private static async Task<Dictionary<Guid, string>> RolesForAsync(
        AppDbContext db, Guid userId, List<Guid> meetingIds, CancellationToken ct)
    {
        if (meetingIds.Count == 0) return new Dictionary<Guid, string>();
        var rows = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.UserId == userId && meetingIds.Contains(p.MeetingId))
            .ToListAsync(ct);
        return rows.ToDictionary(r => r.MeetingId, r => r.Role);
    }

    /// <summary>
    /// Park someone in the waiting room and hand back the plaintext wait
    /// token — the only time it exists. Only the SHA-256 is stored.
    /// </summary>
    internal static async Task<(string Token, Guid RequestId)> ParkAsync(
        AppDbContext db, Guid meetingId, Guid? userId, string displayName, CancellationToken ct)
    {
        var token = ConnectCodes.New();
        var request = new ConnectLobbyRequest
        {
            Id = Guid.NewGuid(),
            MeetingId = meetingId,
            UserId = userId,
            DisplayName = displayName,
            WaitTokenHash = ConnectCodes.HashToken(token),
            Status = "waiting",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.ConnectLobbyRequests.Add(request);
        await db.SaveChangesAsync(ct);
        return (token, request.Id);
    }

    private static async Task<IResult?> HostGuardAsync(
        AppDbContext db, TenantContext tenant, Guid meetingId, string identity, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(identity))
            return Results.BadRequest(new { error = "Name the participant." });
        if (await FindAsync(db, meetingId, ct) is null) return NotFound();
        if (await RoleOfAsync(db, meetingId, uid, ct) is not ("host" or "cohost")) return Forbidden();

        var exists = await db.ConnectParticipants.AsNoTracking()
            .AnyAsync(p => p.MeetingId == meetingId && p.Identity == identity, ct);
        return exists ? null : NotFound();
    }
}

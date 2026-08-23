using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// The guest path — the only unauthenticated route Connect ships, and the one
/// the brief says must not deploy without Core's line-by-line review (§8).
///
/// ─────────────────────────────────────────────────────────────────────────
///  ONE FAILURE ANSWER, ALWAYS.
///
///  Unknown code, malformed code, cancelled meeting, guests turned off on the
///  meeting, guests turned off for the whole organisation, suspended tenant —
///  every one of them is 404 with the SAME sentence. Never 403, never a
///  distinct message. Anything else turns this endpoint into an oracle: a way
///  for a stranger to ask our server which organisations exist and hold
///  meetings.
///
///  RLS CANNOT HELP HERE. A guest carries no JWT, so app.tenant_id is unset
///  and every ordinary query returns nothing. Rather than weaken a policy, the
///  first read goes through a SECURITY DEFINER function with a pinned
///  search_path — and NOTHING else is queried until the tenant it returns has
///  been pushed into TenantContext, after which normal RLS applies again.
///  That ordering is the whole safety argument; do not reorder it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectGuestEndpoints
{
    /// <summary>The only sentence this file ever says about a failure.</summary>
    private static IResult Gone() =>
        Results.NotFound(new { error = "This meeting link does not work." });

    /// <summary>
    /// Review finding F2: the rate limiter caps the RATE of guest joins, not
    /// the TOTAL — 60 a minute, indefinitely, was a waiting room nobody could
    /// empty and an attendance table full of rows that never attended. A
    /// blunt per-meeting ceiling bounds both. 200 is far above any real
    /// meeting on this deployment and far below "unbounded"; refusals say the
    /// one sentence, because a ceiling that answers differently is an oracle
    /// for how full a meeting is.
    /// </summary>
    private const int PerMeetingGuestCeiling = 200;

    public static void MapConnectGuestEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect/g")
            .RequireRateLimiting("connect-guest")
            .WithTags("Connect");

        g.MapGet("/{code}", DoorstepAsync).AllowAnonymous();
        g.MapPost("/{code}/join", GuestJoinAsync).AllowAnonymous();
        // Its OWN rate-limit policy, overriding the group's per-IP one (an
        // endpoint-level RequireRateLimiting takes precedence over its
        // group's). Review finding F1: this route polls every ~2 seconds per
        // waiting person, so per-IP limiting 429'd three guests behind one
        // office NAT out of their own admission. connect-wait partitions on
        // the wait-token hash instead — see the policy in Program.cs.
        g.MapGet("/wait/{waitToken}", WaitAsync)
            .RequireRateLimiting("connect-wait")
            .AllowAnonymous();
    }

    public sealed record GuestJoinRequest(string? DisplayName, string? Password);

    // Column aliases in the SQL below match these property names exactly, so
    // the mapping does not depend on a naming convention.
    private sealed record CodeRow(
        Guid MeetingId, Guid TenantId, string Title, string Status,
        DateTimeOffset? ScheduledStart, bool Locked, bool HasPassword, string WaitingRoom);

    private sealed record LobbyRow(
        Guid RequestId, Guid MeetingId, Guid TenantId, string Status, string DisplayName);

    private sealed record ClaimRow(
        Guid RequestId, Guid MeetingId, Guid TenantId, string DisplayName);

    private static async Task<CodeRow?> ResolveAsync(AppDbContext db, string code, CancellationToken ct)
    {
        // Shape check FIRST — garbage from a scanner is refused before it costs
        // a query, which is what keeps the rate limiter meaningful.
        if (!ConnectCodes.IsWellFormed(code)) return null;

        var rows = await db.Database
            .SqlQuery<CodeRow>($"""
                SELECT meeting_id      AS "MeetingId",
                       tenant_id       AS "TenantId",
                       title           AS "Title",
                       status          AS "Status",
                       scheduled_start AS "ScheduledStart",
                       locked          AS "Locked",
                       has_password    AS "HasPassword",
                       waiting_room    AS "WaitingRoom"
                  FROM connect.resolve_meeting_code({code})
                """)
            .ToListAsync(ct);
        return rows.FirstOrDefault();
    }

    // ==================================================================
    //  The doorstep. Costs nothing, counts nothing, changes nothing.
    // ==================================================================
    private static async Task<IResult> DoorstepAsync(
        string code, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        var row = await ResolveAsync(db, code, ct);
        if (row is null) return Gone();

        // The MODE, so the browser can refuse an encrypted meeting it cannot
        // decode BEFORE anybody mints a token — a sentence at the door beats a
        // black screen inside. Read the ordinary way, under the policy, after
        // the two-step scope change; resolve_meeting_code deliberately does not
        // return it, because widening a definer function's shape is a
        // migration that fights the one that owns it (the 20260816 trap).
        tenant.EnterAnonymousScope(row.TenantId, "guest");
        await db.SyncTenantAsync(ct);
        var mode = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == row.MeetingId)
            .Select(m => m.Mode)
            .FirstOrDefaultAsync(ct) ?? ConnectModes.Recorded;

        return Results.Ok(new
        {
            mode,
            row.Title,
            row.ScheduledStart,
            state = row.Status switch
            {
                "active" => "active",
                "ended" => "ended",
                _ => "not_started",
            },
            passwordRequired = row.HasPassword,
            row.Locked,
        });
    }

    // ==================================================================
    //  Guest join
    // ==================================================================
    private static async Task<IResult> GuestJoinAsync(
        string code, GuestJoinRequest req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, LiveKitTokenService tokens, ConnectRoomKey roomKeys,
        CancellationToken ct)
    {
        if (!tokens.IsConfigured)
            return Results.Problem("Connect is not configured on this server.", statusCode: 503);

        var name = (req.DisplayName ?? "").Trim();
        if (name.Length is 0 or > 100)
            return Results.BadRequest(new { error = "Give a name between 1 and 100 characters." });

        var row = await ResolveAsync(db, code, ct);
        if (row is null) return Gone();
        if (row.Status == "ended")
            return Results.Conflict(new { error = "That meeting is over." });
        if (row.Locked)
            return Results.Conflict(new { error = "This meeting is locked." });

        // From here on the request has a tenant, so ordinary RLS applies again
        // and everything below is scoped exactly as a signed-in request would
        // be. Role 'guest' is not an authorisation — nothing grants on it.
        tenant.EnterAnonymousScope(row.TenantId, "guest");
        // The C# scope is only half of it — app.tenant_id is what RLS reads,
        // and the connection opened for the definer lookup above carries none.
        // Without this the participant INSERT below is refused by the policy.
        await db.SyncTenantAsync(ct);

        // One read now that ordinary RLS applies: the password hash (verified
        // against the ROW, never against anything the definer function
        // returned — it reports only WHETHER one exists) and the share policy
        // the token below is minted under.
        var meeting = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == row.MeetingId)
            .Select(m => new { m.PasswordHash, m.SharePolicy, m.ChatPolicy, m.Mode })
            .FirstOrDefaultAsync(ct);
        if (meeting is null) return Gone();

        if (row.HasPassword)
        {
            if (meeting.PasswordHash is not { } hash) return Gone();

            // A wrong password after a VALID code answers 403, not 404: the
            // code-holder already knows the meeting exists, so a distinct
            // answer leaks nothing and lets a typo be corrected. Flagged for
            // Core in docs/CONNECT_API.md, open question 3.
            if (string.IsNullOrEmpty(req.Password) || !hasher.Verify(req.Password, hash))
                return Results.Json(new { error = "That password is not right." }, statusCode: 403);
        }

        // The ceilings, BEFORE any row is written (F2). Two counts, both under
        // ordinary RLS now that the tenant is entered: how many guest rows
        // this meeting already has, and how many people are actually waiting.
        // Either at the ceiling answers the one failure sentence.
        var guestRows = await db.ConnectParticipants.AsNoTracking()
            .CountAsync(p => p.MeetingId == row.MeetingId && p.IsGuest, ct);
        if (guestRows >= PerMeetingGuestCeiling) return Gone();

        if (row.WaitingRoom is "guests" or "everyone")
        {
            var cutoff = DateTimeOffset.UtcNow.AddMinutes(-30);
            var waitingRows = await db.ConnectLobbyRequests.AsNoTracking()
                .CountAsync(r => r.MeetingId == row.MeetingId
                              && r.Status == "waiting" && r.CreatedAt > cutoff, ct);
            if (waitingRows >= PerMeetingGuestCeiling) return Gone();
        }

        var participant = new ConnectParticipant
        {
            Id = Guid.NewGuid(),
            MeetingId = row.MeetingId,
            UserId = null,
            DisplayName = name,
            Role = "participant",
            IsGuest = true,
            Identity = "",
            CreatedAt = DateTimeOffset.UtcNow,
        };
        // Keyed to the participant row, not to the name: two people may both
        // be "Ravi", and a display name is not an identity.
        participant.Identity = ConnectCodes.IdentityForGuest(participant.Id);
        db.ConnectParticipants.Add(participant);
        await db.SaveChangesAsync(ct);

        // Guests wait unless the host has explicitly turned the waiting room
        // off. Defaulting the other way would mean a leaked link is a seat.
        if (row.WaitingRoom is "guests" or "everyone")
        {
            var (waitToken, _) = await ConnectEndpoints.ParkAsync(
                db, row.MeetingId, null, name, ct);
            return Results.Ok(new { status = "waiting", waitToken });
        }

        return Results.Ok(new
        {
            status = "joined",
            token = tokens.MintJoinToken(new LiveKitGrantOptions(
                ConnectCodes.RoomName(row.MeetingId), participant.Identity, name,
                // A guest is a 'participant' for the share policy — the same
                // rule a signed-in participant gets, read from the same column.
                CanPublishSources: ConnectShare.SourcesFor(meeting.SharePolicy, "participant"))),
            meeting.Mode,
            // A guest has no meeting row to read, so the one rule that governs
            // whether they may type has to travel with the token. Without it
            // the composer has nothing to go on and every guest gets the
            // permissive default — which is the wrong way for a setting whose
            // whole purpose is to close something.
            meeting.ChatPolicy,
            // A guest who passed the door is IN the room, so they get the key
            // like anybody else — a key withheld from the people the meeting
            // is for would be theatre, not security. Null on a recorded
            // meeting, and never logged. See ConnectRoomKey.
            roomKey = meeting.Mode == ConnectModes.Private ? roomKeys.For(row.MeetingId) : null,
            wsUrl = tokens.PublicUrl,
            identity = participant.Identity,
        });
    }

    // ==================================================================
    //  The park bench. Polled every couple of seconds while they wait.
    // ==================================================================
    private static async Task<IResult> WaitAsync(
        string waitToken, AppDbContext db, TenantContext tenant,
        LiveKitTokenService tokens, ConnectRoomKey roomKeys, CancellationToken ct)
    {
        if (!ConnectCodes.IsWellFormed(waitToken)) return Gone();
        var hash = ConnectCodes.HashToken(waitToken);

        var peeked = (await db.Database
            .SqlQuery<LobbyRow>($"""
                SELECT request_id   AS "RequestId",
                       meeting_id   AS "MeetingId",
                       tenant_id    AS "TenantId",
                       status       AS "Status",
                       display_name AS "DisplayName"
                  FROM connect.peek_lobby_request({hash})
                """)
            .ToListAsync(ct)).FirstOrDefault();

        if (peeked is null) return Gone();

        switch (peeked.Status)
        {
            case "waiting":
                return Results.Ok(new { status = "waiting" });

            case "denied":
                return Results.Ok(new { status = "denied" });

            case "admitted":
                if (!tokens.IsConfigured)
                    return Results.Problem("Connect is not configured on this server.", statusCode: 503);

                // THE UPDATE IS THE CHECK. Two polls racing cannot both be
                // handed a token, and an admission cannot be replayed into a
                // second seat once this one has been collected.
                var claimed = (await db.Database
                    .SqlQuery<ClaimRow>($"""
                        SELECT request_id   AS "RequestId",
                               meeting_id   AS "MeetingId",
                               tenant_id    AS "TenantId",
                               display_name AS "DisplayName"
                          FROM connect.claim_lobby_admission({hash})
                        """)
                    .ToListAsync(ct)).FirstOrDefault();

                if (claimed is null) return Gone();

                tenant.EnterAnonymousScope(claimed.TenantId, "guest");
                await db.SyncTenantAsync(ct);

                // A SIGNED-IN colleague lands here too: waiting_room =
                // 'everyone' parks colleagues, and they poll this same route.
                // The lookup used to assume IsGuest and answered Gone() to
                // every admitted colleague — so their admission read as "this
                // meeting link does not work". Their lobby row carries the
                // user_id; a guest's does not, and the display-name lookup is
                // only for them.
                var lobbyUser = await db.ConnectLobbyRequests.AsNoTracking()
                    .Where(r => r.Id == claimed.RequestId)
                    .Select(r => r.UserId)
                    .FirstOrDefaultAsync(ct);
                var person = lobbyUser is Guid parkedUid
                    ? await db.ConnectParticipants.AsNoTracking()
                        .Where(p => p.MeetingId == claimed.MeetingId && p.UserId == parkedUid)
                        .FirstOrDefaultAsync(ct)
                    : await db.ConnectParticipants.AsNoTracking()
                        .Where(p => p.MeetingId == claimed.MeetingId
                                 && p.IsGuest
                                 && p.DisplayName == claimed.DisplayName)
                        .FirstOrDefaultAsync(ct);
                if (person is null) return Gone();

                // The policy AT ADMISSION, not at the original knock — a host
                // who tightened sharing while this guest waited means it.
                var live = await db.ConnectMeetings.AsNoTracking()
                    .Where(m => m.Id == claimed.MeetingId)
                    .Select(m => new { m.SharePolicy, m.ChatPolicy, m.Mode })
                    .FirstOrDefaultAsync(ct);
                var sharePolicy = live?.SharePolicy ?? ConnectShare.PolicyEveryone;
                var mode = live?.Mode ?? ConnectModes.Recorded;
                // Same reasoning as the straight-through join above, and the
                // same "at admission, not at the knock" rule: a host who
                // closed chat while this guest waited meant it.
                var chatPolicy = live?.ChatPolicy ?? ConnectChat.PolicyEveryone;

                return Results.Ok(new
                {
                    status = "admitted",
                    token = tokens.MintJoinToken(new LiveKitGrantOptions(
                        ConnectCodes.RoomName(claimed.MeetingId), person.Identity, person.DisplayName,
                        CanPublishSources: ConnectShare.SourcesFor(sharePolicy, "participant"))),
                    wsUrl = tokens.PublicUrl,
                    identity = person.Identity,
                    mode,
                    chatPolicy,
                    roomKey = mode == ConnectModes.Private
                        ? roomKeys.For(claimed.MeetingId) : null,
                });

            // 'claimed' lands here too: the token was already collected, and
            // saying so would tell a thief their stolen token was once valid.
            default:
                return Gone();
        }
    }
}

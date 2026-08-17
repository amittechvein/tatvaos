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

    public static void MapConnectGuestEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect/g")
            .RequireRateLimiting("connect-guest")
            .WithTags("Connect");

        g.MapGet("/{code}", DoorstepAsync).AllowAnonymous();
        g.MapPost("/{code}/join", GuestJoinAsync).AllowAnonymous();
        g.MapGet("/wait/{waitToken}", WaitAsync).AllowAnonymous();
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
        string code, AppDbContext db, CancellationToken ct)
    {
        var row = await ResolveAsync(db, code, ct);
        if (row is null) return Gone();

        return Results.Ok(new
        {
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
        IPasswordHasher hasher, LiveKitTokenService tokens, CancellationToken ct)
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

        // The password is verified against the row, never against anything the
        // definer function returned: it reports only WHETHER one exists.
        if (row.HasPassword)
        {
            var meeting = await db.ConnectMeetings.AsNoTracking()
                .Where(m => m.Id == row.MeetingId)
                .FirstOrDefaultAsync(ct);
            if (meeting?.PasswordHash is not { } hash) return Gone();

            // A wrong password after a VALID code answers 403, not 404: the
            // code-holder already knows the meeting exists, so a distinct
            // answer leaks nothing and lets a typo be corrected. Flagged for
            // Core in docs/CONNECT_API.md, open question 3.
            if (string.IsNullOrEmpty(req.Password) || !hasher.Verify(req.Password, hash))
                return Results.Json(new { error = "That password is not right." }, statusCode: 403);
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
                ConnectCodes.RoomName(row.MeetingId), participant.Identity, name)),
            wsUrl = tokens.PublicUrl,
            identity = participant.Identity,
        });
    }

    // ==================================================================
    //  The park bench. Polled every couple of seconds while they wait.
    // ==================================================================
    private static async Task<IResult> WaitAsync(
        string waitToken, AppDbContext db, TenantContext tenant,
        LiveKitTokenService tokens, CancellationToken ct)
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
                var person = await db.ConnectParticipants.AsNoTracking()
                    .Where(p => p.MeetingId == claimed.MeetingId
                             && p.IsGuest
                             && p.DisplayName == claimed.DisplayName)
                    .FirstOrDefaultAsync(ct);
                if (person is null) return Gone();

                return Results.Ok(new
                {
                    status = "admitted",
                    token = tokens.MintJoinToken(new LiveKitGrantOptions(
                        ConnectCodes.RoomName(claimed.MeetingId), person.Identity, person.DisplayName)),
                    wsUrl = tokens.PublicUrl,
                    identity = person.Identity,
                });

            // 'claimed' lands here too: the token was already collected, and
            // saying so would tell a thief their stolen token was once valid.
            default:
                return Gone();
        }
    }
}

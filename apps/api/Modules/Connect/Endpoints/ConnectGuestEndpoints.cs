using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Auth;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
using TatvaOS.Api.Shared.Settings;
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
    ///
    /// 200 -> 2000, 19 Sept 2026, AND WHAT 200 COST. "Far above any real
    /// meeting" stopped being true the day Amit held a company-wide meeting.
    /// The count is of ROWS, and every guest join writes one - a reload, a
    /// dropped connection, a second device, each is a new row, because a guest
    /// has no identity to recognise them by. So a few dozen people reach 200
    /// well before 200 people do. From then on everybody new was told "This
    /// meeting link does not work" while the meeting was live, the door
    /// (GET /g/{code}) answered 200, and NOTHING anywhere said why: the host saw
    /// a working meeting and a stream of people who could not get in. It was
    /// found by reading this file, mid-meeting. The refusal keeps its one
    /// sentence for the stranger; it now also writes a WARNING for us, because a
    /// limit that fires silently is indistinguishable from a broken link.
    ///
    /// Still a ceiling, still blunt: the rate limiter caps the rate, this caps
    /// the total. Counting people rather than rows needs a guest identity that
    /// survives a reload, which does not exist yet.
    /// </summary>
    private const int PerMeetingGuestCeiling = 2000;

    public static void MapConnectGuestEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect/g")
            .RequireRateLimiting("connect-guest")
            .WithTags("Connect");

        g.MapGet("/{code}", DoorstepAsync).AllowAnonymous();
        g.MapPost("/{code}/join", GuestJoinAsync).AllowAnonymous();
        // Its OWN, much tighter policy: this one sends a text message.
        g.MapPost("/{code}/otp", GuestOtpAsync)
            .RequireRateLimiting("connect-guest-otp")
            .AllowAnonymous();
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

    /// <summary>Phone + Otp, or Pass, matter only while connect.guest_phone_otp is
    /// on. Optional so a client that has never heard of them (the mobile app's
    /// guest door, today) still binds - and is then told what is missing.</summary>
    public sealed record GuestJoinRequest(
        string? DisplayName, string? Password,
        string? Phone = null, string? Otp = null, string? Pass = null);

    public sealed record GuestOtpRequest(string? Phone);

    private static byte[] GuestSecret(IConfiguration config) =>
        ConnectGuestPhone.DeriveSecret(config["Jwt:SigningKey"]
            ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
            ?? throw new InvalidOperationException("JWT signing key is not configured."));

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
        string code, AppDbContext db, TenantContext tenant, SettingsReader settings, CancellationToken ct)
    {
        var row = await ResolveAsync(db, code, ct);
        if (row is null) return Gone();

        // Read BEFORE the tenant scope changes: platform settings are not a
        // tenant's. Told at the door so the page asks for the number up front
        // rather than refusing a name and then asking.
        var phoneRequired = await settings.FlagAsync(SettingKeys.ConnectGuestPhoneOtp, false, ct);

        // The MODE, so the browser can refuse an encrypted meeting it cannot
        // decode BEFORE anybody mints a token — a sentence at the door beats a
        // black screen inside. Read the ordinary way, under the policy, after
        // the two-step scope change; resolve_meeting_code deliberately does not
        // return it, because widening a definer function's shape is a
        // migration that fights the one that owns it (the 20260816 trap).
        // MINUTES, read in the same query as the mode, and for a related
        // reason: both are things a person should know BEFORE they join rather
        // than after.
        //
        // A signed-in colleague sees the minutes switch and the disclosure
        // beside it inside the room. A guest sees neither — they arrive by a
        // link, nobody asks them anything, and until now nobody told them
        // anything either. That gap gets wider the day guests are minuted too,
        // which is the decision of 26 August: their voice would be captioned
        // by their own browser, sent to Google by their own browser, and
        // written into a record, having been told none of it.
        //
        // Being told at the door is a choice. Being told once you are already
        // in the room and speaking is a notice. This is the cheap half of what
        // the consent sheet was for, and it costs nobody a queue.
        tenant.EnterAnonymousScope(row.TenantId, "guest");
        await db.SyncTenantAsync(ct);
        var meeting = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == row.MeetingId)
            .Select(m => new { m.Mode, m.MinutesLive })
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            mode = meeting?.Mode ?? ConnectModes.Recorded,
            // Defaults to FALSE when the row could not be read, which is the
            // safe direction for a claim rather than for a permission: the
            // door then says nothing instead of promising something untrue.
            // Nothing is enabled by this value — it is only ever a sentence.
            minutesLive = meeting?.MinutesLive ?? false,
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
            phoneRequired,
        });
    }

    // ==================================================================
    //  "Text me a code." Anonymous, so everything about it is a limit.
    //
    //  Always the same answer for a well-formed number, whether or not a text
    //  went: this route must not be a way to learn anything about a number.
    //  The one exception is "could not send", which the person needs in order
    //  to stop waiting for a text that is not coming.
    // ==================================================================
    private static async Task<IResult> GuestOtpAsync(
        string code, GuestOtpRequest req, AppDbContext db, TenantContext tenant,
        SettingsReader settings, ISmsSender sms, IConfiguration config,
        ILoggerFactory logs, CancellationToken ct)
    {
        var row = await ResolveAsync(db, code, ct);
        if (row is null) return Gone();
        if (!await settings.FlagAsync(SettingKeys.ConnectGuestPhoneOtp, false, ct)) return Gone();
        if (row.Status == "ended") return Results.Conflict(new { error = "That meeting is over." });
        if (row.Locked) return Results.Conflict(new { error = "This meeting is locked." });

        var e164 = ConnectGuestPhone.Normalise(req.Phone);
        if (e164 is null)
            return Results.BadRequest(new { error = "Give a 10-digit Indian mobile number." });

        var showOtp = await settings.FlagAsync(SettingKeys.ShowOtpOnScreen, false, ct);

        tenant.EnterAnonymousScope(row.TenantId, "guest");
        await db.SyncTenantAsync(ct);

        var secret = GuestSecret(config);
        var phoneHash = ConnectGuestPhone.Hash(secret, row.MeetingId, e164);
        var now = DateTimeOffset.UtcNow;
        var log = logs.CreateLogger("Connect.Guests");

        var otp = await db.Set<ConnectGuestOtp>()
            .FirstOrDefaultAsync(o => o.MeetingId == row.MeetingId && o.PhoneHash == phoneHash, ct);

        if (otp is null)
        {
            // A NEW number for this meeting. The same ceiling as guest rows, for
            // the same reason: the rate limit caps the rate, this caps the total
            // texts one meeting link can ever cause.
            var numbers = await db.Set<ConnectGuestOtp>().CountAsync(o => o.MeetingId == row.MeetingId, ct);
            if (numbers >= PerMeetingGuestCeiling)
            {
                log.LogWarning("Meeting {Meeting}: code REFUSED, {Numbers} numbers have already asked (ceiling {Ceiling}). Guests are being told the link does not work.",
                    row.MeetingId, numbers, PerMeetingGuestCeiling);
                return Gone();
            }
            otp = new ConnectGuestOtp
            {
                Id = Guid.NewGuid(), MeetingId = row.MeetingId, PhoneHash = phoneHash,
                Sends = 0, CreatedAt = now,
            };
            db.Add(otp);
        }
        else
        {
            if (now - otp.SentAt < ConnectGuestPhone.ResendAfter)
                return Results.Json(new { error = "A code was just sent. Wait a moment before asking again." }, statusCode: 429);
            if (otp.Sends >= ConnectGuestPhone.MaxSendsPerNumber)
                return Results.Json(new { error = "Too many codes have been sent to this number for this meeting." }, statusCode: 429);
        }

        var fresh = ConnectGuestPhone.NewCode();
        otp.OtpHash = ConnectGuestPhone.OtpHash(secret, row.MeetingId, phoneHash, fresh);
        otp.SentAt = now;
        otp.Attempts = 0;
        otp.Sends++;
        // Saved BEFORE sending: a send counted and not sent costs the person
        // one of five; a send sent and not counted is an unbounded bill.
        await db.SaveChangesAsync(ct);

        var result = await sms.SendOtpAsync(e164, fresh, ct);
        if (!result.Sent && !showOtp)
        {
            // Never the number in the log. The provider's reason is ours to read.
            log.LogWarning("Meeting {Meeting}: a guest's code could not be texted ({Provider}: {Detail})",
                row.MeetingId, result.Provider, result.Detail);
            // Results.Json with `error`, NOT Results.Problem: the guest client
            // reads `error` only, and a sentence in `detail` would reach the
            // person as "This meeting link does not work."
            return Results.Json(new { error = "The code could not be sent. Try again in a minute." }, statusCode: 502);
        }

        return Results.Ok(new
        {
            sent = true,
            sentTo = ConnectGuestPhone.Mask(e164),
            // Testing mode only, exactly as sign-in does it: the code on screen
            // when no text could go and the operator has said that is allowed.
            devCode = showOtp && !result.Sent ? fresh : null,
        });
    }

    // ==================================================================
    //  Guest join
    // ==================================================================
    private static async Task<IResult> GuestJoinAsync(
        string code, GuestJoinRequest req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, LiveKitTokenService tokens, ConnectRoomKey roomKeys,
        ILoggerFactory logs, SettingsReader settings, IConfiguration config, CancellationToken ct)
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

        // Platform settings are read BEFORE the tenant scope changes.
        var phoneOn = await settings.FlagAsync(SettingKeys.ConnectGuestPhoneOtp, false, ct);

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
        // ── Who is this, if the switch is on. ────────────────────────────────
        //  Either a PASS this server signed for this meeting (somebody coming
        //  back in the same browser: no text, no typing), or a number and the
        //  code texted to it. Both end at the same place: `returning` is their
        //  existing row, or null and `phoneHash` is what a new row will carry.
        ConnectParticipant? returning = null;
        string? phoneHash = null;
        byte[]? secret = null;
        if (phoneOn)
        {
            secret = GuestSecret(config);
            var now = DateTimeOffset.UtcNow;

            if (ConnectGuestPhone.ReadPass(secret, row.MeetingId, req.Pass, now) is Guid passFor)
                returning = await db.ConnectParticipants
                    .FirstOrDefaultAsync(p => p.Id == passFor && p.MeetingId == row.MeetingId
                                           && p.IsGuest && p.GuestPhoneHash != null, ct);

            if (returning is null)
            {
                var e164 = ConnectGuestPhone.Normalise(req.Phone);
                var typed = (req.Otp ?? "").Trim();
                if (e164 is null || typed.Length == 0)
                    return Results.BadRequest(new
                    {
                        error = "Verify your mobile number to join this meeting.",
                        phoneRequired = true,
                    });

                phoneHash = ConnectGuestPhone.Hash(secret, row.MeetingId, e164);
                var otp = await db.Set<ConnectGuestOtp>()
                    .FirstOrDefaultAsync(o => o.MeetingId == row.MeetingId && o.PhoneHash == phoneHash, ct);

                var good = otp is { OtpHash: not null }
                    && otp.Attempts < ConnectGuestPhone.MaxAttempts
                    && now - otp.SentAt <= ConnectGuestPhone.OtpLifetime
                    && ConnectGuestPhone.SameHash(
                        ConnectGuestPhone.OtpHash(secret, row.MeetingId, phoneHash, typed), otp.OtpHash);
                if (!good)
                {
                    if (otp is not null)
                    {
                        otp.Attempts++;
                        // Guessed at too often: the code dies, a new one must be asked for.
                        if (otp.Attempts >= ConnectGuestPhone.MaxAttempts) otp.OtpHash = null;
                        await db.SaveChangesAsync(ct);
                    }
                    // One sentence for wrong, expired, used and never-sent alike.
                    return Results.BadRequest(new { error = "That code is not right, or it has expired. Ask for a new one." });
                }
                otp!.OtpHash = null;   // single use

                returning = await db.ConnectParticipants
                    .FirstOrDefaultAsync(p => p.MeetingId == row.MeetingId && p.GuestPhoneHash == phoneHash, ct);
            }

            // Remove now survives a rejoin for a guest too. It could not before:
            // a removed guest came back as a brand-new row with a brand-new
            // identity, and with the waiting room off walked straight in.
            if (returning is not null && await db.ConnectMeetingBlocks.AsNoTracking()
                    .AnyAsync(x => x.MeetingId == row.MeetingId && x.Identity == returning.Identity, ct))
            {
                await db.SaveChangesAsync(ct);
                return Results.Conflict(new { error = "You were removed from this meeting and cannot rejoin." });
            }
        }

        // The ceiling guards NEW rows. Somebody coming back adds none, so they
        // are never the person it turns away.
        var guestRows = returning is not null ? 0 : await db.ConnectParticipants.AsNoTracking()
            .CountAsync(p => p.MeetingId == row.MeetingId && p.IsGuest, ct);
        if (guestRows >= PerMeetingGuestCeiling)
        {
            // Said HERE because it is said nowhere else: the guest is told only
            // that the link does not work. No name, no address - the meeting id
            // and the two numbers are the whole story.
            logs.CreateLogger("Connect.Guests").LogWarning(
                "Meeting {Meeting}: guest join REFUSED by the per-meeting ceiling ({Rows} guest rows, ceiling {Ceiling}). Guests are being told the link does not work.",
                row.MeetingId, guestRows, PerMeetingGuestCeiling);
            return Gone();
        }

        if (row.WaitingRoom is "guests" or "everyone")
        {
            var cutoff = DateTimeOffset.UtcNow.AddMinutes(-30);
            var waitingRows = await db.ConnectLobbyRequests.AsNoTracking()
                .CountAsync(r => r.MeetingId == row.MeetingId
                              && r.Status == "waiting" && r.CreatedAt > cutoff, ct);
            if (waitingRows >= PerMeetingGuestCeiling)
            {
                logs.CreateLogger("Connect.Guests").LogWarning(
                    "Meeting {Meeting}: guest join REFUSED, the waiting room is full ({Rows} waiting, ceiling {Ceiling}). Guests are being told the link does not work.",
                    row.MeetingId, waitingRows, PerMeetingGuestCeiling);
                return Gone();
            }
        }

        ConnectParticipant participant;
        if (returning is not null)
        {
            // The same person, counted once. Their name may have changed; the
            // row, its identity and whatever the host decided about them do not.
            participant = returning;
            participant.DisplayName = name;
            await db.SaveChangesAsync(ct);
        }
        else
        {
            participant = new ConnectParticipant
            {
                Id = Guid.NewGuid(),
                MeetingId = row.MeetingId,
                UserId = null,
                DisplayName = name,
                Role = "participant",
                IsGuest = true,
                Identity = "",
                CreatedAt = DateTimeOffset.UtcNow,
                GuestPhoneHash = phoneHash,
            };
            // Keyed to the participant row, not to the name: two people may both
            // be "Ravi", and a display name is not an identity.
            participant.Identity = ConnectCodes.IdentityForGuest(participant.Id);
            db.ConnectParticipants.Add(participant);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException) when (phoneHash is not null)
            {
                // Two tabs proved the same number in the same second and the
                // unique index let one through. This is the other one: take the
                // row that won rather than fail somebody who did nothing wrong.
                db.Entry(participant).State = EntityState.Detached;
                var winner = await db.ConnectParticipants
                    .FirstOrDefaultAsync(p => p.MeetingId == row.MeetingId && p.GuestPhoneHash == phoneHash, ct);
                if (winner is null) throw;
                participant = winner;
            }
        }

        // Handed over once the number is proved, and again on every return so it
        // never runs out mid-meeting. See ConnectGuestPhone for what it is not.
        var guestPass = secret is null ? null : ConnectGuestPhone.MintPass(
            secret, row.MeetingId, participant.Id, DateTimeOffset.UtcNow + ConnectGuestPhone.PassLifetime);

        // Guests wait unless the host has explicitly turned the waiting room
        // off. Defaulting the other way would mean a leaked link is a seat.
        if (row.WaitingRoom is "guests" or "everyone")
        {
            var (waitToken, _) = await ConnectEndpoints.ParkAsync(
                db, row.MeetingId, null, name, ct);
            return Results.Ok(new { status = "waiting", waitToken, guestPass });
        }

        // A proved guest keeps ONE row across devices, so each connection gets
        // its own identity (IdentityForGuestDevice). An unproved one does not
        // need it: their row is this door only.
        var connection = participant.GuestPhoneHash is null
            ? participant.Identity
            : ConnectCodes.IdentityForGuestDevice(participant.Id);

        return Results.Ok(new
        {
            status = "joined",
            guestPass,
            token = tokens.MintJoinToken(new LiveKitGrantOptions(
                ConnectCodes.RoomName(row.MeetingId), connection, name,
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
            identity = connection,
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

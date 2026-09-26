using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;      // AuditWriter
using TatvaOS.Api.Modules.Mail;       // MailSender
using TatvaOS.Api.Modules.Family;     // ContactAutoSave
using TatvaOS.Api.Shared;             // ClientIp
using TatvaOS.Api.Shared.Auth;        // IPasswordHasher
using TatvaOS.Api.Shared.Data;        // AppDbContext
using TatvaOS.Api.Shared.Tenancy;     // TenantContext

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// Sharing a recording with somebody who was not in the meeting.
///
/// ═════════════════════════════════════════════════════════════════════════
///  REGISTERED 9 September 2026, after two weeks deliberately switched off.
///
///  This file sat unwired on purpose. Its tables were a proposal with four
///  open questions on it, and the one that mattered was the organisation
///  switch gating the fourth level: until that had a name, 'public' had no
///  gate, and an ungated 'public' is the single change in this module that
///  cannot be taken back. A level-4 link that should not exist cannot be
///  recalled; a refusal is a support message.
///
///  All four are answered (see the migration, 20260908-b, where each answer
///  is recorded beside the code it decided). The gate that blocked it turned
///  out not to need Core at all — the switch was never going to be a column
///  on a shared table, because Space's equivalent is not one either.
///
///  THE FEATURE IS STILL OFF, AND THERE IS A GATE ON THE SWITCH.
///
///  Recordings.tsx renders the Share button only when the recordings list
///  carries a `sharing` capability, and no API code emits that field. Adding
///  it is one line and it is the on-switch for the whole feature.
///
///  DO NOT ADD IT until the permission matrix in docs/CONNECT_DECISIONS.md
///  has been run and the results shown — nine cases, one of which is known to
///  fail today (a suspended organisation is not checked). Public links to
///  recordings are the most exposed surface this product would have. The
///  matrix is the condition, not a suggestion.
///
///  WHAT ENFORCES WHAT, because the two are not the same:
///    • CreateAsync refuses level 4 when the organisation's switch is off.
///      That is a courtesy — it stops a link being made that would not work.
///    • connect.resolve_share_token refuses to resolve a 'public' token at
///      all when the switch is off. That is the security, it is in the
///      database, and it applies to links that already exist.
/// ═════════════════════════════════════════════════════════════════════════
///
///  ── WHAT CORE RULED, AND WHERE EACH RULE LIVES ─────────────────────────
///
///  "The baseline never moves"           — nothing here touches it.
///                                         SeenMeetingAsync is untouched, and
///                                         AllowedAsync below is only ever
///                                         consulted AFTER it has said no.
///  "Every grant audited"                — AuditWriter on create and revoke.
///  "Expiry mandatory, default 7 days,
///   ceiling = remaining retention"      — CreateAsync validates; the database
///                                         trigger clamps. Both, on purpose:
///                                         the trigger is the guarantee and
///                                         the check is the sentence.
///  "Password hashed like meeting
///   passwords"                          — IPasswordHasher, same call.
///  "Level 4 per-organisation, off"      — >>> GATE.
///  "Exposure stated in plain words,
///   level 4 verbatim"                   — ConnectShareLevels.Exposure, and
///                                         returned by the API so that no
///                                         client can invent its own wording.
///  "Every access beyond participants
///   writes an audit row"                — LogAccessAsync, called from the
///                                         download path, not from here.
///  "Delivery stays on the ticket"       — untouched. This file mints no
///                                         tickets and reads no files.
///
///  ── NAMES TO CONFIRM WHEN THIS IS FIRST WIRED UP ───────────────────────
///
///  Written without a compiler to hand. The first attempt was missing every
///  `using` above except EntityFrameworkCore and the build produced sixteen
///  CS0246s in one go — AppDbContext, TenantContext, IPasswordHasher and
///  AuditWriter, all of them types this module uses constantly. Fixed by
///  copying the header of ConnectEndpoints.cs, which is where they should
///  have come from in the first place.
///
///  The two property names I had flagged as inferred are now checked against
///  Shared/Data/Entities.cs rather than assumed: `User` carries Id, TenantId,
///  Email and DisplayName, all as used here. IPasswordHasher.Hash(string) and
///  AuditWriter.WriteAsync's named parameters were checked the same way.
///
///  What still cannot be checked without the tables: nothing in this file
///  runs until AppDbContext maps the three entities, so `db.Set<T>()`
///  compiles today and would throw at first use. That is the intended state —
///  see the top of this header.
///
///  Deliberately NOT used: any lookup of an organisation's NAME. The API says
///  whether a named person is outside the recording's organisation, and not
///  where they work. That is the fact a host needs, and it costs no
///  dependency on a table this module has never touched.
/// </summary>
public static class ConnectShareEndpoints
{
    /// <summary>
    /// Registered from Program.cs since 9 September. The comment that stood
    /// here said "NOT CALLED" for two weeks after that, which is how a reader
    /// ends up believing a live route is dead; corrected 26 September.
    /// </summary>
    public static void MapConnectShareEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect")
            .RequireAuthorization("User")
            .WithTags("Connect");

        g.MapGet("/meetings/{id:guid}/recordings/{recordingId:guid}/shares", ListAsync);
        g.MapPost("/meetings/{id:guid}/recordings/{recordingId:guid}/shares", CreateAsync);
        g.MapDelete("/meetings/{id:guid}/recordings/{recordingId:guid}/shares/{shareId:guid}", RevokeAsync);
        g.MapPut("/meetings/{id:guid}/recordings/{recordingId:guid}/shares/{shareId:guid}/people", PeopleAsync);

        // ── THE READER'S SIDE (26 September). ────────────────────────────
        //
        // A signed-in person opening a recording by id: a participant, or
        // somebody an organisation or named share covers. The address those
        // two levels are emailed and copied as.
        g.MapGet("/recordings/{recordingId:guid}/view", ViewAsync);

        // A LINK holder, with no session. Anonymous by necessity, and rate
        // limited on its own policy — tighter than the meeting door, because
        // this is where a password is guessed.
        var links = app.MapGroup("/api/connect/shared")
            .AllowAnonymous()
            .RequireRateLimiting("connect-shared-links")
            .WithTags("Connect");
        links.MapPost("/{token}", OpenLinkAsync);
        // Share readers of both kinds renew a playback ticket here.
        links.MapPost("/renew", RenewAsync);

        // The organisation's own switch. Separate group: reading it is
        // ordinary — the recordings screen needs to know whether to offer
        // level 4 at all — but CHANGING it is an administrator's act, and a
        // switch that exposes recordings to the open internet should not be
        // flippable by whoever happens to be hosting a meeting.
        var s = app.MapGroup("/api/connect/settings")
            .WithTags("Connect");

        s.MapGet("", GetSettingsAsync).RequireAuthorization("User");
        s.MapPut("", PutSettingsAsync).RequireAuthorization("OrgAdmin");
    }

    public sealed record ConnectSettingsRequest(bool AllowPublicRecordingLinks);

    /// <summary>
    /// What this organisation has decided. Readable by anybody signed in,
    /// because the alternative is a Share dialog that offers a level the
    /// server will refuse — a button that fails is worse than one that is
    /// not there.
    /// </summary>
    private static async Task<IResult> GetSettingsAsync(
        AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is null) return Results.Unauthorized();

        // No row means defaults, and the default is off. Not a 404: "this
        // organisation has never been asked" and "this organisation said no"
        // are the same answer to the only question being asked here.
        var allowed = await db.Set<ConnectTenantSettings>().AsNoTracking()
            .Where(x => x.TenantId == tenant.TenantId)
            .Select(x => (bool?)x.AllowPublicRecordingLinks)
            .FirstOrDefaultAsync(ct) ?? false;

        return Results.Ok(new { allowPublicRecordingLinks = allowed });
    }

    /// <summary>
    /// Turn public links on or off for the whole organisation.
    ///
    /// The third of the three acts Core asked to see in the platform audit
    /// log — created, revoked, and this. It is the one an administrator will
    /// be asked about months later ("who turned this on?"), and unlike a read
    /// it has a real, named actor, so it belongs there rather than in
    /// Connect's own access log.
    /// </summary>
    private static async Task<IResult> PutSettingsAsync(
        ConnectSettingsRequest req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is null) return Results.Unauthorized();
        var tid = tenant.TenantId;

        var row = await db.Set<ConnectTenantSettings>()
            .FirstOrDefaultAsync(x => x.TenantId == tid, ct);

        var before = row?.AllowPublicRecordingLinks ?? false;

        if (row is null)
        {
            row = new ConnectTenantSettings { TenantId = tid };
            db.Add(row);
        }

        row.AllowPublicRecordingLinks = req.AllowPublicRecordingLinks;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // Written even when nothing changed. "Somebody looked at this switch
        // and confirmed it" is a fact worth having; a log that records only
        // changes cannot distinguish a setting nobody has touched from one
        // that was checked this morning.
        await audit.WriteAsync("connect.settings.public_links", "connect.tenant",
            tid.ToString(),
            before: new { allowPublicRecordingLinks = before },
            after: new { allowPublicRecordingLinks = row.AllowPublicRecordingLinks },
            ct: ct, productCode: "connect");

        return Results.Ok(new { allowPublicRecordingLinks = row.AllowPublicRecordingLinks });
    }

    // ==================================================================
    //  THE ON-SWITCH (26 September)
    // ==================================================================

    internal sealed record Capability(string[] Levels, int DefaultDays, int MaxDays);

    /// <summary>
    /// May this organisation CREATE shares at all? (Mr. Singh, 26 September.)
    ///
    /// "Dark" has to mean the routes refuse, not only that the button is
    /// hidden: with the button off, a host who knows the API could still have
    /// made organisation, named and password shares in production before
    /// §3's condition was met. So while Connect:RecordingSharingOffered is
    /// off, creating a share (or adding people to one) is refused — except
    /// for the organisations named in Connect:RecordingSharingTestTenants, a
    /// comma-separated list of tenant ids, which is how the production matrix
    /// runs before anybody else can share.
    ///
    /// Reading, revoking and opening are NOT gated: none of them can make a
    /// share exist, and revoking must always work.
    /// </summary>
    internal static bool SharingOpenFor(IConfiguration config, Guid tenantId)
    {
        if (string.Equals(config["Connect:RecordingSharingOffered"], "true", StringComparison.OrdinalIgnoreCase))
            return true;
        var list = config["Connect:RecordingSharingTestTenants"] ?? "";
        return list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(x => Guid.TryParse(x, out var g) && g == tenantId);
    }

    private static IResult SharingNotOpen() => Results.Json(new
    {
        error = "Sharing recordings is not switched on for this server yet.",
    }, statusCode: 403);

    /// <summary>
    /// What the recordings list tells THIS caller about sharing, or null for
    /// "do not offer it".
    ///
    /// This is the one line docs/CONNECT_DECISIONS.md §3 said not to write
    /// until the nine-case matrix had been run against a DEPLOYED system. So
    /// it is written behind its own switch, Connect:RecordingSharingOffered,
    /// OFF unless set to "true": the read side can be deployed dark, the
    /// matrix (tests/connect-recording-share/) run against production through
    /// plain HTTP — none of it needs the button — and only then is the button
    /// switched on, by configuration, with no second deploy of code.
    ///
    /// HOST ONLY. The share routes refuse a co-host, and the web shows the
    /// button to hosts and co-hosts alike; emitting this for a co-host would
    /// be a button that always fails.
    ///
    /// 'public' is listed only when the organisation's switch is on. The
    /// database refuses a public link whatever this says; leaving it out just
    /// means nobody is offered a link that will not work.
    /// </summary>
    internal static async Task<Capability?> CapabilityAsync(
        AppDbContext db, TenantContext tenant, IConfiguration config,
        Guid meetingId, Guid userId, CancellationToken ct)
    {
        if (!SharingOpenFor(config, tenant.TenantId))
            return null;

        if (await ConnectRecordingEndpoints.RoleOfAsync(db, meetingId, userId, ct) != "host")
            return null;

        var publicOn = await db.Set<ConnectTenantSettings>().AsNoTracking()
            .Where(x => x.TenantId == tenant.TenantId)
            .Select(x => (bool?)x.AllowPublicRecordingLinks)
            .FirstOrDefaultAsync(ct) ?? false;

        string[] levels = publicOn
            ? [ConnectShareLevels.Organisation, ConnectShareLevels.Named,
               ConnectShareLevels.Password, ConnectShareLevels.Public]
            : [ConnectShareLevels.Organisation, ConnectShareLevels.Named,
               ConnectShareLevels.Password];

        return new Capability(levels, ConnectShareLevels.DefaultDays,
            await RetentionDaysAsync(db, tenant.TenantId, ct));
    }

    /// <summary>The organisation's retention window, through the same helper
    /// the expiry trigger uses, so the screen and the database agree on the
    /// ceiling.</summary>
    internal static async Task<int> RetentionDaysAsync(AppDbContext db, Guid tenantId, CancellationToken ct)
    {
        var days = await db.Database
            .SqlQuery<int?>($"""SELECT connect.recording_retention_days({tenantId}) AS "Value" """)
            .ToListAsync(ct);
        return days.FirstOrDefault() ?? 30;
    }

    /// <summary>
    /// Whole days before this recording is deleted: its hold if it has one,
    /// otherwise its age against the organisation's window. The trigger's
    /// arithmetic, so a link offered here is never silently shortened there.
    /// </summary>
    internal static int DaysLeft(ConnectRecording r, int retentionDays)
    {
        var ceiling = r.KeepUntilAt ?? r.CreatedAt.AddDays(retentionDays);
        return Math.Max(0, (int)Math.Floor((ceiling - DateTimeOffset.UtcNow).TotalDays));
    }

    // ==================================================================
    //  Requests
    // ==================================================================

    /// <param name="Level">organisation | named | password | public.</param>
    /// <param name="Days">Required on the two link levels. Clamped to what the
    /// recording has left; see the trigger.</param>
    /// <param name="Password">'password' only. 4 to 100 characters, the same
    /// rule as a meeting password — one rule for passwords in this product,
    /// not two.</param>
    /// <param name="UserIds">'named' only. Email addresses OR user ids; the
    /// handler resolves either, because the web sends what a person typed.</param>
    public sealed record CreateShareRequest(
        string? Level, int? Days, string? Password, string[]? UserIds);

    public sealed record PeopleRequest(string[]? UserIds);

    // ==================================================================
    //  Shapes
    // ==================================================================

    /// <summary>
    /// NEVER INCLUDES PasswordHash, and never includes the token except as
    /// part of a complete URL.
    ///
    /// The hash is obvious. The token is less so: handing a client the raw
    /// secret separately from the URL invites somebody to build a second URL
    /// out of it, against a route that may not exist, and to get it wrong in
    /// a way that leaks. One shape, assembled here.
    /// </summary>
    private static object Shape(
        ConnectRecordingShare s,
        IReadOnlyList<object> people,
        int opens,
        string createdBy,
        string publicBase,
        string? mailNote = null,
        Guessing? guessing = null)
        => new
        {
            s.Id,
            s.RecordingId,
            s.Level,
            // A link level's URL carries its token. The two signed-in levels
            // get the recording's own address, which is no secret — it opens
            // only for somebody the share (or the meeting) covers — and which
            // is what their email says, so the host can copy the same thing.
            url = s.Token is { Length: > 0 } t
                ? $"{publicBase}/connect/shared/{t}"
                : $"{publicBase}/connect/recordings/{s.RecordingId}",
            hasPassword = s.PasswordHash is not null,
            s.ExpiresAt,
            people,
            opens,
            s.CreatedAt,
            createdBy,
            // Returned so no client has to keep its own copy of the wording.
            // Two descriptions of the same row is how one of them ends up
            // gentler than the truth.
            exposure = ConnectShareLevels.Exposure(s.Level),
            // Set only on a create or a change of people, and only when an
            // email to somebody named could not be sent. The share exists
            // either way; this is the sentence telling the host to send the
            // link themselves.
            mailNote,
            // Password links only. Set while the link is refusing everybody
            // after ten wrong passwords in an hour; the host is told somebody
            // has been guessing, and can stop the link or wait it out.
            passwordPausedUntil = guessing?.PausedUntil,
            // Wrong passwords in the last day, paused or not — a steady
            // trickle under the limit is worth a host knowing about too.
            wrongPasswords24h = guessing?.Last24h ?? 0,
        };

    internal sealed record Guessing(DateTimeOffset? PausedUntil, int Last24h);

    /// <summary>Read under the host's own RLS: the failures table is scoped
    /// to the recording's organisation, which is the host's.</summary>
    private static async Task<Guessing?> GuessingOfAsync(
        AppDbContext db, ConnectRecordingShare s, CancellationToken ct)
    {
        if (s.PasswordHash is null) return null;
        var since = DateTimeOffset.UtcNow.AddDays(-1);
        var count = await db.Set<ConnectRecordingSharePasswordFailure>().AsNoTracking()
            .CountAsync(f => f.ShareId == s.Id && f.CreatedAt > since, ct);
        return new Guessing(await PasswordPausedUntilAsync(db, s.Id, ct), count);
    }

    // ==================================================================
    //  Listing
    // ==================================================================
    private static async Task<IResult> ListAsync(
        Guid id, Guid recordingId, AppDbContext db, TenantContext tenant,
        IConfiguration config, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        // Reading who a recording is shared with is HOST ONLY, like sharing
        // itself. A participant can watch the recording; being able to
        // enumerate everybody else who can is a different thing, and it is
        // the list an attacker would most like.
        if (await ConnectRecordingEndpoints.RoleOfAsync(db, id, uid, ct) != "host")
            return ConnectRecordingEndpoints.Forbidden();

        var shares = await db.Set<ConnectRecordingShare>().AsNoTracking()
            .Where(s => s.RecordingId == recordingId && s.MeetingId == id
                     && s.RevokedAt == null)
            .OrderBy(s => s.CreatedAt)
            .ToListAsync(ct);

        var result = new List<object>(shares.Count);
        var publicBase = PublicBase(config);
        foreach (var s in shares)
        {
            result.Add(Shape(s,
                await PeopleOfAsync(db, s, ct),
                await OpensOfAsync(db, s, ct),
                await NameOfAsync(db, s.CreatedByUserId, ct),
                publicBase,
                guessing: await GuessingOfAsync(db, s, ct)));
        }

        return Results.Ok(new { shares = result });
    }

    // ==================================================================
    //  Creating
    // ==================================================================
    private static async Task<IResult> CreateAsync(
        Guid id, Guid recordingId, CreateShareRequest req,
        AppDbContext db, TenantContext tenant, IPasswordHasher hasher,
        IConfiguration config, AuditWriter audit, ContactAutoSave autoSave,
        ILoggerFactory logs, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        // ── HOST ONLY. ───────────────────────────────────────────────────
        //
        //  Not co-host, and this is a deliberate departure from most host
        //  controls. A co-host runs the ROOM — admits people, mutes, records.
        //  Deciding that somebody outside the meeting may watch it afterwards
        //  is the same weight of act as deleting the recording, which is
        //  already host-only for exactly this reason.
        if (await ConnectRecordingEndpoints.RoleOfAsync(db, id, uid, ct) != "host")
            return ConnectRecordingEndpoints.Forbidden();

        if (!SharingOpenFor(config, tenant.TenantId)) return SharingNotOpen();

        var level = (req.Level ?? "").Trim().ToLowerInvariant();
        if (!ConnectShareLevels.IsValid(level))
            return Results.BadRequest(new
            {
                error = "Share with your organisation, with named people, "
                      + "with a password, or with anyone holding the link.",
            });

        // A recording with no file cannot be shared. Sharing one that is still
        // being written would hand somebody a link that 404s for ten minutes
        // and then works, which is worse than refusing.
        var recording = await db.ConnectRecordings.AsNoTracking()
            .Where(r => r.Id == recordingId && r.MeetingId == id && r.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (recording is null)
            return Results.NotFound(new { error = "That recording is not ready to share." });

        // ── THE ORGANISATION SWITCH FOR LEVEL 4, AT SHARE TIME. ──────────
        //
        //  This used to return 503 unconditionally, because the settings
        //  table it needed did not exist and I would not guess at a column on
        //  a table other modules share. It turned out not to be a shared
        //  table at all: Space's equivalent lives on space.tenant_settings,
        //  so Connect's lives on connect.tenant_settings and was Connect's to
        //  write all along.
        //
        //  A MISSING ROW IS OFF, which is why this is a nullable read and a
        //  `?? false` rather than a join that would quietly return nothing
        //  and be mistaken for an error. An organisation nobody has asked has
        //  not agreed.
        //
        //  This check is a COURTESY, not the security. It stops somebody
        //  generating a link that would never have worked. The enforcement is
        //  inside connect.resolve_share_token, where the anonymous read path
        //  cannot get past it — see section 6 of the migration for why it is
        //  there and not here.
        if (level == ConnectShareLevels.Public)
        {
            var allowed = await db.Set<ConnectTenantSettings>().AsNoTracking()
                .Where(s => s.TenantId == tenant.TenantId)
                .Select(s => (bool?)s.AllowPublicRecordingLinks)
                .FirstOrDefaultAsync(ct) ?? false;

            if (!allowed)
                return Results.Json(new
                {
                    error = "Links that anyone can open are switched off for this "
                          + "organisation. An administrator can turn them on in "
                          + "the organisation's Connect settings.",
                }, statusCode: 403);
        }

        // One live share per level. A second at the same level is two links
        // with different expiries and one of them forgotten about.
        var already = await db.Set<ConnectRecordingShare>()
            .AnyAsync(s => s.RecordingId == recordingId && s.Level == level
                        && s.RevokedAt == null, ct);
        if (already)
            return Results.Conflict(new
            {
                error = "This recording is already shared that way. "
                      + "Stop the existing share first if you want to change it.",
            });

        // ── EXPIRY ───────────────────────────────────────────────────────
        DateTimeOffset? expires = null;
        if (ConnectShareLevels.HasLink(level))
        {
            var days = req.Days ?? ConnectShareLevels.DefaultDays;
            if (days < 1)
                return Results.BadRequest(new { error = "A link has to last at least a day." });

            // >>> CORE, QUESTION 3. The recording's own end of life. Written
            // against connect.retention_days(), which does not exist yet —
            // see the migration draft. The TRIGGER is the guarantee; this
            // check exists so the person gets a sentence rather than a
            // silently shortened link.
            expires = DateTimeOffset.UtcNow.AddDays(days);
            if (recording.KeepUntilAt is DateTimeOffset keep && expires > keep)
                return Results.BadRequest(new
                {
                    error = $"This recording is kept until {keep:d MMMM yyyy}. "
                          + "A link cannot outlast the recording it points at.",
                });
        }

        // ── PASSWORD ─────────────────────────────────────────────────────
        string? hash = null;
        if (level == ConnectShareLevels.Password)
        {
            var pw = req.Password ?? "";
            // EIGHT, not the meeting password's four — the one exception to
            // "one password rule in the product" (Mr. Singh, 26 September;
            // the reason is in docs/CONNECT_DECISIONS.md §3). A meeting
            // password guards an hour; this guards a recording for weeks.
            if (pw.Length is < MinSharePassword or > 100)
                return Results.BadRequest(new
                {
                    error = $"A share password is between {MinSharePassword} and 100 characters.",
                });
            hash = hasher.Hash(pw);
        }

        var share = new ConnectRecordingShare
        {
            Id = Guid.NewGuid(),
            TenantId = tenant.TenantId,
            RecordingId = recordingId,
            MeetingId = id,
            Level = level,
            Token = ConnectShareLevels.HasLink(level) ? ConnectCodes.New() : null,
            PasswordHash = hash,
            ExpiresAt = expires,
            CreatedByUserId = uid,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        // ── NAMED PEOPLE ─────────────────────────────────────────────────
        //
        //  Resolved BEFORE the share is added to the context. Every lookup now
        //  writes an audit row, and AuditWriter saves at once — so a share
        //  added first would be saved by the first lookup, and a request then
        //  refused for an unknown address would leave a share behind.
        List<ConnectRecordingShareGrant> named = [];
        if (level == ConnectShareLevels.Named)
        {
            var (grants, unknown, limited, _) = await ResolveAsync(db, audit, uid, share, req.UserIds ?? [], ct);
            if (limited) return LookupLimit();
            if (unknown.Count > 0)
                return Results.BadRequest(new
                {
                    // Named, not counted. "2 addresses were not found" makes
                    // somebody re-read their own list looking for which two.
                    error = unknown.Count == 1
                        ? $"{unknown[0]} does not have a TatvaOS account, so they cannot be given access yet."
                        : $"These do not have TatvaOS accounts yet: {string.Join(", ", unknown)}.",
                });
            if (grants.Count == 0)
                return Results.BadRequest(new { error = "Name at least one person." });
            named = grants;
        }

        db.Set<ConnectRecordingShare>().Add(share);
        db.Set<ConnectRecordingShareGrant>().AddRange(named);
        await db.SaveChangesAsync(ct);

        // EVERY GRANT AUDITED, per Core. The token is NOT in the audit row:
        // an audit log that contains working capability URLs is a second copy
        // of the thing being protected.
        await audit.WriteAsync("connect.recording.shared", "connect.meeting", id.ToString(),
            after: new
            {
                share.Id,
                share.RecordingId,
                share.Level,
                share.ExpiresAt,
                hasPassword = hash is not null,
            }, ct: ct, productCode: "connect");

        var mailNote = level == ConnectShareLevels.Named
            ? await NotifyNamedAsync(db, tenant, config, audit, autoSave,
                logs.CreateLogger("Connect.RecordingShares"), share,
                [.. named.Select(g => g.SubjectUserId)], ct)
            : null;

        return Results.Ok(Shape(share,
            await PeopleOfAsync(db, share, ct), 0,
            await NameOfAsync(db, uid, ct),
            PublicBase(config), mailNote));
    }

    // ==================================================================
    //  Revoking
    // ==================================================================
    private static async Task<IResult> RevokeAsync(
        Guid id, Guid recordingId, Guid shareId,
        AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await ConnectRecordingEndpoints.RoleOfAsync(db, id, uid, ct) != "host")
            return ConnectRecordingEndpoints.Forbidden();

        var share = await db.Set<ConnectRecordingShare>()
            .Where(s => s.Id == shareId && s.RecordingId == recordingId && s.MeetingId == id)
            .FirstOrDefaultAsync(ct);
        if (share is null) return Results.NotFound(new { error = "That share does not exist." });

        // Already revoked is a success, not a conflict. Somebody pressing
        // "Stop sharing" twice wants it stopped, and an error message that
        // says it was already stopped reads like a failure.
        if (share.RevokedAt is null)
        {
            share.RevokedAt = DateTimeOffset.UtcNow;
            share.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);

            await audit.WriteAsync("connect.recording.unshared", "connect.meeting", id.ToString(),
                after: new { share.Id, share.RecordingId, share.Level },
                ct: ct, productCode: "connect");
        }

        return Results.NoContent();
    }

    // ==================================================================
    //  Changing who is named
    // ==================================================================
    //
    //  The one thing that IS edited rather than revoked-and-recreated. A named
    //  list is a membership; a link is a secret. Adding somebody to a list is
    //  what is really happening, and modelling it as "revoke and make a new
    //  link" would be a lie about a share that has no link at all.
    private static async Task<IResult> PeopleAsync(
        Guid id, Guid recordingId, Guid shareId, PeopleRequest req,
        AppDbContext db, TenantContext tenant, IConfiguration config,
        AuditWriter audit, ContactAutoSave autoSave, ILoggerFactory logs,
        CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await ConnectRecordingEndpoints.RoleOfAsync(db, id, uid, ct) != "host")
            return ConnectRecordingEndpoints.Forbidden();

        var share = await db.Set<ConnectRecordingShare>()
            .Where(s => s.Id == shareId && s.RecordingId == recordingId
                     && s.MeetingId == id && s.RevokedAt == null)
            .FirstOrDefaultAsync(ct);
        if (share is null) return Results.NotFound(new { error = "That share does not exist." });
        if (share.Level != ConnectShareLevels.Named)
            return Results.BadRequest(new
            {
                error = "Only a share with named people has a list to change.",
            });

        var (wanted, unknown, limited, gated) = await ResolveAsync(db, audit, uid, share, req.UserIds ?? [], ct,
            mayLookUp: SharingOpenFor(config, tenant.TenantId));
        if (gated) return SharingNotOpen();
        if (limited) return LookupLimit();
        if (unknown.Count > 0)
            return Results.BadRequest(new
            {
                error = unknown.Count == 1
                    ? $"{unknown[0]} does not have a TatvaOS account, so they cannot be given access yet."
                    : $"These do not have TatvaOS accounts yet: {string.Join(", ", unknown)}.",
            });

        var existing = await db.Set<ConnectRecordingShareGrant>()
            .Where(x => x.ShareId == shareId && x.RevokedAt == null)
            .ToListAsync(ct);

        var keep = wanted.Select(w => w.SubjectUserId).ToHashSet();
        var now = DateTimeOffset.UtcNow;

        // REVOKED, not deleted, for the same reason the share itself is: "who
        // could see this, and when did that stop" survives a removal.
        var removed = new List<Guid>();
        foreach (var row in existing.Where(x => !keep.Contains(x.SubjectUserId)))
        {
            row.RevokedAt = now;
            removed.Add(row.SubjectUserId);
        }

        var have = existing.Where(x => x.RevokedAt is null)
            .Select(x => x.SubjectUserId).ToHashSet();
        var added = wanted.Where(w => !have.Contains(w.SubjectUserId)).ToList();
        // Adding somebody is giving access, so it is gated like creating a
        // share. Removing people never is.
        if (added.Count > 0 && !SharingOpenFor(config, tenant.TenantId)) return SharingNotOpen();
        db.Set<ConnectRecordingShareGrant>().AddRange(added);

        share.UpdatedAt = now;
        await db.SaveChangesAsync(ct);

        if (added.Count > 0 || removed.Count > 0)
        {
            await audit.WriteAsync("connect.recording.share_people", "connect.meeting", id.ToString(),
                after: new
                {
                    share.Id,
                    added = added.Select(a => a.SubjectUserId).ToList(),
                    removed,
                }, ct: ct, productCode: "connect");
        }

        // Only the people just ADDED are emailed. Everybody already on the
        // list was told when they were added.
        var mailNote = added.Count == 0 ? null
            : await NotifyNamedAsync(db, tenant, config, audit, autoSave,
                logs.CreateLogger("Connect.RecordingShares"), share,
                [.. added.Select(a => a.SubjectUserId)], ct);

        return Results.Ok(Shape(share,
            await PeopleOfAsync(db, share, ct),
            await OpensOfAsync(db, share, ct),
            await NameOfAsync(db, share.CreatedByUserId, ct),
            PublicBase(config), mailNote));
    }

    // ==================================================================
    //  Helpers
    // ==================================================================

    /// <summary>
    /// Turn what somebody typed into grants, and say plainly what could not be
    /// turned into one.
    ///
    /// Accepts an email address or a user id, because the web sends whatever
    /// was in the box and making the browser guess which is which would put
    /// the guess in the wrong place.
    ///
    /// CROSS-TENANT IS ALLOWED AND IS THE POINT. The lookup is deliberately
    /// NOT limited to the caller's organisation — Core permitted named grants
    /// to reach accounts anywhere. Note what is still refused: a non-TatvaOS
    /// address, in v1, because an invitation is a different feature and a
    /// half-built one drops people silently.
    ///
    /// IgnoreQueryFilters, 26 September. The sentence above was true of the
    /// database — core.users has no RLS — and false of the application: User
    /// carries an EF query filter to the caller's own tenant, so every address
    /// in another organisation came back "does not have a TatvaOS account" and
    /// the cross-organisation grant could never be made. Found by §3 case 7.
    ///
    /// What that widens, stated for the reviewer: a host can now learn whether
    /// an exact address has an active TatvaOS account anywhere, by typing it.
    /// That is inherent in naming people across organisations, which Core
    /// ruled permitted; it is keyed by the exact address (no search, no
    /// prefix), and the host learns nothing else about the account.
    /// Deleted and suspended accounts are treated as unknown.
    /// </summary>
    ///
    /// LIMITED AND AUDITED (Mr. Singh, 26 September). Because a lookup says
    /// whether an account exists, each host may look up at most
    /// <see cref="LookupsPerHour"/> NEW addresses in any rolling hour, and
    /// every lookup — found or not — is written to the HOST's organisation's
    /// audit log as connect.recording.share_lookup, target = the address.
    /// That log is also the counter, so the limit cannot drift from the
    /// record of what was asked. People already on this share are not looked
    /// up again and cost nothing: the host knows them already.
    /// </summary>
    /// <param name="mayLookUp">False while sharing is dark for this
    /// organisation: then anybody not already on the share is refused BEFORE
    /// any lookup, so a dark server cannot be used to ask whether an address
    /// has an account.</param>
    private static async Task<(List<ConnectRecordingShareGrant> Grants, List<string> Unknown, bool Limited, bool Gated)>
        ResolveAsync(AppDbContext db, AuditWriter audit, Guid hostId, ConnectRecordingShare share,
            string[] raw, CancellationToken ct, bool mayLookUp = true)
    {
        var grants = new List<ConnectRecordingShareGrant>();
        var unknown = new List<string>();
        var seen = new HashSet<Guid>();

        var entries = raw.Select(x => x.Trim()).Where(x => x.Length > 0)
            .DistinctBy(x => x.ToLowerInvariant()).ToList();

        // Already on this share: resolved from the grant rows, not looked up.
        var current = await db.Set<ConnectRecordingShareGrant>().AsNoTracking()
            .Where(g => g.ShareId == share.Id && g.RevokedAt == null)
            .Select(g => new { g.SubjectUserId, g.SubjectTenantId })
            .ToListAsync(ct);
        var currentIds = current.Select(c => c.SubjectUserId).ToList();
        var known = (await db.Users.IgnoreQueryFilters().AsNoTracking()
                .Where(u => currentIds.Contains(u.Id))
                .Select(u => new { u.Id, u.Email })
                .ToListAsync(ct))
            .SelectMany(u => new[] { (Key: u.Id.ToString(), u.Id), (Key: u.Email.ToLowerInvariant(), u.Id) })
            .ToDictionary(k => k.Key, k => k.Id);

        var toLookUp = entries.Where(e => !known.ContainsKey(e.ToLowerInvariant())).ToList();
        if (toLookUp.Count > 0 && !mayLookUp)
            return (grants, unknown, false, true);

        // ── THE LIMIT, counted from the audit log itself. ────────────────
        var since = DateTimeOffset.UtcNow.AddHours(-1);
        var recent = (await db.AuditLogs.AsNoTracking()
                .Where(a => a.Action == LookupAction && a.ActorUserId == hostId && a.OccurredAt > since)
                .Select(a => a.TargetId)
                .ToListAsync(ct))
            .Where(t => t is not null).Select(t => t!).ToHashSet();
        var fresh = toLookUp.Count(e => !recent.Contains(Target(e)));
        if (recent.Count + fresh > LookupsPerHour)
            return (grants, unknown, true, false);

        foreach (var entry in entries)
        {
            if (known.TryGetValue(entry.ToLowerInvariant(), out var knownId))
            {
                if (!seen.Add(knownId)) continue;
                var c = current.First(x => x.SubjectUserId == knownId);
                grants.Add(new ConnectRecordingShareGrant
                {
                    Id = Guid.NewGuid(),
                    TenantId = share.TenantId,
                    ShareId = share.Id,
                    SubjectUserId = knownId,
                    SubjectTenantId = c.SubjectTenantId,
                    CreatedAt = DateTimeOffset.UtcNow,
                });
                continue;
            }

            var user = Guid.TryParse(entry, out var byId)
                ? await db.Users.IgnoreQueryFilters().AsNoTracking()
                    .Where(u => u.Id == byId && u.Status != "deleted" && u.Status != "suspended")
                    .Select(u => new { u.Id, u.TenantId })
                    .FirstOrDefaultAsync(ct)
                : await db.Users.IgnoreQueryFilters().AsNoTracking()
                    .Where(u => u.Email == entry && u.Status != "deleted" && u.Status != "suspended")
                    .Select(u => new { u.Id, u.TenantId })
                    .FirstOrDefaultAsync(ct);

            // Every lookup, found or not — "not found" is half of what a
            // lookup reveals, so it is half of what the log must show.
            await audit.WriteAsync(LookupAction, "connect.address", Target(entry),
                after: new { found = user is not null, outside = user is not null && user.TenantId != share.TenantId },
                ct: ct, productCode: "connect");

            if (user is null) { unknown.Add(entry); continue; }
            if (!seen.Add(user.Id)) continue;

            grants.Add(new ConnectRecordingShareGrant
            {
                Id = Guid.NewGuid(),
                TenantId = share.TenantId,
                ShareId = share.Id,
                SubjectUserId = user.Id,
                SubjectTenantId = user.TenantId,
                CreatedAt = DateTimeOffset.UtcNow,
            });
        }

        return (grants, unknown, false, false);
    }

    /// <summary>New addresses one host may look up in any rolling hour.</summary>
    internal const int LookupsPerHour = 30;

    internal const string LookupAction = "connect.recording.share_lookup";

    /// <summary>The audit target for an address: lower-cased, so "A@x" and
    /// "a@x" are one lookup, and cut to the column's 128 characters.</summary>
    private static string Target(string entry)
    {
        var t = entry.Trim().ToLowerInvariant();
        return t.Length <= 128 ? t : t[..128];
    }

    private static IResult LookupLimit() => Results.Json(new
    {
        error = $"You have looked up {LookupsPerHour} new people in the last hour, which is the limit. "
              + "Try again later, or share with your organisation or by link instead.",
    }, statusCode: 429);

    /// <summary>
    /// The named people on a share, with the ones who are NOT colleagues
    /// marked.
    ///
    /// The organisation name is filled in only when it differs from the
    /// recording's, and it is never null-then-hidden: sharing outside your own
    /// organisation should not be something a host has to work out from a list
    /// of email addresses.
    /// </summary>
    private static async Task<IReadOnlyList<object>> PeopleOfAsync(
        AppDbContext db, ConnectRecordingShare share, CancellationToken ct)
    {
        if (share.Level != ConnectShareLevels.Named) return [];

        var rows = await db.Set<ConnectRecordingShareGrant>().AsNoTracking()
            .Where(g => g.ShareId == share.Id && g.RevokedAt == null)
            .ToListAsync(ct);
        if (rows.Count == 0) return [];

        var ids = rows.Select(r => r.SubjectUserId).ToList();
        // Past the tenant filter for the same reason as ResolveAsync, and only
        // for the ids this share has already granted.
        var users = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email })
            .ToListAsync(ct);

        // Outside-ness is read from the GRANT, not from the user row. The
        // grant recorded which organisation they were in when they were
        // given access, and that is the fact the host agreed to. Somebody
        // changing organisations later does not quietly rewrite history.
        var outside = rows.Where(r => r.SubjectTenantId != share.TenantId)
            .Select(r => r.SubjectUserId).ToHashSet();

        return users.Select(u => (object)new
        {
            userId = u.Id,
            name = string.IsNullOrWhiteSpace(u.DisplayName) ? u.Email : u.DisplayName,
            u.Email,
            // Whether, not where. See the header: the fact a host needs is
            // "this person is not one of us", and the organisation's name
            // would cost a dependency on a table this module never touches.
            external = outside.Contains(u.Id),
        }).ToList();
    }

    /// <summary>
    /// How many times somebody who was NOT in the meeting has opened this.
    ///
    /// Participants are not in this table at all, so this is a count of reads
    /// the share is responsible for — which is the number a host wants when
    /// deciding whether a link is still needed.
    /// </summary>
    private static Task<int> OpensOfAsync(
        AppDbContext db, ConnectRecordingShare share, CancellationToken ct)
        => db.Set<ConnectRecordingAccess>().AsNoTracking()
            .CountAsync(a => a.ShareId == share.Id, ct);

    // ==================================================================
    //  THE READ SIDE. Everything above creates rows; this decides.
    // ==================================================================
    //
    //  Called from the download path, never from this file's own routes. It
    //  is here rather than in ConnectRecordingEndpoints so that the live,
    //  shipping download route gains exactly ONE line when the tables land,
    //  instead of being edited now against tables that do not exist.
    //
    //  THE ORDER MATTERS AND IS NOT NEGOTIABLE:
    //
    //      1. SeenMeetingAsync   were you in the room?      → yes, done.
    //      2. AllowedAsync       does a share cover you?    → yes, and LOG it.
    //      3. refuse.
    //
    //  Step 1 is the baseline and is never consulted here. A participant is
    //  authorised before any of this runs, is not logged, and cannot be
    //  affected by any share row. That is Core's rule and it holds by
    //  construction: this file has no way to answer step 1 and no way to
    //  make step 1 say no.

    /// <summary>
    /// Which share let somebody in, and whose recording it is.
    ///
    /// MeetingId and TenantId come from the SHARE ROW, read by a definer
    /// function, because for a reader in another organisation — or a reader
    /// with no session — that is the only place they can come from.
    /// </summary>
    internal sealed record ShareAccess(Guid ShareId, string Level, Guid MeetingId, Guid TenantId);

    private sealed record ShareAccessRow(Guid ShareId, string Level, Guid MeetingId, Guid TenantId);

    /// <summary>
    /// Does a live share let this SIGNED-IN person read this recording?
    ///
    /// Answers through connect.share_access_for_user(), SECURITY DEFINER
    /// because a named grant may point at somebody in another organisation.
    ///
    /// CHANGED 26 September. This used to take the share id from
    /// share_for_user() and then read the level "under ordinary RLS". For a
    /// reader in another organisation that read is scoped to THEIR tenant,
    /// finds nothing, and refuses them — so the cross-organisation grant, the
    /// one reason the function is a definer, could never have worked. The
    /// function now returns everything the caller needs in the one read.
    ///
    /// Returns null for "no", which is also the answer for a revoked share,
    /// an expired one, a suspended organisation, and a recording nobody ever
    /// shared.
    ///
    /// No tenant argument, on purpose: the function reads the reader's
    /// organisation from core.users itself (Mr. Singh, 26 September), so no
    /// caller — including one that has already switched scope — can hand it
    /// the wrong one.
    /// </summary>
    internal static async Task<ShareAccess?> AllowedAsync(
        AppDbContext db, Guid recordingId, Guid userId, CancellationToken ct)
    {
        var rows = await db.Database
            .SqlQuery<ShareAccessRow>($"""
                SELECT share_id   AS "ShareId",
                       level      AS "Level",
                       meeting_id AS "MeetingId",
                       tenant_id  AS "TenantId"
                  FROM connect.share_access_for_user({recordingId}, {userId})
                """)
            .ToListAsync(ct);

        return rows.FirstOrDefault() is { } r
            ? new ShareAccess(r.ShareId, r.Level, r.MeetingId, r.TenantId)
            : null;
    }

    internal enum LinkOutcome { None, NeedsPassword, WrongPassword, Paused, Open }

    internal sealed record LinkResult(LinkOutcome Outcome, ShareAccess? Access, Guid RecordingId,
        DateTimeOffset? PausedUntil = null);

    /// <summary>Shortest share password. See CreateAsync.</summary>
    internal const int MinSharePassword = 8;

    /// <summary>
    /// When this link opens again after too many wrong passwords, or null.
    /// Ten in a rolling hour, counted per LINK in the database, whoever sent
    /// them — see section 6 of 20260926-c.
    /// </summary>
    internal static async Task<DateTimeOffset?> PasswordPausedUntilAsync(
        AppDbContext db, Guid shareId, CancellationToken ct)
    {
        var until = await db.Database
            .SqlQuery<DateTimeOffset?>($"SELECT connect.share_password_paused_until({shareId}) AS \"Value\"")
            .ToListAsync(ct);
        return until.FirstOrDefault();
    }

    /// <summary>
    /// Turn a share LINK into the recording it names, for a holder with no
    /// session at all.
    ///
    /// ON SUCCESS THE REQUEST IS LEFT SCOPED TO THE RECORDING'S ORGANISATION —
    /// EnterAnonymousScope plus SyncTenantAsync, the guest door's two steps —
    /// because the password hash and the recording are both behind forced RLS,
    /// and a holder with no session has no tenant for it to scope by.
    ///
    /// Before 26 September the hash was read with no scope at all, found
    /// nothing, and every password link would have refused its own password.
    ///
    /// "No such link" covers wrong token, revoked, expired, suspended
    /// organisation and public-links-switched-off, and they are
    /// indistinguishable on purpose. A WRONG PASSWORD is distinguishable from
    /// a missing one, and that is a deliberate departure from the first
    /// draft: the page has to know to ask, the token is 128 random bits so
    /// telling its holder "this one needs a password" leaks nothing a scanner
    /// could use, and a person told only "this link does not work" after a
    /// typo will assume the link is dead. Guessing is what the
    /// connect-shared-links rate limit is for.
    /// </summary>
    internal static async Task<LinkResult> ByTokenAsync(
        AppDbContext db, TenantContext tenant, IPasswordHasher hasher,
        string? token, string? password, CancellationToken ct)
    {
        var none = new LinkResult(LinkOutcome.None, null, Guid.Empty);

        if (string.IsNullOrWhiteSpace(token)) return none;
        // Shape check before it costs a query — the same rule the meeting
        // doorstep follows, and what keeps a rate limiter meaningful.
        if (!ConnectCodes.IsWellFormed(token)) return none;

        var rows = await db.Database
            .SqlQuery<ShareTokenRow>($"""
                SELECT share_id     AS "ShareId",
                       recording_id AS "RecordingId",
                       meeting_id   AS "MeetingId",
                       tenant_id    AS "TenantId",
                       level        AS "Level",
                       has_password AS "HasPassword"
                  FROM connect.resolve_share_token({token})
                """)
            .ToListAsync(ct);

        if (rows.FirstOrDefault() is not { } row) return none;

        var access = new ShareAccess(row.ShareId, row.Level, row.MeetingId, row.TenantId);

        tenant.EnterAnonymousScope(row.TenantId, "guest");
        await db.SyncTenantAsync(ct);

        if (row.HasPassword)
        {
            if (string.IsNullOrEmpty(password))
                return new LinkResult(LinkOutcome.NeedsPassword, null, row.RecordingId);

            // PAUSED BEFORE THE PASSWORD IS EVEN LOOKED AT, and for the right
            // password too. Checking after would tell a guesser which of their
            // guesses was right the moment the pause lifted; refusing everyone
            // is what makes guessing from a thousand addresses pointless.
            if (await PasswordPausedUntilAsync(db, row.ShareId, ct) is { } until)
                return new LinkResult(LinkOutcome.Paused, null, row.RecordingId, until);

            // The hash is NOT returned by the definer function, on purpose.
            // Read here, scoped to the share we already hold.
            var hash = await db.Set<ConnectRecordingShare>().AsNoTracking()
                .Where(s => s.Id == row.ShareId)
                .Select(s => s.PasswordHash)
                .FirstOrDefaultAsync(ct);
            // Verify(password, encoded) — that order, checked against the two
            // places this platform already calls it. Both arguments are
            // strings, so getting it backwards compiles perfectly and simply
            // never lets anybody in.
            if (hash is null) return none;
            if (!hasher.Verify(password, hash))
            {
                // Counted against the LINK, through the definer, which takes
                // the tenant from the share row. Not best-effort: a guess that
                // could not be counted must not be a free guess.
                await db.Database.ExecuteSqlAsync(
                    $"SELECT connect.record_share_password_failure({row.ShareId}::uuid)", ct);
                return new LinkResult(LinkOutcome.WrongPassword, null, row.RecordingId);
            }
        }

        return new LinkResult(LinkOutcome.Open, access, row.RecordingId);
    }

    private sealed record ShareTokenRow(
        Guid ShareId, Guid RecordingId, Guid MeetingId, Guid TenantId,
        string Level, bool HasPassword);

    /// <summary>
    /// One row per OPENING of a recording by somebody who was NOT in the room.
    ///
    /// Participants are never passed here — they are the baseline, and
    /// logging them would bury the rows that matter under the rows that do
    /// not.
    ///
    /// Called when a reader is given their FIRST ticket, never from the file
    /// route: a two-hour video is dozens of range GETs, and a row each would
    /// turn this into a log of somebody's seeking. Renewing a ticket mid-film
    /// is not an opening either (see RenewAsync).
    ///
    /// Through connect.log_recording_access(), not an EF insert. The first
    /// version inserted through EF, and for an anonymous holder or a reader in
    /// another organisation the table's WITH CHECK refuses that row — the
    /// failure was then swallowed, so §3 case 9 would have written nothing
    /// and said nothing. The definer takes tenant, recording and level from
    /// the share row; the caller supplies only who, if anyone, and the
    /// blunted address.
    ///
    /// Best effort, always. An access that could not be logged must not
    /// become an access that was refused — but the failure is LOGGED now,
    /// because a swallowed failure here is exactly how case 9 fails silently.
    /// </summary>
    internal static async Task LogAccessAsync(
        AppDbContext db, ShareAccess access, Guid? subjectUserId, Guid? subjectTenantId,
        string? address, ILogger log, CancellationToken ct)
    {
        try
        {
            var prefix = Coarsen(address);
            await db.Database.ExecuteSqlAsync($"""
                SELECT connect.log_recording_access(
                    {access.ShareId}::uuid, {subjectUserId}::uuid,
                    {subjectTenantId}::uuid, {prefix}::text)
                """, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "Recording share {Share}: access row not written", access.ShareId);
        }
    }

    // ==================================================================
    //  THE READER'S ROUTES
    // ==================================================================

    public sealed record OpenLinkRequest(string? Password);
    public sealed record RenewRequest(string? Ticket);

    /// <summary>One sentence for every way a link can fail, for the reason
    /// in ByTokenAsync.</summary>
    private const string LinkDead =
        "This link does not work. It may have expired or been stopped by the person who shared it.";

    /// <summary>
    /// What the viewing page needs, the same shape on all three paths — a
    /// participant, a signed-in share reader, and a link holder — so the page
    /// has one thing to render.
    /// </summary>
    private static object Viewing(
        ConnectRecording r, string? title, string via, string? level,
        DateTimeOffset? expiresAt, Guid? meetingId, string ticket)
        => new
        {
            recordingId = r.Id,
            title = string.IsNullOrWhiteSpace(title) ? "Meeting recording" : title,
            r.Mode,
            r.DurationMs,
            r.SizeBytes,
            r.StartedAt,
            // meeting | share | link. The page says "shared with you" for the
            // last two, and only a participant gets a way back to the meeting.
            via,
            level,
            expiresAt,
            meetingId,
            ticket,
        };

    /// <summary>
    /// A signed-in person opening a recording by its id — the address a
    /// named or organisation share is emailed and copied as.
    ///
    ///   1. In the meeting (or created it)?  → baseline, not logged.
    ///   2. A live share covers them?        → logged, ticket names the share.
    ///   3. Neither                          → the same 404 as "no such thing".
    /// </summary>
    private static async Task<IResult> ViewAsync(
        Guid recordingId, AppDbContext db, TenantContext tenant,
        ConnectDownloadTicket tickets, HttpContext http,
        ILoggerFactory logs, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var userTenant = tenant.TenantId;

        // ── 1. THE BASELINE, UNCHANGED AND FIRST. ────────────────────────
        var own = await db.ConnectRecordings.AsNoTracking()
            .Where(r => r.Id == recordingId && r.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (own is not null
            && await ConnectRecordingEndpoints.SeenMeetingAsync(db, own.MeetingId, uid, ct))
        {
            var ownTitle = await db.ConnectMeetings.AsNoTracking()
                .Where(m => m.Id == own.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct);
            return Results.Ok(Viewing(own, ownTitle, "meeting", null, null, own.MeetingId,
                tickets.Issue(new ConnectDownloadTicket.Claim(userTenant, own.MeetingId, own.Id, uid))));
        }

        // ── 2. A SHARE. ──────────────────────────────────────────────────
        if (await AllowedAsync(db, recordingId, uid, ct) is not { } access)
            return RecordingGone();

        // A reader in another organisation cannot see the recording row under
        // their own scope. Read it under the recording's — the share, found by
        // the definer function, is what says they may. Nothing below writes
        // except the access row, which goes through its own definer.
        if (access.TenantId != userTenant)
        {
            tenant.EnterAnonymousScope(access.TenantId, "system");
            await db.SyncTenantAsync(ct);
        }

        var rec = await db.ConnectRecordings.AsNoTracking()
            .Where(r => r.Id == recordingId && r.MeetingId == access.MeetingId && r.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (rec is null) return RecordingGone();

        var title = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == access.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct);

        await LogAccessAsync(db, access, uid, userTenant, ClientIp.From(http),
            logs.CreateLogger("Connect.RecordingShares"), ct);

        return Results.Ok(Viewing(rec, title, "share", access.Level, null, null,
            tickets.Issue(new ConnectDownloadTicket.Claim(
                access.TenantId, access.MeetingId, rec.Id, uid, access.ShareId))));
    }

    /// <summary>
    /// Somebody holding a password or public LINK, with no session.
    ///
    /// POST rather than GET so the password is never in a URL, a proxy log or
    /// browser history — and so a link-preview bot unfurling the URL in a
    /// chat does not count as an opening.
    /// </summary>
    private static async Task<IResult> OpenLinkAsync(
        string token, OpenLinkRequest? req, AppDbContext db, TenantContext tenant,
        IPasswordHasher hasher, ConnectDownloadTicket tickets, HttpContext http,
        ILoggerFactory logs, CancellationToken ct)
    {
        var r = await ByTokenAsync(db, tenant, hasher, token, req?.Password, ct);

        switch (r.Outcome)
        {
            case LinkOutcome.NeedsPassword:
                return Results.Json(new { needsPassword = true }, statusCode: 401);
            case LinkOutcome.WrongPassword:
                return Results.Json(new
                {
                    needsPassword = true,
                    error = "That password did not open this recording.",
                }, statusCode: 401);
            case LinkOutcome.Paused:
                // 429, and said plainly. The holder already knows this link
                // has a password; "paused" tells them nothing new, and "does
                // not work" would send the real recipient away for good.
                return Results.Json(new
                {
                    paused = true,
                    error = "Too many wrong passwords have been tried on this link, so it is paused "
                          + "for up to an hour. Try again later.",
                }, statusCode: 429);
            case LinkOutcome.None:
                return Results.NotFound(new { error = LinkDead });
        }

        var access = r.Access!;

        var rec = await db.ConnectRecordings.AsNoTracking()
            .Where(x => x.Id == r.RecordingId && x.MeetingId == access.MeetingId && x.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (rec is null) return Results.NotFound(new { error = LinkDead });

        var title = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == access.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct);
        var expires = await db.Set<ConnectRecordingShare>().AsNoTracking()
            .Where(s => s.Id == access.ShareId).Select(s => s.ExpiresAt).FirstOrDefaultAsync(ct);

        await LogAccessAsync(db, access, null, null, ClientIp.From(http),
            logs.CreateLogger("Connect.RecordingShares"), ct);

        return Results.Ok(Viewing(rec, title, "link", access.Level, expires, null,
            tickets.Issue(new ConnectDownloadTicket.Claim(
                access.TenantId, access.MeetingId, rec.Id, Guid.Empty, access.ShareId))));
    }

    /// <summary>
    /// A fresh ticket for a playback in progress, for a SHARE reader.
    ///
    /// Tickets last five minutes and a film lasts longer. The player asks for
    /// a new one when the old one stops working. Asking the opening route
    /// again would write an access row every five minutes of viewing, so this
    /// trades a validly signed share ticket — expired up to a day, a paused
    /// film — for a new one, after the same re-check the file route makes on
    /// every request. Not logged: it is the same opening, continued.
    ///
    /// It cannot extend anything the share does not already allow: the share
    /// is re-checked here, and again on every byte range.
    /// </summary>
    private static async Task<IResult> RenewAsync(
        RenewRequest req, AppDbContext db, ConnectDownloadTicket tickets, CancellationToken ct)
    {
        if (tickets.Verify(req.Ticket, grace: TimeSpan.FromDays(1)) is not { ShareId: Guid sid } claim)
            return Results.NotFound(new { error = LinkDead });

        if (!await ShareStillAllowsAsync(db, sid, claim.RecordingId, claim.UserId, ct))
            return Results.NotFound(new { error = LinkDead });

        return Results.Ok(new { ticket = tickets.Issue(claim) });
    }

    /// <summary>
    /// The per-request re-check behind every share ticket. Guid.Empty is a
    /// link holder, who has no account for the grant check.
    /// </summary>
    internal static async Task<bool> ShareStillAllowsAsync(
        AppDbContext db, Guid shareId, Guid recordingId, Guid userId, CancellationToken ct)
    {
        Guid? who = userId == Guid.Empty ? null : userId;
        var ok = await db.Database
            .SqlQuery<bool>($"""
                SELECT connect.share_still_allows({shareId}::uuid, {recordingId}::uuid, {who}::uuid) AS "Value"
                """)
            .ToListAsync(ct);
        return ok.FirstOrDefault();
    }

    private static IResult RecordingGone() =>
        Results.NotFound(new { error = "That recording does not exist, or it has not been shared with you." });

    /// <summary>
    /// An address, blunted to the point where it answers "how many different
    /// places has this link been opened from" and stops.
    ///
    /// /24 for v4 and /48 for v6 — a neighbourhood, not a person, and not a
    /// location. Anything unparseable becomes null rather than being stored
    /// raw: a value this function did not understand is exactly the value it
    /// should not be keeping.
    ///
    /// >>> CORE, QUESTION 2. If the platform already has a house rule for
    /// storing addresses, this should use it instead of being a second one.
    /// </summary>
    internal static string? Coarsen(string? address)
    {
        if (string.IsNullOrWhiteSpace(address)) return null;
        if (!System.Net.IPAddress.TryParse(address.Trim(), out var ip)) return null;

        var bytes = ip.GetAddressBytes();
        if (bytes.Length == 4) return $"{bytes[0]}.{bytes[1]}.{bytes[2]}.0/24";
        if (bytes.Length == 16)
        {
            var head = string.Join(':', Enumerable.Range(0, 3)
                .Select(i => $"{bytes[i * 2]:x2}{bytes[i * 2 + 1]:x2}"));
            return $"{head}::/48";
        }
        return null;
    }

    /// <summary>
    /// Tell the people just named that a recording has been shared with them.
    ///
    /// Sent FROM THE HOST'S OWN MAILBOX, the way a meeting invitation is:
    /// "Priya shared a recording with you" is a message from Priya, it lands in
    /// her Sent folder, and a reply goes to her rather than to a no-reply
    /// address nobody reads.
    ///
    /// Plain text and HTML both. HTML-only system mail was what put this
    /// platform's mail in Gmail's spam folder in September.
    ///
    /// The link is the recording's own address. It opens only after the
    /// person signs in as the account that was named, so a forwarded email
    /// gives nothing away — which is also why it is safe to put in an email at
    /// all, unlike a password link.
    ///
    /// Returns a sentence for the host when anybody could not be emailed, or
    /// null. The share already exists either way; failing to email somebody
    /// must not undo giving them access.
    /// </summary>
    private static async Task<string?> NotifyNamedAsync(
        AppDbContext db, TenantContext tenant, IConfiguration config,
        AuditWriter audit, ContactAutoSave autoSave, ILogger log,
        ConnectRecordingShare share, IReadOnlyList<Guid> userIds, CancellationToken ct)
    {
        if (userIds.Count == 0) return null;
        if (tenant.UserId is not Guid uid) return null;

        const string noBox =
            "They have access, but no email was sent because you have no TatvaOS mailbox. "
          + "Copy the link and send it to them yourself.";

        var sender = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == uid, ct);
        var box = await db.Mailboxes.FirstOrDefaultAsync(m => m.UserId == uid && m.Type == "user", ct);
        if (sender is null || box is null) return noBox;

        // The people this share has just granted, wherever they work.
        var people = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => userIds.Contains(u.Id))
            .Select(u => new { u.Id, u.Email, u.DisplayName })
            .ToListAsync(ct);

        var title = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == share.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct);
        var meeting = string.IsNullOrWhiteSpace(title) ? "a meeting" : $"“{title}”";
        var from = string.IsNullOrWhiteSpace(sender.DisplayName) ? box.Address : sender.DisplayName;
        var url = $"{PublicBase(config)}/connect/recordings/{share.RecordingId}";

        var failed = new List<string>();
        foreach (var p in people)
        {
            if (string.IsNullOrWhiteSpace(p.Email)) { failed.Add(p.DisplayName ?? "someone"); continue; }

            var text =
                $"{from} has shared the recording of {meeting} with you.\n\n"
              + $"Watch it here:\n{url}\n\n"
              + $"You will be asked to sign in to TatvaOS as {p.Email}. "
              + "The link opens only for you, so forwarding this email does not share the recording.\n";

            Func<string?, string?> enc = System.Net.WebUtility.HtmlEncode;
            var html =
                "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937\">"
              + $"<p>{enc(from)} has shared the recording of {enc(meeting)} with you.</p>"
              + $"<p><a href=\"{enc(url)}\" style=\"display:inline-block;padding:10px 18px;background:#5b3fd6;"
              + "color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600\">Watch the recording</a></p>"
              + $"<p style=\"color:#6b7280;font-size:12px\">You will be asked to sign in to TatvaOS as {enc(p.Email)}. "
              + "The link opens only for you, so forwarding this email does not share the recording.</p>"
              + "</div>";

            try
            {
                var result = await MailSender.SubmitAsync(box, new MailSubmission(
                        To: [new MimeKit.MailboxAddress(p.DisplayName ?? "", p.Email)],
                        Cc: [],
                        Subject: $"{from} shared a meeting recording with you",
                        BodyText: text,
                        BodyHtml: html,
                        Attachments: []),
                    db, tenant, config, log, autoSave, audit, ct);

                if (result.Outcome is not (SendOutcome.Sent or SendOutcome.SentButNotFiled))
                {
                    failed.Add(p.Email);
                    log.LogWarning("Recording share {Share}: notice to a named person not sent: {Outcome} {Error}",
                        share.Id, result.Outcome, result.Error);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed.Add(p.Email);
                log.LogError(ex, "Recording share {Share}: notice to a named person threw", share.Id);
            }
        }

        return failed.Count == 0 ? null
            : failed.Count == 1
                ? $"{failed[0]} has access, but the email telling them could not be sent. Copy the link and send it yourself."
                : $"These people have access, but the email could not be sent: {string.Join(", ", failed)}. Copy the link and send it yourself.";
    }

    /// <summary>
    /// Who made a share, for the list. A local copy rather than a call into
    /// ConnectEndpoints: that one is private, and widening a method's
    /// visibility to save four lines is how a module's surface grows.
    /// </summary>
    private static async Task<string> NameOfAsync(
        AppDbContext db, Guid userId, CancellationToken ct)
    {
        var name = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.DisplayName)
            .FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(name) ? "Someone" : name;
    }

    /// <summary>
    /// Where a share link lives. Configured, never derived from the request —
    /// a public base URL taken from a Host header is a public base URL an
    /// attacker chooses.
    /// </summary>
    private static string PublicBase(IConfiguration config)
        => (config["Connect:PublicBaseUrl"] ?? "https://connect.tatvaos.com").TrimEnd('/');
}

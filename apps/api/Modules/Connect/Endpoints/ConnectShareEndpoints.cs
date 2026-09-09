using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;      // AuditWriter
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
    /// NOT CALLED. See the header. When the migration lands, this is invoked
    /// from ConnectRecordingEndpoints beside the other Connect groups.
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
        string publicBase)
        => new
        {
            s.Id,
            s.RecordingId,
            s.Level,
            url = s.Token is { Length: > 0 } t ? $"{publicBase}/connect/shared/{t}" : null,
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
        };

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
                publicBase));
        }

        return Results.Ok(new { shares = result });
    }

    // ==================================================================
    //  Creating
    // ==================================================================
    private static async Task<IResult> CreateAsync(
        Guid id, Guid recordingId, CreateShareRequest req,
        AppDbContext db, TenantContext tenant, IPasswordHasher hasher,
        IConfiguration config, AuditWriter audit, CancellationToken ct)
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
            // The same rule as a meeting password, word for word, because two
            // password rules in one product is two things to explain.
            if (pw.Length is < 4 or > 100)
                return Results.BadRequest(new
                {
                    error = "A share password is between 4 and 100 characters.",
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
        db.Set<ConnectRecordingShare>().Add(share);

        // ── NAMED PEOPLE ─────────────────────────────────────────────────
        if (level == ConnectShareLevels.Named)
        {
            var (grants, unknown) = await ResolveAsync(db, share, req.UserIds ?? [], ct);
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
            db.Set<ConnectRecordingShareGrant>().AddRange(grants);
        }

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

        return Results.Ok(Shape(share,
            await PeopleOfAsync(db, share, ct), 0,
            await NameOfAsync(db, uid, ct),
            PublicBase(config)));
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
        AuditWriter audit, CancellationToken ct)
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

        var (wanted, unknown) = await ResolveAsync(db, share, req.UserIds ?? [], ct);
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

        return Results.Ok(Shape(share,
            await PeopleOfAsync(db, share, ct),
            await OpensOfAsync(db, share, ct),
            await NameOfAsync(db, share.CreatedByUserId, ct),
            PublicBase(config)));
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
    /// </summary>
    private static async Task<(List<ConnectRecordingShareGrant> Grants, List<string> Unknown)>
        ResolveAsync(AppDbContext db, ConnectRecordingShare share, string[] raw, CancellationToken ct)
    {
        var grants = new List<ConnectRecordingShareGrant>();
        var unknown = new List<string>();
        var seen = new HashSet<Guid>();

        foreach (var entry in raw.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct())
        {
            var user = Guid.TryParse(entry, out var byId)
                ? await db.Users.AsNoTracking()
                    .Where(u => u.Id == byId)
                    .Select(u => new { u.Id, u.TenantId })
                    .FirstOrDefaultAsync(ct)
                : await db.Users.AsNoTracking()
                    .Where(u => u.Email == entry)
                    .Select(u => new { u.Id, u.TenantId })
                    .FirstOrDefaultAsync(ct);

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

        return (grants, unknown);
    }

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
        var users = await db.Users.AsNoTracking()
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

    /// <summary>Which share let somebody in, for the audit row.</summary>
    internal sealed record ShareAccess(Guid ShareId, string Level);

    /// <summary>
    /// Does a live share let this SIGNED-IN person read this recording?
    ///
    /// Answers through connect.share_for_user(), which is SECURITY DEFINER
    /// because a named grant may point at somebody in another organisation
    /// and an RLS-scoped query run as that reader can never see the row that
    /// permits them. That is the single place in this module allowed to cross
    /// a tenant boundary, it takes the reader's own id, and it returns one
    /// uuid — so it can neither enumerate anything nor be talked into
    /// answering a wider question.
    ///
    /// Returns null for "no", which is also the answer for a revoked share,
    /// an expired one, and a recording nobody ever shared.
    /// </summary>
    internal static async Task<ShareAccess?> AllowedAsync(
        AppDbContext db, Guid recordingId, Guid userId, Guid userTenantId,
        CancellationToken ct)
    {
        var ids = await db.Database
            .SqlQuery<Guid?>(
                $"""SELECT connect.share_for_user({recordingId}, {userId}, {userTenantId}) AS "Value" """)
            .ToListAsync(ct);

        if (ids.FirstOrDefault() is not Guid shareId) return null;

        // The LEVEL is read back under ordinary RLS, and that is safe for a
        // reason worth writing down: we already hold the id the definer
        // function chose, so this query cannot widen anything — at worst it
        // finds nothing, and then nobody is let in.
        var level = await db.Set<ConnectRecordingShare>().AsNoTracking()
            .Where(s => s.Id == shareId)
            .Select(s => s.Level)
            .FirstOrDefaultAsync(ct);

        return level is null ? null : new ShareAccess(shareId, level);
    }

    /// <summary>
    /// Turn a share LINK into the recording it names, for a holder with no
    /// session at all.
    ///
    /// The password is verified HERE rather than by the caller, so there is
    /// one place that knows a level-'password' share without a correct
    /// password is not an access. A caller that forgot to check would
    /// otherwise be a caller that leaks.
    ///
    /// Returns null for every failure — wrong token, revoked, expired, wrong
    /// password — and deliberately does not say which. A link that answers
    /// "right link, wrong password" differently from "no such link" tells
    /// somebody scanning for links when they have found one.
    /// </summary>
    internal static async Task<ShareAccess?> ByTokenAsync(
        AppDbContext db, IPasswordHasher hasher, string? token, string? password,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        // Shape check before it costs a query — the same rule the meeting
        // doorstep follows, and what keeps a rate limiter meaningful.
        if (!ConnectCodes.IsWellFormed(token)) return null;

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

        if (rows.FirstOrDefault() is not { } row) return null;

        if (row.HasPassword)
        {
            if (string.IsNullOrEmpty(password)) return null;
            // The hash is NOT returned by the definer function, on purpose —
            // see its comment. Read it here, scoped to the share we already
            // hold, so a wrong guess cannot be used to fish for hashes.
            var hash = await db.Set<ConnectRecordingShare>().AsNoTracking()
                .Where(s => s.Id == row.ShareId)
                .Select(s => s.PasswordHash)
                .FirstOrDefaultAsync(ct);
            // Verify(password, encoded) — that order, checked against the two
            // places this platform already calls it. Both arguments are
            // strings, so getting it backwards compiles perfectly and simply
            // never lets anybody in. I had it backwards.
            if (hash is null || !hasher.Verify(password, hash)) return null;
        }

        return new ShareAccess(row.ShareId, row.Level);
    }

    private sealed record ShareTokenRow(
        Guid ShareId, Guid RecordingId, Guid MeetingId, Guid TenantId,
        string Level, bool HasPassword);

    /// <summary>
    /// One row per read of a recording by somebody who was NOT in the room.
    ///
    /// Participants are never passed here — they are the baseline, and
    /// logging them would bury the rows that matter under the rows that do
    /// not.
    ///
    /// FIRST GET OF A RANGE REQUEST ONLY. A two-hour video is dozens of GETs
    /// on one ticket, and a row each would turn this into a log of somebody's
    /// seeking behaviour, which is not what it is for. The caller decides;
    /// this just writes.
    ///
    /// Best effort, always. An access that could not be logged must not
    /// become an access that was refused — the recording is already
    /// authorised by the time this runs, and failing the read to protect the
    /// log would be the wrong way round.
    /// </summary>
    /// <param name="tenantId">
    /// The RECORDING's tenant, passed in rather than read off the recording.
    /// ConnectRecording has no TenantId — it is scoped through its meeting,
    /// which is where RLS reaches it. Every caller already holds the meeting,
    /// so asking for the value is cheaper than a join and honest about where
    /// it comes from.
    /// </param>
    internal static async Task LogAccessAsync(
        AppDbContext db, Guid tenantId, ConnectRecording recording, ShareAccess access,
        Guid? subjectUserId, Guid? subjectTenantId, string? address,
        CancellationToken ct)
    {
        try
        {
            db.Set<ConnectRecordingAccess>().Add(new ConnectRecordingAccess
            {
                TenantId = tenantId,
                RecordingId = recording.Id,
                ShareId = access.ShareId,
                Level = access.Level,
                SubjectUserId = subjectUserId,
                SubjectTenantId = subjectTenantId,
                AddressPrefix = Coarsen(address),
                CreatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            // Swallowed deliberately; see the summary. Worth revisiting only
            // if it turns out to fail often, which would itself be the bug.
        }
    }

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

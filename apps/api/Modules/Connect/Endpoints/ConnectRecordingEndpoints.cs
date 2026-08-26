using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Admin;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// TatvaOS Connect — recording, transcripts and automatic notes.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THREE GATES, IN THIS ORDER, AND NONE OF THEM IS THE CLIENT'S TO SKIP.
///
///  1. THE ORGANISATION. core.tenants.allow_connect_recording, read through a
///     definer function, defaults FALSE. Recording a room full of people is a
///     decision an organisation makes once, knowingly. Every start re-reads
///     it, so switching it off stops recordings on meetings that already
///     exist — the allow_connect_guests rule, for the same reason.
///
///  2. THE PERSON. Host or cohost only, checked against the database, never
///     against a claim in the caller's token. The same division as every
///     other host control: RLS answers "does this meeting exist for you", this
///     file answers "may you command it".
///
///  3. THE DISK. One box, one filesystem. A recording that fills it stops
///     Mail as well, so the organisation's remaining pool is checked BEFORE
///     LiveKit is asked to start, and the refusal is a sentence rather than a
///     500 forty minutes later.
///
///  EVERYONE IN THE ROOM IS TOLD. Not by this API — by LiveKit. The SFU sets
///  the room's recording flag when an egress attaches and every client sees
///  it through RoomEvent.RecordingStatusChanged. That is deliberate: a
///  notice this API sent could be dropped by a client that would rather not
///  show it, whereas the flag arrives on the same signalling channel as the
///  media itself. The banner in Stage.tsx reads room.isRecording and nothing
///  else.
///
///  WHAT THIS FILE DOES NOT DO: consent. A banner is a notice, not consent,
///  and several of the jurisdictions Connect will run in require the latter.
///  That is a product decision and it is written up in
///  docs/CONNECT_RECORDING_AND_NOTES.md rather than quietly assumed here.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectRecordingEndpoints
{
    public static void MapConnectRecordingEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect")
            .RequireAuthorization("User")
            .WithTags("Connect");

        g.MapGet("/meetings/{id:guid}/recordings", ListAsync);
        g.MapPost("/meetings/{id:guid}/recordings", StartAsync);
        g.MapPost("/meetings/{id:guid}/recordings/{recordingId:guid}/stop", StopAsync);
        g.MapDelete("/meetings/{id:guid}/recordings/{recordingId:guid}", DeleteAsync);
        g.MapGet("/meetings/{id:guid}/recordings/{recordingId:guid}/file", DownloadAsync);
        // A browser cannot put an Authorization header on a navigation, and
        // this platform's access token is a header. So the signed-in caller
        // asks for a ticket, and the anonymous route below trades it for the
        // bytes. See ConnectDownloadTicket for why that is the shape.
        g.MapGet("/meetings/{id:guid}/recordings/{recordingId:guid}/ticket", TicketAsync);
        // "Keep this one" — exempt a recording from the retention sweep.
        // The spec's own prediction (docs/CONNECT_DECISIONS.md §1) is that
        // the first support ticket is a board meeting that got swept.
        g.MapPut("/meetings/{id:guid}/recordings/{recordingId:guid}/keep", KeepAsync);

        g.MapGet("/meetings/{id:guid}/notes", NotesAsync);
        g.MapPost("/meetings/{id:guid}/notes/regenerate", RegenerateAsync);

        // ── ANONYMOUS, AND SAFE FOR THE SAME REASON THE WEBHOOK IS. ───────
        // Outside the authorised group because a <a href> download carries no
        // header. The control is the SIGNATURE on the ticket, not the fact
        // that the route needs a session — and having verified it, this
        // handler still re-checks every permission through ordinary
        // RLS-scoped queries rather than trusting what the ticket says.
        app.MapGet("/api/connect/recordings/file", DownloadTicketedAsync)
           .AllowAnonymous()
           .WithTags("Connect");

        // Minutes of meeting, and the chat that goes into them. Registered
        // from HERE rather than from Program.cs: Program.cs is Core's file, a
        // change to it is a cross-lane patch, and this needs nothing from
        // Core that is not already registered.
        app.MapConnectMinutesEndpoints();
    }

    public sealed record StartRecordingRequest(string? Mode, bool? Transcribe);

    /// <summary>Days is one of a short list, like the retention setting
    /// itself — a free-form date invites 'keep until 2099'. Null clears the
    /// exemption and the org policy applies again.</summary>
    public sealed record KeepRequest(int? Days);

    // ==================================================================
    //  Shapes
    // ==================================================================
    private static object Shape(ConnectRecording r) => new
    {
        r.Id,
        r.MeetingId,
        r.Mode,
        r.Status,
        r.SizeBytes,
        r.DurationMs,
        r.StartedAt,
        r.EndedAt,
        r.Transcribe,
        r.KeepUntilAt,
        r.Error,
        // Not r.FileName — the name is an internal key and telling a browser
        // about it invites somebody to try building a URL out of it. The
        // download route takes the recording id and nothing else.
        hasFile = r.Status == "ready" && r.FileName is not null,
        r.CreatedAt,
    };

    // ==================================================================
    //  Listing
    // ==================================================================
    private static async Task<IResult> ListAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        ConnectRecordingOptions options, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await SeenMeetingAsync(db, id, uid, ct)) return NotFound();

        var rows = await db.ConnectRecordings.AsNoTracking()
            .Where(r => r.MeetingId == id && r.Status != "deleted")
            .OrderByDescending(r => r.CreatedAt)
            .ToListAsync(ct);

        var recordingIds = rows.Select(r => r.Id).ToList();
        var transcripts = await db.ConnectTranscripts.AsNoTracking()
            .Where(t => recordingIds.Contains(t.RecordingId))
            // Error comes back from the database as well as the status: it is
            // the sentence the screen shows when a transcript failed, and a
            // projection that leaves it out is where the good message died.
            .Select(t => new { t.RecordingId, t.Status, t.Language, t.Error })
            .ToListAsync(ct);

        return Results.Ok(new
        {
            // The UI needs to distinguish "recording is off on this server"
            // from "nobody has recorded this meeting", and an empty list
            // cannot say which.
            enabled = options.Enabled,
            transcription = options.TranscriptionConfigured,
            items = rows.Select(r => new
            {
                recording = Shape(r),
                // t.Error travels with the status, and that is the point.
                //
                // The transcriber writes a different sentence for every way
                // this fails — too large, key rejected, service busy, silent
                // recording — and until 22 August every one of them was
                // dropped HERE, one field short of the screen, which then had
                // no choice but to say "Transcription failed" to a school
                // administrator who could do nothing with that.
                //
                // Writing a good error message and not shipping it is worse
                // than not writing one: it looks handled.
                transcript = transcripts.FirstOrDefault(t => t.RecordingId == r.Id) is { } t
                    ? new { t.Status, t.Language, t.Error }
                    : null,
            }),
        });
    }

    // ==================================================================
    //  Starting
    // ==================================================================
    private static async Task<IResult> StartAsync(
        Guid id, StartRecordingRequest? req, AppDbContext db, TenantContext tenant,
        LiveKitEgressClient egress, LiveKitRoomClient rooms, ConnectRecordingOptions options,
        AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        var tid = tenant.TenantId;

        if (!egress.IsConfigured)
            return Results.Json(new { error = "Recording is not switched on for this server." },
                statusCode: 503);

        var meeting = await db.ConnectMeetings.Where(m => m.Id == id).FirstOrDefaultAsync(ct);
        if (meeting is null) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost")) return Forbidden();

        // ── GATE 0 — THE MEETING'S OWN MODE, AND IT IS NOT A POLICY. ─────
        //
        // Before the organisation, the person or the disk, because those
        // three are all decisions somebody could change. This one is not:
        // a private meeting's media is encrypted with a key the SFU does not
        // hold, so an egress attached to it would write an unplayable file.
        // Refusing here means the failure is a sentence now rather than a
        // corrupt recording forty minutes later.
        //
        // Checked in the ENDPOINT rather than trusted from the UI, because
        // the UI hiding a button is decoration — assume someone calls this
        // route directly, because eventually someone will. That assumption is
        // what the test in infra/scripts/connect-mode-test.sh exercises.
        if (!meeting.MediaIsReadable)
            return Results.Json(new { error = ConnectModes.MediaRefusal }, statusCode: 409);

        // Gate 1 — the organisation, re-read every time.
        var allowed = await db.Database
            .SqlQuery<bool>($"""SELECT connect.recording_allowed({tid}) AS "Value" """)
            .FirstOrDefaultAsync(ct);
        if (!allowed)
            return Results.Json(new
            {
                error = "Recording is switched off for your organisation. "
                      + "An administrator can turn it on.",
            }, statusCode: 403);

        // A meeting somebody has deliberately finished is not recordable, and
        // that IS worth reading from our own row: the status only says
        // 'cancelled' or 'ended' because something positively set it.
        if (meeting.Status is "cancelled" or "ended")
            return Results.Json(new { error = "That meeting is over." }, statusCode: 409);

        // ── WHETHER THE MEETING IS RUNNING IS LIVEKIT'S ANSWER, NOT OURS. ──
        //
        // This used to be `if (meeting.Status != "active")`, and it was wrong
        // in the way that matters: meetings.status only becomes 'active' when
        // the room_started WEBHOOK arrives. A webhook can be lost — this
        // module's event log sat empty for a day — and when it is, two people
        // are visibly in a room, talking, while the database still says
        // 'scheduled' and the host is told to "start the meeting" they are
        // plainly already in. That is a status field being used as if it were
        // an observation.
        //
        // LiveKit knows who is in the room because it is holding their media.
        // Ask it.
        var present = await rooms.TryListParticipantsAsync(id, ct);
        if (present is null)
            return Results.Problem("The media server could not be reached.", statusCode: 502);
        if (present.Count == 0)
            return Results.Json(new
            {
                error = "Nobody has joined this meeting yet. Join it first, then start recording.",
            }, statusCode: 409);

        var already = await db.ConnectRecordings
            .Where(r => r.MeetingId == id && (r.Status == "starting" || r.Status == "recording"))
            .AnyAsync(ct);
        if (already)
            return Results.Json(new { error = "This meeting is already being recorded." },
                statusCode: 409);

        // Gate 3 — the disk. -1 means the organisation has no pool configured,
        // which every product on this platform reads as unlimited.
        var headroom = await db.Database
            .SqlQuery<long>($"""SELECT connect.storage_headroom({tid}) AS "Value" """)
            .FirstOrDefaultAsync(ct);
        if (headroom >= 0 && headroom < options.MinimumFreeBytes)
            return Results.Json(new
            {
                error = "There is not enough storage left in your organisation's plan to record. "
                      + "Delete some recordings or ask an administrator for more space.",
            }, statusCode: 507);

        var mode = (req?.Mode ?? "audio").Trim().ToLowerInvariant();
        if (mode is not ("audio" or "video"))
            return Results.BadRequest(new { error = "Record either audio or video." });

        // The file name is generated here and is opaque: a meeting id, a
        // random suffix and an extension. Nothing a person typed reaches a
        // path — see decision 2 in the migration.
        var fileName = $"{id:N}-{ConnectCodes.New()[..12]}.{(mode == "video" ? "mp4" : "ogg")}";

        var started = await egress.StartAsync(id, mode, fileName, ct);
        if (started?.EgressId is not { Length: > 0 } egressId)
            // ── A VIDEO REFUSAL HAS A KNOWN, ORDINARY CAUSE. SAY IT. ──────
            //
            // On 21 August every video attempt on production came back
            //   503 {"code":"unavailable","msg":"no response from servers"}
            // while audio recorded perfectly all day. That is not a fault:
            // LiveKit's admission controller prices a room-composite VIDEO
            // egress at four CPUs (it composites the meeting in a headless
            // Chrome and re-encodes), audio-only at one. The box has two
            // cores, so no egress instance can ever accept the video job and
            // the dispatcher reports that nobody answered.
            //
            // The old sentence — "the media server did not start the
            // recording" — was true and sent the reader looking for a broken
            // media server. This one sends them to the thing that is
            // actually true, and points at the option that works. It hedges
            // ("most often") because a Chrome crash or a full disk lands
            // here too, and stating one cause as certain would be the same
            // mistake in the opposite direction.
            //
            // Results.Json with an `error` field, NOT Results.Problem: the web
            // client reads `error` and nothing else (lib/connect.ts, json()),
            // so a ProblemDetails body — which carries `detail` and `title` —
            // is thrown away and the person sees the generic fallback. This
            // sentence existing in the response but never on screen is the
            // exact failure it was written to prevent.
            return Results.Json(new
            {
                // SHORT, BECAUSE OF WHERE IT LANDS. This renders as a banner
                // across the top of a LIVE meeting, above everybody's faces.
                // The first version ran to five lines of explanation and cost
                // two rows of the room to say it — a paragraph is the wrong
                // shape for a place people are trying to look past. One
                // sentence for what happened, one for what to do instead.
                // "Give the server more cores" was advice for whoever runs
                // the box, not for the person in the meeting, and it is in
                // the comment above and in the docs where they will be.
                //
                // It still does not name a core COUNT. This code cannot
                // measure the machine, and a number baked in here would keep
                // being printed after somebody upgrades it.
                error = mode == "video"
                    ? "Video recording needs about four spare processor cores and this server "
                      + "has not got them free. Audio recording works — start that instead."
                    : "The media server did not start the recording.",
            }, statusCode: 502);

        var recording = new ConnectRecording
        {
            Id = Guid.NewGuid(),
            MeetingId = id,
            EgressId = egressId,
            Mode = mode,
            Status = "starting",
            FileName = fileName,
            ContentType = mode == "video" ? "video/mp4" : "audio/ogg",
            RequestedByUserId = uid,
            Transcribe = req?.Transcribe ?? true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.ConnectRecordings.Add(recording);
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("connect.recording.started", "connect.meeting", id.ToString(),
            after: new { recording.Id, mode, recording.Transcribe }, ct: ct, productCode: "connect");

        return Results.Ok(Shape(recording));
    }

    // ==================================================================
    //  Stopping
    // ==================================================================
    private static async Task<IResult> StopAsync(
        Guid id, Guid recordingId, AppDbContext db, TenantContext tenant,
        LiveKitEgressClient egress, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await db.ConnectMeetings.AnyAsync(m => m.Id == id, ct) is false) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost")) return Forbidden();

        var recording = await db.ConnectRecordings
            .Where(r => r.Id == recordingId && r.MeetingId == id)
            .FirstOrDefaultAsync(ct);
        if (recording is null) return NotFound();

        if (recording.Status is not ("starting" or "recording"))
            return Results.Ok(Shape(recording));    // already stopped; not an error

        var stopped = await egress.StopAsync(recording.EgressId, ct);
        if (stopped is null)
            return Results.Problem("The media server did not accept that.", statusCode: 502);

        // 'processing', not 'ready'. The file is not finished until LiveKit
        // says so, and the egress_ended webhook is what says so. Marking it
        // ready here would offer a download of a file still being written.
        recording.Status = "processing";
        recording.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("connect.recording.stopped", "connect.meeting", id.ToString(),
            after: new { recording.Id }, ct: ct, productCode: "connect");

        return Results.Ok(Shape(recording));
    }

    // ==================================================================
    //  Keeping — the retention exemption
    // ==================================================================
    private static async Task<IResult> KeepAsync(
        Guid id, Guid recordingId, KeepRequest? req, AppDbContext db, TenantContext tenant,
        AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await db.ConnectMeetings.AnyAsync(m => m.Id == id, ct) is false) return NotFound();
        // Host only, like Delete: deciding a recording outlives the org's
        // policy is the same weight of act as destroying one.
        if (await RoleOfAsync(db, id, uid, ct) != "host") return Forbidden();

        var recording = await db.ConnectRecordings
            .Where(r => r.Id == recordingId && r.MeetingId == id && r.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (recording is null) return NotFound();

        // The same shape as the retention options themselves. Null clears.
        if (req?.Days is int d && d is not (30 or 90 or 180 or 365))
            return Results.BadRequest(new
            {
                error = "Keep a recording for 30, 90, 180 or 365 more days — or clear the hold.",
            });

        recording.KeepUntilAt = req?.Days is int days
            ? DateTimeOffset.UtcNow.AddDays(days)
            : null;
        recording.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync(
            recording.KeepUntilAt is null ? "connect.recording.keep_cleared" : "connect.recording.kept",
            "connect.meeting", id.ToString(),
            after: new { recording.Id, recording.KeepUntilAt }, ct: ct, productCode: "connect");

        return Results.Ok(Shape(recording));
    }

    // ==================================================================
    //  Deleting — the bytes, and honestly
    // ==================================================================
    private static async Task<IResult> DeleteAsync(
        Guid id, Guid recordingId, AppDbContext db, TenantContext tenant,
        ConnectRecordingOptions options, AuditWriter audit,
        ILogger<LiveKitEgressClient> log, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await db.ConnectMeetings.AnyAsync(m => m.Id == id, ct) is false) return NotFound();
        // Host only. A cohost can start and stop a recording; destroying one
        // is not the same act.
        if (await RoleOfAsync(db, id, uid, ct) != "host") return Forbidden();

        var recording = await db.ConnectRecordings
            .Where(r => r.Id == recordingId && r.MeetingId == id)
            .FirstOrDefaultAsync(ct);
        if (recording is null) return NotFound();
        if (recording.Status is "starting" or "recording")
            return Results.Json(new { error = "Stop the recording first." }, statusCode: 409);

        // The FILE goes; the ROW stays, marked deleted. A meeting that was
        // recorded and then had the recording destroyed is a fact worth
        // keeping — deleting the row too would leave no trace that anybody
        // was ever recorded.
        if (ResolvePath(options, recording.FileName) is { } path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // The row must not say 'deleted' while the bytes are still
                // there — the storage figure is derived from this column, and
                // a lie here becomes a wrong bill.
                log.LogError(ex, "Could not delete recording file {File}", recording.FileName);
                return Results.Problem("The file could not be deleted.", statusCode: 500);
            }
        }

        recording.Status = "deleted";
        recording.SizeBytes = 0;
        recording.FileName = null;
        recording.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        // The org's figure is derived, so it is recomputed rather than
        // decremented — see the migration header.
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT connect.reconcile_recording_storage({tenant.TenantId})", ct);

        await audit.WriteAsync("connect.recording.deleted", "connect.meeting", id.ToString(),
            after: new { recording.Id }, ct: ct, productCode: "connect");

        return Results.NoContent();
    }

    // ==================================================================
    //  Downloading
    // ==================================================================
    private static async Task<IResult> DownloadAsync(
        Guid id, Guid recordingId, AppDbContext db, TenantContext tenant,
        ConnectRecordingOptions options, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await SeenMeetingAsync(db, id, uid, ct)) return NotFound();

        var recording = await db.ConnectRecordings.AsNoTracking()
            .Where(r => r.Id == recordingId && r.MeetingId == id && r.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (recording is null) return NotFound();

        var path = ResolvePath(options, recording.FileName);
        if (path is null || !File.Exists(path)) return NotFound();

        var title = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == id).Select(m => m.Title).FirstOrDefaultAsync(ct);

        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 64 * 1024, useAsync: true);

        // enableRangeProcessing so a browser can seek in a two-hour recording
        // instead of downloading all of it to hear the last minute.
        return Results.File(stream,
            contentType: recording.ContentType ?? "application/octet-stream",
            fileDownloadName: DownloadName(title, recording),
            enableRangeProcessing: true);
    }

    // ==================================================================
    //  Downloading, part two: the ticket
    // ==================================================================
    private static async Task<IResult> TicketAsync(
        Guid id, Guid recordingId, AppDbContext db, TenantContext tenant,
        ConnectDownloadTicket tickets, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await SeenMeetingAsync(db, id, uid, ct)) return NotFound();

        var exists = await db.ConnectRecordings.AsNoTracking()
            .AnyAsync(r => r.Id == recordingId && r.MeetingId == id && r.Status == "ready", ct);
        if (!exists) return NotFound();

        return Results.Ok(new
        {
            ticket = tickets.Issue(new ConnectDownloadTicket.Claim(
                tenant.TenantId, id, recordingId, uid)),
        });
    }

    /// <summary>
    /// Trade a signed ticket for the bytes.
    ///
    /// The ticket names a tenant, and that is the ONLY thing taken on trust —
    /// because it is signed, and because without it forced RLS would return
    /// nothing here, exactly as it does on the guest path and in the webhook.
    /// Everything else is re-read and re-checked underneath the policy.
    /// </summary>
    private static async Task<IResult> DownloadTicketedAsync(
        string? t, AppDbContext db, TenantContext tenant, ConnectDownloadTicket tickets,
        ConnectRecordingOptions options, CancellationToken ct)
    {
        if (tickets.Verify(t) is not { } claim) return NotFound();

        tenant.EnterAnonymousScope(claim.TenantId, "system");
        // AND PUSH IT INTO THE DATABASE SESSION — the two-step rule this
        // module has already got wrong once. EnterAnonymousScope changes a C#
        // object; app.tenant_id is what RLS reads.
        await db.SyncTenantAsync(ct);

        // Re-checked, not trusted. The ticket said who asked; this says
        // whether they may still have it.
        var stillIn = await db.ConnectParticipants.AsNoTracking()
            .AnyAsync(p => p.MeetingId == claim.MeetingId && p.UserId == claim.UserId, ct);
        var isOrganiser = await db.ConnectMeetings.AsNoTracking()
            .AnyAsync(m => m.Id == claim.MeetingId && m.CreatedByUserId == claim.UserId, ct);
        if (!stillIn && !isOrganiser) return NotFound();

        var recording = await db.ConnectRecordings.AsNoTracking()
            .Where(r => r.Id == claim.RecordingId
                     && r.MeetingId == claim.MeetingId
                     && r.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (recording is null) return NotFound();

        var path = ResolvePath(options, recording.FileName);
        if (path is null || !File.Exists(path)) return NotFound();

        var title = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == claim.MeetingId).Select(m => m.Title).FirstOrDefaultAsync(ct);

        var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 64 * 1024, useAsync: true);

        return Results.File(stream,
            contentType: recording.ContentType ?? "application/octet-stream",
            fileDownloadName: DownloadName(title, recording),
            enableRangeProcessing: true);
    }

    // ==================================================================
    //  Notes
    // ==================================================================
    private static async Task<IResult> NotesAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        ConnectRecordingOptions options, TatvaOS.Api.Shared.Ai.IAiGateway ai,
        CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await SeenMeetingAsync(db, id, uid, ct)) return NotFound();

        var notes = await db.ConnectMeetingNotes.AsNoTracking()
            .Where(n => n.MeetingId == id).FirstOrDefaultAsync(ct);

        var transcript = await db.ConnectTranscripts.AsNoTracking()
            .Where(t => t.MeetingId == id)
            .OrderByDescending(t => t.CreatedAt)
            .FirstOrDefaultAsync(ct);

        return Results.Ok(new
        {
            // So the screen can say WHY there is nothing here, which is a
            // different sentence for each of these.
            recordingEnabled = options.Enabled,
            transcriptionConfigured = options.TranscriptionConfigured,
            // The gateway's answer, not the legacy per-module setting: since
            // 24 Aug the notes model IS the gateway, and a screen reading the
            // old flag would say "digest only" while the model wrote away.
            notesModelConfigured = ai.IsConfigured,

            transcript = transcript is null ? null : new
            {
                transcript.Status,
                transcript.Language,
                transcript.Provider,
                transcript.Error,
                transcript.Text,
                segments = Json(transcript.Segments),
            },

            notes = notes is null ? null : new
            {
                notes.Status,
                notes.Kind,
                notes.Model,
                notes.Summary,
                keyPoints = Json(notes.KeyPoints),
                decisions = Json(notes.Decisions),
                actionItems = Json(notes.ActionItems),
                speakers = Json(notes.Speakers),
                // Who attended. Present whether or not the meeting was ever
                // recorded — the API and the event log know this without any
                // media being involved.
                attendance = Json(notes.Attendance),
                notes.HadTranscript,
                notes.HadRecording,
                notes.Error,
                notes.GeneratedAt,
            },
        });
    }

    private static async Task<IResult> RegenerateAsync(
        Guid id, AppDbContext db, TenantContext tenant, AuditWriter audit, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await db.ConnectMeetings.AnyAsync(m => m.Id == id, ct) is false) return NotFound();
        if (await RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost")) return Forbidden();

        // No transcript required. Notes are written from attendance alone for
        // a meeting that was never recorded, so refusing here would refuse to
        // regenerate the only notes most meetings will ever have.
        var ended = await db.ConnectMeetings
            .AnyAsync(m => m.Id == id && m.Status == "ended", ct);
        if (!ended)
            return Results.Json(new { error = "Notes are written once the meeting has ended." },
                statusCode: 409);

        var notes = await db.ConnectMeetingNotes
            .Where(n => n.MeetingId == id).FirstOrDefaultAsync(ct);
        if (notes is null)
        {
            notes = new ConnectMeetingNotes
            {
                Id = Guid.NewGuid(),
                MeetingId = id,
                CreatedAt = DateTimeOffset.UtcNow,
            };
            db.ConnectMeetingNotes.Add(notes);
        }
        // Back to 'queued' and the worker picks it up on its next tick. The
        // request does not do the work: a model call can take a minute, and a
        // minute is far longer than a request should ever hold a connection.
        notes.Status = "queued";
        notes.Error = null;
        notes.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        await audit.WriteAsync("connect.notes.regenerate", "connect.meeting", id.ToString(),
            ct: ct, productCode: "connect");

        return Results.Accepted(value: new { status = "queued" });
    }

    // ==================================================================
    //  Helpers
    // ==================================================================
    internal static IResult NotFound() => Results.NotFound(new { error = "That meeting does not exist." });
    internal static IResult Forbidden() => Results.Json(
        new { error = "Only the host can do that." }, statusCode: 403);

    internal static async Task<string?> RoleOfAsync(
        AppDbContext db, Guid meetingId, Guid userId, CancellationToken ct)
    {
        var person = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == meetingId && p.UserId == userId)
            .FirstOrDefaultAsync(ct);
        return person?.Role;
    }

    /// <summary>
    /// Whether this person may READ the meeting's recordings and notes.
    ///
    /// Being in the same organisation is not enough — RLS already guarantees
    /// that, and a recording of a leadership meeting should not be readable by
    /// everyone who works there. The rule is: you were in the room, or you
    /// created it. Both are rows, not claims.
    /// </summary>
    /// <summary>Internal, not private, because ConnectMinutesEndpoints asks
    /// the same question and a second copy of "may this person see this
    /// meeting" is the last thing this module needs.</summary>
    internal static async Task<bool> SeenMeetingAsync(
        AppDbContext db, Guid meetingId, Guid userId, CancellationToken ct)
    {
        var meeting = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == meetingId)
            .Select(m => new { m.Id, m.CreatedByUserId })
            .FirstOrDefaultAsync(ct);
        if (meeting is null) return false;
        if (meeting.CreatedByUserId == userId) return true;

        return await db.ConnectParticipants.AsNoTracking()
            .AnyAsync(p => p.MeetingId == meetingId && p.UserId == userId, ct);
    }

    /// <summary>
    /// Turn a stored file NAME into a path, refusing anything that is not a
    /// bare name.
    ///
    /// A CHECK constraint already refuses a '/' at write time and the name is
    /// generated by this server, so this is the third guard on a value that
    /// has never been user input. It is here anyway, because the cost is one
    /// comparison and the failure mode is reading an arbitrary file off the
    /// container as an authenticated user.
    /// </summary>
    /// <summary>Internal, not private: the retention sweep in
    /// ConnectNotesWorker deletes files too, and a second copy of "turn a
    /// stored name into a path, refusing anything that is not a bare name"
    /// would be a second place for the path-traversal guard to drift.</summary>
    internal static string? ResolvePath(ConnectRecordingOptions options, string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return null;
        if (fileName.Contains('/') || fileName.Contains('\\')) return null;
        if (fileName is "." or "..") return null;
        if (fileName != Path.GetFileName(fileName)) return null;
        return Path.Combine(options.ReadDirectory, fileName);
    }

    private static string DownloadName(string? title, ConnectRecording r)
    {
        var stem = string.IsNullOrWhiteSpace(title) ? "Meeting" : title.Trim();
        var safe = new string(stem.Select(c =>
            char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' ? c : '-').ToArray()).Trim();
        if (safe.Length == 0) safe = "Meeting";
        if (safe.Length > 60) safe = safe[..60];
        var when = (r.StartedAt ?? r.CreatedAt).ToString("yyyy-MM-dd");
        return $"{safe} {when}.{(r.Mode == "video" ? "mp4" : "ogg")}";
    }

    /// <summary>
    /// The jsonb columns are held as strings, so they must be re-emitted as
    /// JSON rather than as a quoted string — otherwise the browser receives
    /// "[{\"start\":0,...}]" and has to parse it a second time, which is the
    /// kind of thing that works until a quote character appears in a
    /// transcript.
    /// </summary>
    private static System.Text.Json.JsonElement Json(string? raw)
    {
        try
        {
            return System.Text.Json.JsonDocument.Parse(
                string.IsNullOrWhiteSpace(raw) ? "[]" : raw).RootElement.Clone();
        }
        catch (System.Text.Json.JsonException)
        {
            return System.Text.Json.JsonDocument.Parse("[]").RootElement.Clone();
        }
    }
}

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

        g.MapGet("/meetings/{id:guid}/notes", NotesAsync);
        g.MapPost("/meetings/{id:guid}/notes/regenerate", RegenerateAsync);
    }

    public sealed record StartRecordingRequest(string? Mode, bool? Transcribe);

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
            .Select(t => new { t.RecordingId, t.Status, t.Language })
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
                transcript = transcripts.FirstOrDefault(t => t.RecordingId == r.Id) is { } t
                    ? new { t.Status, t.Language }
                    : null,
            }),
        });
    }

    // ==================================================================
    //  Starting
    // ==================================================================
    private static async Task<IResult> StartAsync(
        Guid id, StartRecordingRequest? req, AppDbContext db, TenantContext tenant,
        LiveKitEgressClient egress, ConnectRecordingOptions options,
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

        // LiveKit can only record a room that exists. Asking it to record a
        // meeting nobody has joined produces an egress that fails a few
        // seconds later, which reads to the host as "recording is broken".
        if (meeting.Status != "active")
            return Results.Json(new { error = "Start the meeting before recording it." },
                statusCode: 409);

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
            return Results.Problem("The media server did not start the recording.", statusCode: 502);

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
    //  Notes
    // ==================================================================
    private static async Task<IResult> NotesAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        ConnectRecordingOptions options, CancellationToken ct)
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
            notesModelConfigured = options.NotesModelConfigured,

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

        var ready = await db.ConnectTranscripts
            .AnyAsync(t => t.MeetingId == id && t.Status == "ready", ct);
        if (!ready)
            return Results.Json(new { error = "There is no transcript to write notes from yet." },
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
    private static IResult NotFound() => Results.NotFound(new { error = "That meeting does not exist." });
    private static IResult Forbidden() => Results.Json(
        new { error = "Only the host can do that." }, statusCode: 403);

    private static async Task<string?> RoleOfAsync(
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
    private static async Task<bool> SeenMeetingAsync(
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
    private static string? ResolvePath(ConnectRecordingOptions options, string? fileName)
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

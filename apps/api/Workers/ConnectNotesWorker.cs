using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Workers;

/// <summary>
/// Takes finished recordings and turns them into transcripts, and transcripts
/// into notes.
///
/// ─────────────────────────────────────────────────────────────────────────
///  THE TWO-STEP TENANCY RULE, WHICH THIS MODULE ALREADY GOT WRONG ONCE.
///
///  tenant.EnterAnonymousScope(...) changes a C# object. app.tenant_id is what
///  RLS actually reads, and the connection interceptor only sets it when a
///  connection OPENS. So every scope change here is followed on the NEXT LINE
///  by await db.SyncTenantAsync(ct) — exactly as Auth and Admin do at sixteen
///  sites, and exactly as ConnectWebhookEndpoints failed to do until it was
///  fixed. Without it every write below is refused by the policy, and a
///  refusal in a background worker has nobody watching it.
///
///  A FRESH SCOPE PER MEETING, NOT PER TICK. AppDbContext is scoped and this
///  is a singleton, so one context held across the loop would leak a
///  connection and accumulate tracked entities for the life of the process.
///  It also means one meeting's failure cannot poison the next one's context.
///
///  WORK IS CLAIMED BY WRITING A ROW FIRST. The transcript row moves to
///  'running' and is saved BEFORE the audio is sent anywhere. Two API
///  containers will exist one day, and 'find the queue, then do the work' with
///  no claim is how both of them transcribe the same hour of audio and bill it
///  twice.
///
///  IT ALSO REPAIRS. LiveKit's webhook is the normal path, and a webhook can
///  be lost — that is precisely why the recording feature exists at all in a
///  module whose event log sat empty for a day. Anything left 'starting',
///  'recording' or 'processing' past a grace period is asked about directly
///  through ListEgress, so a missed callback costs a delay rather than a
///  recording that never appears.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class ConnectNotesWorker(
    IServiceScopeFactory scopes,
    ConnectRecordingOptions options,
    ILogger<ConnectNotesWorker> log) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(1);

    /// <summary>How long a recording may sit unfinished before LiveKit is
    /// asked about it directly. Long enough that a normal egress finishing
    /// does not race the repair; short enough that a lost webhook is a few
    /// minutes' delay rather than a support ticket.</summary>
    private static readonly TimeSpan StuckAfter = TimeSpan.FromMinutes(5);

    /// <summary>One recording and one set of notes per tick. Transcription is
    /// minutes of CPU on the same box as the SFU, so the queue drains steadily
    /// rather than all at once — a fast queue that makes live meetings stutter
    /// is not the trade to make.</summary>
    private const int BatchSize = 1;

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        // NOT gated on recording being enabled. Notes are now written for
        // every meeting that has ended, from attendance, whether or not a
        // single byte was ever recorded — see ConnectNotesComposer. Returning
        // here when egress is not deployed would switch off the half of this
        // feature that needs no infrastructure at all.
        try { await Task.Delay(StartupDelay, stopping); }
        catch (OperationCanceledException) { return; }

        log.LogInformation(
            "Connect notes worker running every {Seconds}s (transcription {Transcription}, notes {Notes})",
            Tick.TotalSeconds,
            options.TranscriptionConfigured ? "configured" : "NOT configured",
            options.NotesModelConfigured ? "by model" : "digest only");

        using var timer = new PeriodicTimer(Tick);
        do
        {
            try
            {
                // The recording half needs egress; the notes half does not.
                if (options.Enabled)
                {
                    await RepairStuckAsync(stopping);
                    await TranscribeAsync(stopping);
                }
                await WriteNotesAsync(stopping);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Never let one bad row stop the loop. The next tick retries,
                // and a dead worker means no notes at all, silently.
                log.LogError(ex, "Connect notes sweep failed");
            }
        }
        while (await SafeWaitAsync(timer, stopping));
    }

    private static async Task<bool> SafeWaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

    // ==================================================================
    //  1. Repair — ask LiveKit about anything stuck.
    // ==================================================================
    private async Task RepairStuckAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var egress = scope.ServiceProvider.GetRequiredService<LiveKitEgressClient>();
        if (!egress.IsConfigured) return;

        var cutoff = DateTimeOffset.UtcNow - StuckAfter;

        // Cross-tenant, so it goes through a definer function like every other
        // pre-tenant read in this module — and it returns IDS ONLY.
        var stuck = await db.Database.SqlQuery<Guid>($"""
            SELECT recording_id AS "Value" FROM connect.stuck_recordings({cutoff}, 5)
            """).ToListAsync(ct);

        foreach (var recordingId in stuck)
        {
            if (await TenantOfRecordingAsync(db, recordingId, ct) is not Guid tenantId) continue;

            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);          // and push it into the DB session

            var recording = await db.ConnectRecordings
                .Where(r => r.Id == recordingId).FirstOrDefaultAsync(ct);
            if (recording is null) continue;

            var state = await egress.DescribeAsync(recording.EgressId, ct);
            if (state is null) continue;

            // Re-assert: DescribeAsync is a network call and the scope must
            // not be assumed to have survived it.
            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);

            var next = state.Status switch
            {
                "EGRESS_STARTING" => "starting",
                "EGRESS_ACTIVE" => "recording",
                "EGRESS_ENDING" => "processing",
                "EGRESS_COMPLETE" or "EGRESS_LIMIT_REACHED"
                    => string.IsNullOrEmpty(state.FileName) ? "failed" : "ready",
                "EGRESS_FAILED" => "failed",
                "EGRESS_ABORTED" => "aborted",
                _ => null,
            };
            if (next is null || next == recording.Status) continue;

            recording.Status = next;
            if (state.FileName is { Length: > 0 } file) recording.FileName = file;
            if (state.SizeBytes > 0) recording.SizeBytes = state.SizeBytes;
            if (state.DurationMs is long ms) recording.DurationMs = ms;
            if (state.EndedAt is { } endedAt) recording.EndedAt ??= endedAt;
            if (state.Error is { Length: > 0 } err) recording.Error = err;
            recording.UpdatedAt = DateTimeOffset.UtcNow;

            await db.SaveChangesAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"SELECT connect.reconcile_recording_storage({tenantId})", ct);

            log.LogInformation(
                "Repaired recording {Recording} from LiveKit: now {Status}", recordingId, next);
        }
    }

    // ==================================================================
    //  2. Transcribe
    // ==================================================================
    private async Task TranscribeAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var transcriber = scope.ServiceProvider.GetRequiredService<ConnectTranscriber>();

        var jobs = await db.Database.SqlQuery<Guid>($"""
            SELECT recording_id AS "Value" FROM connect.pending_transcription({BatchSize})
            """).ToListAsync(ct);

        foreach (var recordingId in jobs)
        {
            if (await TenantOfRecordingAsync(db, recordingId, ct) is not Guid tenantId) continue;

            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);          // and push it into the DB session

            var recording = await db.ConnectRecordings.AsNoTracking()
                .Where(r => r.Id == recordingId).FirstOrDefaultAsync(ct);
            if (recording?.FileName is null) continue;

            // CLAIM IT FIRST — see the header. The row exists and says
            // 'running' before a single byte is sent anywhere.
            var row = await db.ConnectTranscripts
                .Where(t => t.RecordingId == recordingId).FirstOrDefaultAsync(ct);
            if (row is null)
            {
                row = new ConnectTranscript
                {
                    Id = Guid.NewGuid(),
                    RecordingId = recordingId,
                    MeetingId = recording.MeetingId,
                    CreatedAt = DateTimeOffset.UtcNow,
                };
                db.ConnectTranscripts.Add(row);
            }

            if (!transcriber.IsConfigured)
            {
                // Not a failure — nobody switched it on. Recorded as its own
                // state so the screen can say that instead of "something went
                // wrong", which would send somebody looking for a bug.
                row.Status = "unavailable";
                row.Error = "No transcription service is configured for this server.";
                row.UpdatedAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(ct);
                continue;
            }

            row.Status = "running";
            row.Attempts += 1;
            row.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);

            var path = Path.Combine(options.ReadDirectory, recording.FileName);
            var result = await transcriber.TranscribeAsync(
                path, recording.ContentType ?? "application/octet-stream", ct);

            // Minutes may have passed. Re-assert the scope rather than assume
            // it survived — and re-sync, because the pooled connection this
            // context uses next is not necessarily the one it used before.
            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);

            if (result.Ok)
            {
                row.Status = "ready";
                row.Text = result.Text;
                row.Segments = JsonSerializer.Serialize(result.Segments.Select(s => new
                {
                    start = s.Start, end = s.End, text = s.Text, speaker = s.Speaker,
                }));
                row.Language = result.Language;
                row.DurationMs = result.DurationMs;
                row.Provider = Host(options.TranscriptionUrl);
                row.Model = options.TranscriptionModel;
                row.Error = null;

                // The meeting may already have attendance-only notes. Put them
                // back in the queue so they are rewritten WITH the transcript;
                // otherwise the better version never arrives and the transcript
                // sits there unused.
                var existing = await db.ConnectMeetingNotes
                    .Where(n => n.MeetingId == recording.MeetingId).FirstOrDefaultAsync(ct);
                if (existing is not null && existing.Status == "ready" && !existing.HadTranscript)
                {
                    existing.Status = "queued";
                    existing.UpdatedAt = DateTimeOffset.UtcNow;
                }

                log.LogInformation("Transcribed recording {Recording}", recordingId);
            }
            else
            {
                // Back to 'queued' while attempts remain, so the next tick
                // retries a service that was merely restarting. The attempts
                // cap in connect.pending_transcription is what stops it
                // retrying forever.
                row.Status = row.Attempts >= 3 ? "failed" : "queued";
                row.Error = result.Error;
                log.LogWarning("Transcription of {Recording} failed: {Error}",
                    recordingId, result.Error);
            }
            row.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }
    }

    // ==================================================================
    //  3. Notes
    // ==================================================================
    private async Task WriteNotesAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var composer = scope.ServiceProvider.GetRequiredService<ConnectNotesComposer>();

        var jobs = await db.Database.SqlQuery<Guid>($"""
            SELECT meeting_id AS "Value" FROM connect.pending_notes({BatchSize})
            """).ToListAsync(ct);

        foreach (var meetingId in jobs)
        {
            // The function 20260901 already installed for the webhook. Reused
            // rather than duplicated — one definition of "which tenant owns
            // this meeting" is the point of having it.
            var tenantIds = await db.Database.SqlQuery<Guid>($"""
                SELECT tenant_id AS "Value" FROM connect.webhook_meeting_tenant({meetingId})
                """).ToListAsync(ct);
            if (tenantIds.Count == 0) continue;
            var tenantId = tenantIds[0];

            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);          // and push it into the DB session

            var meeting = await db.ConnectMeetings.AsNoTracking()
                .Where(m => m.Id == meetingId).FirstOrDefaultAsync(ct);
            if (meeting is null) continue;

            var transcripts = await db.ConnectTranscripts.AsNoTracking()
                .Where(t => t.MeetingId == meetingId && t.Status == "ready")
                .OrderBy(t => t.CreatedAt)
                .ToListAsync(ct);

            // A meeting can be recorded more than once — stopped and started
            // again. The notes are for the MEETING, so every transcript it has
            // is concatenated in order rather than the last one winning.
            var segments = new List<ConnectTranscriber.Segment>();
            foreach (var t in transcripts) segments.AddRange(ReadSegments(t.Segments));

            // Who attended, as ONE json string rather than a multi-column
            // result: this codebase's only proven raw-query shape is
            // Database.SqlQuery<T> over a SCALAR, and a json_agg is a scalar.
            // It is also exactly what the column stores, so nothing is
            // re-serialised on the way in.
            var attendanceJson = await db.Database.SqlQuery<string>($"""
                SELECT COALESCE(json_agg(json_build_object(
                           'identity', a.identity,
                           'name',     a.display_name,
                           'guest',    a.is_guest,
                           'joinedAt', a.joined_at,
                           'leftAt',   a.left_at,
                           'seconds',  a.seconds,
                           'joins',    a.joins)
                         ORDER BY a.seconds DESC), '[]')::text AS "Value"
                  FROM connect.attendance({meetingId}) a
                """).FirstOrDefaultAsync(ct) ?? "[]";

            var attendance = ReadAttendance(attendanceJson);

            // pending_notes already requires somebody to have joined, so this
            // is a guard rather than the common path.
            if (segments.Count == 0 && attendance.Count == 0) continue;

            var row = await db.ConnectMeetingNotes
                .Where(n => n.MeetingId == meetingId).FirstOrDefaultAsync(ct);
            if (row is null)
            {
                row = new ConnectMeetingNotes
                {
                    Id = Guid.NewGuid(),
                    MeetingId = meetingId,
                    CreatedAt = DateTimeOffset.UtcNow,
                };
                db.ConnectMeetingNotes.Add(row);
            }

            row.Status = "running";      // claimed before the model is called
            row.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);

            var notes = await composer.ComposeAsync(meeting.Title, segments, attendance, ct);

            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);

            row.Status = "ready";
            row.Kind = notes.Kind;
            row.Provider = notes.Provider;
            row.Model = notes.Model;
            row.Summary = notes.Summary;
            row.KeyPoints = JsonSerializer.Serialize(notes.KeyPoints);
            row.Decisions = JsonSerializer.Serialize(notes.Decisions);
            row.ActionItems = JsonSerializer.Serialize(notes.ActionItems);
            row.Speakers = JsonSerializer.Serialize(notes.Speakers.Select(s => new
            {
                name = s.Name, seconds = s.Seconds, turns = s.Turns,
            }));
            // Stored as it came out of SQL, not round-tripped through C#: the
            // database built it, and re-serialising it could only lose
            // something.
            row.Attendance = attendanceJson;
            row.HadTranscript = segments.Count > 0;
            row.Error = null;
            row.GeneratedAt = DateTimeOffset.UtcNow;
            row.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);

            log.LogInformation(
                "Wrote {Kind} notes for meeting {Meeting} ({Attendees} attended, transcript: {Had})",
                notes.Kind, meetingId, attendance.Count, segments.Count > 0);
        }
    }

    // ==================================================================
    //  Helpers
    // ==================================================================

    /// <summary>
    /// Which organisation a recording belongs to, read BEFORE any tenant is
    /// set — so it cannot be an ordinary query. Forced RLS would return
    /// nothing for a row that exists, and the worker would quietly do no work
    /// at all while every log said it ran.
    /// </summary>
    private static async Task<Guid?> TenantOfRecordingAsync(
        AppDbContext db, Guid recordingId, CancellationToken ct)
    {
        var ids = await db.Database.SqlQuery<Guid>($"""
            SELECT tenant_id AS "Value" FROM connect.recording_tenant({recordingId})
            """).ToListAsync(ct);
        return ids.Count == 0 ? null : ids[0];
    }
    private static List<ConnectTranscriber.Segment> ReadSegments(string? raw)
    {
        var list = new List<ConnectTranscriber.Segment>();
        if (string.IsNullOrWhiteSpace(raw)) return list;
        try
        {
            var root = JsonDocument.Parse(raw).RootElement;
            if (root.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in root.EnumerateArray())
            {
                var text = item.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String
                    ? t.GetString() : null;
                if (string.IsNullOrWhiteSpace(text)) continue;
                list.Add(new ConnectTranscriber.Segment(
                    item.TryGetProperty("start", out var s) && s.TryGetDouble(out var sv) ? sv : 0,
                    item.TryGetProperty("end", out var e) && e.TryGetDouble(out var ev) ? ev : 0,
                    text,
                    item.TryGetProperty("speaker", out var sp) && sp.ValueKind == JsonValueKind.String
                        ? sp.GetString() : null));
            }
        }
        catch (JsonException) { }
        return list;
    }

    private static List<ConnectNotesComposer.Attendee> ReadAttendance(string raw)
    {
        var list = new List<ConnectNotesComposer.Attendee>();
        try
        {
            var root = JsonDocument.Parse(raw).RootElement;
            if (root.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in root.EnumerateArray())
            {
                var name = item.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String
                    ? n.GetString() : null;
                if (string.IsNullOrWhiteSpace(name)) continue;
                list.Add(new ConnectNotesComposer.Attendee(
                    name,
                    item.TryGetProperty("guest", out var g) && g.ValueKind == JsonValueKind.True,
                    item.TryGetProperty("seconds", out var s) && s.TryGetInt64(out var sv) ? sv : 0,
                    item.TryGetProperty("joins", out var j) && j.TryGetInt32(out var jv) ? jv : 0));
            }
        }
        catch (JsonException) { }
        return list;
    }

    private static string? Host(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : null;
}

using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Modules.Connect;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;
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

        // The gateway went SCOPED when consent became per-organisation, so a
        // singleton worker cannot hold one; a throwaway scope answers the
        // deployment-capability question for this one log line. Whether a
        // PARTICULAR meeting gets model notes is decided per-tenant inside
        // the gateway at compose time — "by model" here means "a key exists",
        // and per-org consent decides the rest, meeting by meeting.
        bool aiCapable;
        using (var probe = scopes.CreateScope())
            aiCapable = probe.ServiceProvider
                .GetRequiredService<TatvaOS.Api.Shared.Ai.IAiGateway>().IsConfigured;
        log.LogInformation(
            "Connect notes worker running every {Seconds}s (transcription {Transcription}, notes {Notes})",
            Tick.TotalSeconds,
            options.TranscriptionConfigured ? "configured" : "NOT configured",
            aiCapable ? "by model, per-org consent" : "digest only");

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
                    // Retention, AFTER repair: a recording the repair pass is
                    // about to mark ready must not be aged out by a sweep
                    // that saw it mid-flight. expired_recordings only offers
                    // 'ready' rows, so the ordering is belt and braces — but
                    // braces are cheap and the failure is a customer's
                    // recording.
                    await SweepExpiredRecordingsAsync(stopping);
                }
                await WriteNotesAsync(stopping);

                // Sending the minutes is its own pass, AFTER writing them.
                // Same tick, separate scope: a meeting whose notes were just
                // written is emailed on the NEXT tick, a minute later, which
                // is the difference between a document and a draft nobody
                // asked for. It also means a mail server being down cannot
                // stop notes being written for everybody else.
                await MailMinutesAsync(stopping);
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

            // A FOURTH copy of this mapping used to live here, inline. The
            // other three were in ConnectWebhookEndpoints, LiveKitEgressClient
            // and a helper — and one of them was wrong, which is how this
            // module lost a day. There is one now, in ConnectWire, and it is
            // the one the wire tests point at.
            var next = ConnectWire.MapEgressStatus(state.Status, state.FileName);
            if (next is null || next == recording.Status) continue;

            recording.Status = next;
            if (state.FileName is { Length: > 0 } file) recording.FileName = file;
            if (state.SizeBytes > 0) recording.SizeBytes = state.SizeBytes;
            if (state.DurationMs is long ms) recording.DurationMs = ms;
            if (state.EndedAt is { } endedAt) recording.EndedAt ??= endedAt;
            if (state.Error is { Length: > 0 } err) recording.Error = err;
            recording.UpdatedAt = DateTimeOffset.UtcNow;

            // The repaired recording may have landed AFTER notes were written
            // believing there was none — same mirror as the webhook path.
            if (next == "ready")
            {
                var staleNotes = await db.ConnectMeetingNotes
                    .Where(n => n.MeetingId == recording.MeetingId
                             && n.Status == "ready" && !n.HadRecording)
                    .FirstOrDefaultAsync(ct);
                if (staleNotes is not null)
                {
                    staleNotes.Status = "queued";
                    staleNotes.UpdatedAt = DateTimeOffset.UtcNow;
                }
            }

            await db.SaveChangesAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"SELECT connect.reconcile_recording_storage({tenantId})", ct);

            log.LogInformation(
                "Repaired recording {Recording} from LiveKit: now {Status}", recordingId, next);
        }
    }

    // ==================================================================
    //  1b. Retention — the sweep that makes the 90-day promise true.
    //
    //  Decided 19 August; spec in docs/CONNECT_DECISIONS.md §1. The
    //  candidates come from connect.expired_recordings — SECURITY DEFINER,
    //  ids only, 'ready' rows past the org's retention with no keep_until_at
    //  exemption. The deletion itself mirrors the host's own Delete button,
    //  deliberately: file first, row to 'deleted' only if the file actually
    //  went, storage reconciled, audit row written. A retention policy that
    //  frees no disk is decoration, and one that cannot say where a
    //  recording went is a shrug.
    //
    //  WHAT GOES AND WHAT STAYS — one ruling made here, flagged for Amit:
    //  the recording's TRANSCRIPT rows go with it (they are the words,
    //  verbatim — keeping them would defeat the reason an organisation
    //  shortens retention), but the NOTES stay. Notes are the meeting's
    //  record — summary, decisions, attendance — and they were already
    //  emailed to the room; deleting minutes because their audio aged out
    //  would surprise everyone who filed them. The spec's sentence "the
    //  transcript and notes follow the same rule" is read here as "follow
    //  the recording's lifecycle rule" for the transcript and NOT for the
    //  notes; if Amit means notes too, this method is the one place to
    //  change.
    //
    //  BOUNDED PER PASS. Ten per tick, so a first run against a year of
    //  recordings drains over hours rather than saturating the disk queue
    //  on a box that is also delivering mail — the spec's own requirement.
    // ==================================================================
    private const int SweepBatch = 10;

    private async Task SweepExpiredRecordingsAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var audit = scope.ServiceProvider.GetRequiredService<TatvaOS.Api.Modules.Admin.AuditWriter>();

        var expired = await db.Database.SqlQuery<Guid>($"""
            SELECT recording_id AS "Value" FROM connect.expired_recordings({SweepBatch})
            """).ToListAsync(ct);

        foreach (var recordingId in expired)
        {
            if (await TenantOfRecordingAsync(db, recordingId, ct) is not Guid tenantId) continue;

            tenant.EnterAnonymousScope(tenantId, "system");
            await db.SyncTenantAsync(ct);          // and push it into the DB session

            var recording = await db.ConnectRecordings
                .Where(r => r.Id == recordingId && r.Status == "ready")
                .FirstOrDefaultAsync(ct);
            if (recording is null) continue;

            // The file first, and a failure leaves the ROW alone: 'deleted'
            // with bytes still on disk is a lie that becomes a wrong bill —
            // the same rule as the host's Delete button.
            if (Modules.Connect.Endpoints.ConnectRecordingEndpoints
                    .ResolvePath(options, recording.FileName) is { } path)
            {
                try { if (File.Exists(path)) File.Delete(path); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    log.LogError(ex,
                        "Retention could not delete recording file {File}; row left as ready",
                        recording.FileName);
                    continue;
                }
            }

            recording.Status = "deleted";
            recording.SizeBytes = 0;
            recording.FileName = null;
            recording.UpdatedAt = DateTimeOffset.UtcNow;

            // The verbatim words go with the audio; the notes stay. See the
            // ruling in this method's header.
            var transcripts = await db.ConnectTranscripts
                .Where(t => t.RecordingId == recordingId)
                .ToListAsync(ct);
            db.ConnectTranscripts.RemoveRange(transcripts);

            await db.SaveChangesAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"SELECT connect.reconcile_recording_storage({tenantId})", ct);

            // "Where did my recording go" must be answerable with a row.
            await audit.WriteAsync("connect.recording.expired",
                "connect.meeting", recording.MeetingId.ToString(),
                after: new { recording.Id, retention = true },
                ct: ct, productCode: "connect");

            log.LogInformation(
                "Retention swept recording {Recording} (meeting {Meeting})",
                recordingId, recording.MeetingId);
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
                //
                // UNLESS THE ANSWER CANNOT CHANGE. A file the service refuses
                // as too large, or a model name it does not have, will be
                // refused identically next tick — the request is the same
                // request. On 22 August that cost three uploads of the same
                // 36 MB to collect the same 413 three times, and delayed the
                // honest 'failed' by two minutes for no gain at all.
                row.Status = result.Permanent || row.Attempts >= 3 ? "failed" : "queued";
                row.Error = result.Error;
                log.LogWarning("Transcription of {Recording} failed ({Kind}): {Error}",
                    recordingId, result.Permanent ? "permanent" : "will retry", result.Error);
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
            // The function 20260817-connect already installed for the webhook. Reused
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

            // ── CAPTIONS, WHEN THERE ARE NO PAID TRANSCRIPTS ──────────────
            //
            // The browsers already turned this meeting's speech into text
            // while it was happening, for nothing. Paid transcription of a
            // 31-minute meeting cost ₹16.6 against ₹0.40 for the model that
            // writes the actual minutes — 97% of the bill for the part the
            // browser does free.
            //
            // A TRANSCRIPT WINS WHERE ONE EXISTS, and that ordering matters:
            // a recording heard the whole room, captions heard only the
            // Chrome users who stayed. If somebody paid for transcription,
            // they get the better record.
            //
            // Captions arrive already attributed, which paid transcription of
            // a mixed recording does not manage at all — so the speaker's name
            // goes into the segment, and the notes model can write "Rahul will
            // send the pricing sheet" instead of "somebody will".
            if (segments.Count == 0)
                segments.AddRange(await ReadCaptionsAsync(db, meetingId, ct));

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
            // pending_notes has already waited for every recording to settle,
            // so this is a fact, not a race: either a usable recording exists
            // now or it never will. 'ready' only — a failed egress produced
            // nothing anybody can check the minutes against.
            row.HadRecording = await db.ConnectRecordings.AsNoTracking()
                .AnyAsync(r => r.MeetingId == meetingId && r.Status == "ready", ct);
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
    // ==================================================================
    //  4. The minutes email.
    //
    //  OFF BY DEFAULT, PER ORGANISATION. connect.pending_minutes_email only
    //  returns rows for a tenant whose connect_email_minutes is true, and it
    //  defaults to FALSE. This is outbound mail about what was said in a room,
    //  to people including guests; no deployment starts sending it because a
    //  migration ran.
    //
    //  THE ATTEMPT IS SAVED BEFORE THE SEND. A crash between the two burns one
    //  attempt that never happened — the cost is one lost email out of three
    //  tries. Saving afterwards would re-send the same minutes to everybody in
    //  the meeting every minute until the crash stopped, which is the failure
    //  people build a filter rule for. The database caps it at three attempts
    //  so even the bad case is bounded.
    // ==================================================================
    private async Task MailMinutesAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var mailer = scope.ServiceProvider.GetRequiredService<SystemMailer>();
        var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();

        var jobs = await db.Database.SqlQuery<Guid>($"""
            SELECT notes_id AS "Value" FROM connect.pending_minutes_email({BatchSize})
            """).ToListAsync(ct);

        foreach (var notesId in jobs)
        {
            var tenantIds = await db.Database.SqlQuery<Guid>($"""
                SELECT tenant_id AS "Value" FROM connect.notes_tenant({notesId})
                """).ToListAsync(ct);
            if (tenantIds.Count == 0) continue;

            tenant.EnterAnonymousScope(tenantIds[0], "system");
            await db.SyncTenantAsync(ct);          // and push it into the DB session

            // Read under the policy, like everything else. The definer
            // function handed over an id and nothing more.
            var notes = await db.ConnectMeetingNotes
                .Where(n => n.Id == notesId).FirstOrDefaultAsync(ct);
            if (notes is null) continue;

            // Claim it before doing any work, and SAVE that claim. Two API
            // containers will exist one day and 'find the queue, then send'
            // with no claim is how both of them mail the same minutes.
            notes.EmailAttempts++;
            await db.SaveChangesAsync(ct);

            try
            {
                var result = await ConnectMinutesMailer.SendAsync(
                    mailer, config, log, db, notes.MeetingId, notes, ct);

                // Re-assert the scope: SendAsync makes network calls and the
                // scope must not be assumed to have survived them.
                tenant.EnterAnonymousScope(tenantIds[0], "system");
                await db.SyncTenantAsync(ct);

                await db.SaveChangesAsync(ct);

                if (!result.Sent)
                    log.LogWarning("Minutes for meeting {Meeting} were not sent: {Error}",
                        notes.MeetingId, result.Error);
            }
            catch (Exception ex)
            {
                // The claim stands. Three of these and the database stops
                // offering this row, which is the point of counting.
                log.LogError(ex, "Sending minutes for meeting {Meeting} threw", notes.MeetingId);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Reading the jsonb columns back.
    //
    //  These two read JSON this platform wrote itself, which is exactly why
    //  they used to read it carelessly: TryGetDouble and TryGetInt64 straight
    //  off a property, no ValueKind check, on the reasoning that we know what
    //  we put there.
    //
    //  We do not, for three reasons. transcripts.segments is written from
    //  whatever a transcription service returned, and this box is about to run
    //  its own Whisper — a different wrapper quotes its numbers. A jsonb column
    //  can be corrected by hand at 2 a.m. And those TryGet methods THROW on the
    //  wrong kind rather than returning false, while the catch below only
    //  handles JsonException — so one odd row would take down the notes worker
    //  for every meeting queued behind it, silently, exactly as one line in
    //  the webhook handler took down every event on the platform.
    //
    //  ConnectWire returns null instead. A segment with a missing offset is a
    //  slightly worse transcript; an exception here is no minutes at all.
    // ══════════════════════════════════════════════════════════════════════
    /// <summary>
    /// The meeting's captions as transcript segments, in spoken order, with
    /// the speaker's name attached.
    ///
    /// Timestamps are relative to the FIRST line rather than absolute, because
    /// that is what a transcript's Start means everywhere else in this module
    /// — "eleven minutes into the meeting", not "14:03 on Tuesday". Getting
    /// that wrong would render as a timeline starting at 1,787,000,000.
    /// </summary>
    private static async Task<List<ConnectTranscriber.Segment>> ReadCaptionsAsync(
        AppDbContext db, Guid meetingId, CancellationToken ct)
    {
        var lines = await db.ConnectCaptionLines.AsNoTracking()
            .Where(c => c.MeetingId == meetingId)
            .OrderBy(c => c.SpokenAt)
            .Join(db.ConnectParticipants.AsNoTracking(),
                  c => c.ParticipantId, p => (Guid?)p.Id,
                  (c, p) => new { c.Text, c.SpokenAt, p.DisplayName })
            .ToListAsync(ct);

        if (lines.Count == 0) return [];

        var start = lines[0].SpokenAt;

        return lines
            .Select(l =>
            {
                var offset = (l.SpokenAt - start).TotalSeconds;
                return new ConnectTranscriber.Segment(
                    offset, offset, l.Text, l.DisplayName);
            })
            .ToList();
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
                var text = ConnectWire.Text(item, "text");
                if (string.IsNullOrWhiteSpace(text)) continue;
                list.Add(new ConnectTranscriber.Segment(
                    ConnectWire.Real(item, "start") ?? 0,
                    ConnectWire.Real(item, "end") ?? 0,
                    text,
                    ConnectWire.Text(item, "speaker")));
            }
        }
        catch (JsonException) { }
        return list;
    }

    private static List<ConnectNotesModel.Attendee> ReadAttendance(string raw)
    {
        var list = new List<ConnectNotesModel.Attendee>();
        try
        {
            var root = JsonDocument.Parse(raw).RootElement;
            if (root.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in root.EnumerateArray())
            {
                var name = ConnectWire.Text(item, "name");
                if (string.IsNullOrWhiteSpace(name)) continue;
                list.Add(new ConnectNotesModel.Attendee(
                    name,
                    ConnectWire.Flag(item, "guest"),
                    ConnectWire.Number(item, "seconds") ?? 0,
                    (int)Math.Clamp(ConnectWire.Number(item, "joins") ?? 0, 0, int.MaxValue)));
            }
        }
        catch (JsonException) { }
        return list;
    }

    private static string? Host(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : null;
}

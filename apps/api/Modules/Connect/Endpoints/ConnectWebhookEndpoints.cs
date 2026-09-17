using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// The platform's first inbound webhook, so the rules are written down rather
/// than assumed.
///
/// ─────────────────────────────────────────────────────────────────────────
///  VERIFICATION IS THE CONTROL, NOT REACHABILITY.
///
///  This route is anonymous and reachable from the internet. That is safe only
///  because every request must carry a JWT signed with the LiveKit API secret
///  whose sha256 claim matches the body — checked in LiveKitTokenService
///  against the scheme the official SDK implements. An unverifiable request is
///  401 and NOTHING is written.
///
///  REPLAYS ARE FREE. LiveKit retries. A retried join must not become a second
///  join, so every row carries LiveKit's event id under a unique index and a
///  duplicate is a no-op rather than an error — otherwise a retry storm turns
///  into an attendance report nobody can trust.
///
///  TENANCY: a webhook has no user and no JWT of ours, so app.tenant_id is
///  unset — and that is when forced RLS is at its MOST absolute, not its
///  least. The first read therefore goes through a SECURITY DEFINER function
///  (connect.webhook_meeting_tenant), the same pattern as every guest-path
///  read, and the tenant it returns is entered before anything is written.
///  An earlier version of this file believed the opposite — "RLS is not in
///  play yet" — read zero rows through an ordinary query, and acknowledged
///  every event with 200 while writing none of them. LiveKit's log said
///  delivered; the attendance table said nothing happened. Do not reintroduce
///  that query.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectWebhookEndpoints
{
    public static void MapConnectWebhookEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/connect/webhooks/livekit", ReceiveAsync)
           .AllowAnonymous()
           .WithTags("Connect");
    }

    /// <summary>
    /// The outer wrapper exists because of one line inside.
    ///
    /// A JsonElement.TryGetInt64 against a String throws rather than returning
    /// false, and that exception went unhandled: Kestrel answered 500, LiveKit
    /// retried five times and gave up, and the ONLY visible symptom was an
    /// empty table. Nothing in this module said a word — the honest 500-on-
    /// DbUpdateException added earlier never fired, because the throw happened
    /// long before SaveChanges and was not a DbUpdateException.
    ///
    /// So anything unexpected in here is now caught, LOGGED AS AN ERROR with
    /// the event kind, and answered 200.
    ///
    /// 200, not 500, and the choice matters. An unhandled exception here is a
    /// BUG IN THIS CODE, and a bug does not become less true on the second
    /// attempt: LiveKit would retry five times per event, fail five times, and
    /// bury the one useful log line under four useless ones while the queue
    /// backed up behind it. The alarm is the log, which now names the event.
    /// A TRANSIENT failure — the database being briefly unreachable — is still
    /// answered 500 further down, where it can be told apart, because there a
    /// retry genuinely helps.
    /// </summary>
    private static async Task<IResult> ReceiveAsync(
        HttpContext http, AppDbContext db, TenantContext tenant,
        LiveKitTokenService tokens, LiveKitEgressClient egress,
        ConnectRecordingOptions recOptions, LiveKitRoomClient rooms,
        ILogger<LiveKitTokenService> log, CancellationToken ct)
    {
        try
        {
            return await HandleAsync(http, db, tenant, tokens, egress, recOptions, rooms, log, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogError(ex,
                "LiveKit webhook handler threw. THIS IS A BUG IN ConnectWebhookEndpoints, "
                + "not a transient failure — the event is dropped rather than retried, "
                + "because retrying will fail identically.");
            return Results.Ok();
        }
    }

    private static async Task<IResult> HandleAsync(
        HttpContext http, AppDbContext db, TenantContext tenant,
        LiveKitTokenService tokens, LiveKitEgressClient egress,
        ConnectRecordingOptions recOptions, LiveKitRoomClient rooms,
        ILogger<LiveKitTokenService> log, CancellationToken ct)
    {
        if (!tokens.IsConfigured) return Results.StatusCode(503);

        // The RAW bytes, because the signature covers exactly these. Re-
        // serialising parsed JSON would change the bytes and fail every time.
        using var buffer = new MemoryStream();
        await http.Request.Body.CopyToAsync(buffer, ct);
        var body = buffer.ToArray();

        var auth = http.Request.Headers.Authorization.ToString();
        if (!tokens.VerifyWebhook(auth, body))
        {
            log.LogWarning("Rejected an unverifiable LiveKit webhook ({Bytes} bytes)", body.Length);
            return Results.Unauthorized();
        }

        JsonElement root;
        try { root = JsonDocument.Parse(body).RootElement; }
        catch (JsonException) { return Results.BadRequest(); }

        var eventName = ConnectWire.Text(root, "event");
        if (string.IsNullOrEmpty(eventName)) return Results.Ok();

        // ── SCREEN SHARES ONLY, AND BEFORE THE IGNORE LIST. ────────────────
        //
        // track_published and track_unpublished are on EventKind's deliberate
        // ignore list, and they stay there: they are the events whose healthy
        // 200s once made this log look fine for a day while everything that
        // mattered was failing. Single-sharer mode needs to see a screen share
        // start and stop (docs/CONNECT_PHASE_NEXT.md §4), so exactly that is
        // lifted out here — filtered to SCREEN_SHARE, never recorded as a
        // meeting event, and camera and microphone churn still dropped.
        //
        // If you are reading LiveKit's webhook log to decide whether delivery
        // works, a 200 for track_published still proves nothing about the
        // events that matter.
        if (eventName is "track_published" or "track_unpublished")
            return await HandleScreenShareAsync(eventName, root, db, tenant, rooms, log, ct);

        // Every wire-format decision lives in ConnectWire. See its header for
        // why: the same knowledge used to live in two files and only one of
        // them was right.
        var kind = ConnectWire.EventKind(eventName);
        // Unknown events are acknowledged and dropped: answering anything else
        // makes LiveKit retry forever over something we deliberately ignore.
        if (kind is null) return Results.Ok();

        if (!ConnectWire.TryMeetingId(root, out var meetingId)) return Results.Ok();

        // No tenant is set yet, so this CANNOT be an ordinary query — forced
        // RLS would return zero rows for a meeting that exists, and this
        // handler would acknowledge the event while recording nothing (it did
        // exactly that once; see the header). The definer function is the
        // narrowest possible read: one column, keyed by primary key, granted
        // only to the app role. AS "Value" is EF's required alias for scalar
        // SqlQuery — same as every other scalar SqlQuery in this codebase.
        var meetingTenant = await EnterMeetingTenantAsync(db, tenant, meetingId, ct);
        if (meetingTenant is not Guid meetingTenantId) return Results.Ok();

        // AND PUSH IT INTO THE DATABASE SESSION. EnterAnonymousScope changes a
        // C# object; app.tenant_id is what RLS actually reads, and the
        // interceptor only sets it when a connection OPENS. A connection
        // already opened for the lookup above still carries no tenant, so the
        // INSERT below fails its RLS check — as a DbUpdateException, which
        // this handler used to swallow. Every other module in this codebase
        // (Auth, Admin — sixteen sites) calls this on the line after changing
        // scope. Connect was the only one that did not.
        await db.SyncTenantAsync(ct);

        var webhookId = ConnectWire.Text(root, "id");
        if (!string.IsNullOrEmpty(webhookId))
        {
            var seen = await db.ConnectMeetingEvents.AsNoTracking()
                .AnyAsync(e => e.WebhookId == webhookId, ct);
            if (seen) return Results.Ok();   // a retry, not a second join
        }

        var identity = ConnectWire.ParticipantText(root, "identity");
        var displayName = ConnectWire.ParticipantText(root, "name");

        // createdAt arrives as a STRING, not a number. See UnixSeconds below —
        // this one line, written the obvious way, threw on every webhook this
        // handler actually processed, for the entire life of the module.
        // Rule 1 and rule 2 in ConnectWire: createdAt is a STRING, and
        // TryGetInt64 throws on one rather than returning false. That single
        // line, written the obvious way, broke every webhook this handler
        // processed for the life of the module.
        var occurredAt = ConnectWire.Seconds(root, "createdAt") ?? DateTimeOffset.UtcNow;

        db.ConnectMeetingEvents.Add(new ConnectMeetingEvent
        {
            MeetingId = meetingId,
            Kind = kind,
            Identity = identity,
            DisplayName = displayName,
            OccurredAt = occurredAt,
            WebhookId = string.IsNullOrEmpty(webhookId) ? null : webhookId,
            Payload = System.Text.Encoding.UTF8.GetString(body),
            CreatedAt = DateTimeOffset.UtcNow,
        });

        var meeting = await db.ConnectMeetings.Where(m => m.Id == meetingId).FirstOrDefaultAsync(ct);
        if (meeting is not null)
        {
            switch (kind)
            {
                case "room_started":
                    meeting.Status = "active";
                    meeting.StartedAt ??= occurredAt;
                    meeting.UpdatedAt = DateTimeOffset.UtcNow;
                    break;

                case "room_finished":
                    // Only 'active' advances to 'ended'. A cancelled meeting
                    // whose empty room times out must stay cancelled.
                    if (meeting.Status is "active" or "scheduled") meeting.Status = "ended";
                    meeting.EndedAt ??= occurredAt;
                    meeting.UpdatedAt = DateTimeOffset.UtcNow;
                    break;
            }
        }

        if (!string.IsNullOrEmpty(identity) && kind is "participant_joined" or "participant_left")
        {
            // The event names a device; the row is the person.
            var personIdentity = ConnectCodes.PersonOf(identity);
            var person = await db.ConnectParticipants
                .Where(p => p.MeetingId == meetingId && p.Identity == personIdentity)
                .FirstOrDefaultAsync(ct);
            if (person is not null)
            {
                if (kind == "participant_joined") person.FirstJoinedAt ??= occurredAt;
                person.LastSeenAt = occurredAt;
            }
        }

        // ------------------------------------------------------------------
        //  Egress: what a recording row learns from the media server.
        //
        //  The row is created by ConnectRecordingEndpoints when LiveKit
        //  accepts the request; this only ever UPDATES one. If it is missing,
        //  the callback simply ran ahead of our own commit — a few
        //  milliseconds is normal — and nothing is invented here, because a
        //  row built from a webhook would have no mode, no requester and no
        //  transcribe flag. ConnectNotesWorker asks LiveKit directly about
        //  anything left stuck, so a lost callback costs a delay, not a
        //  recording.
        // ------------------------------------------------------------------
        var reconcileStorage = false;
        if (kind is "egress_started" or "egress_updated" or "egress_ended" && ConnectWire.TryEgress(root, out var egressInfo))
        {
            var state = ConnectWire.ReadEgress(egressInfo);
            if (state.EgressId is { Length: > 0 } egressId)
            {
                var recording = await db.ConnectRecordings
                    .Where(r => r.EgressId == egressId)
                    .FirstOrDefaultAsync(ct);

                if (recording is not null && recording.Status != "deleted")
                {
                    var next = ConnectWire.MapEgressStatus(state.Status, state.FileName);
                    if (next is not null) recording.Status = next;

                    if (state.FileName is { Length: > 0 } file) recording.FileName = file;
                    if (state.SizeBytes > 0) recording.SizeBytes = state.SizeBytes;
                    if (state.DurationMs is long ms) recording.DurationMs = ms;
                    if (state.StartedAt is { } startedAt) recording.StartedAt ??= startedAt;
                    if (state.EndedAt is { } endedAt) recording.EndedAt ??= endedAt;
                    // ── WHAT THE HOST READS, NOT WHAT THE RECORDER SAID. ──
                    //
                    //  This used to store the egress message verbatim, and
                    //  the meeting page rendered it in red under the
                    //  recording. A host who had waited through a meeting
                    //  was told "context deadline exceeded" and left to work
                    //  out whether their recording existed.
                    //
                    //  ConnectEgressErrors answers the two questions they
                    //  actually have — is it lost, and can I do anything —
                    //  and passes anything it does not recognise straight
                    //  through rather than replacing it with a shrug.
                    //
                    //  THE RAW TEXT IS NOT LOST. It is logged here against
                    //  the recording id, because the translation is for the
                    //  screen and the original is what anybody debugging
                    //  this will need.
                    if (state.Error is { Length: > 0 } err)
                    {
                        log.LogWarning(
                            "Connect egress {EgressId} (recording {RecordingId}) failed: {RawError}",
                            egressId, recording.Id, err);
                        recording.Error = ConnectEgressErrors.InPlainWords(err);
                    }
                    recording.UpdatedAt = DateTimeOffset.UtcNow;

                    // Derived, never incremented — see the migration header.
                    // Only when the size can actually have moved.
                    reconcileStorage = recording.Status is "ready" or "failed" or "aborted";

                    // The mirror of the transcript rule in ConnectNotesWorker:
                    // notes written believing there was no recording are put
                    // back in the queue the moment a recording lands. With
                    // 20260906's deferral this is a belt-and-braces race
                    // guard, not the normal path — but the normal path is
                    // exactly what the deferral was, until the first proven
                    // run showed the gap.
                    if (recording.Status == "ready")
                    {
                        var staleNotes = await db.ConnectMeetingNotes
                            .Where(n => n.MeetingId == meetingId
                                     && n.Status == "ready" && !n.HadRecording)
                            .FirstOrDefaultAsync(ct);
                        if (staleNotes is not null)
                        {
                            staleNotes.Status = "queued";
                            staleNotes.UpdatedAt = DateTimeOffset.UtcNow;
                        }
                    }
                }
            }
        }

        var saved = false;
        try
        {
            await db.SaveChangesAsync(ct);
            saved = true;
            if (reconcileStorage)
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"SELECT connect.reconcile_recording_storage({meetingTenantId})", ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            // 23505, unique_violation, on the webhook_id index: a replay that
            // arrived while the first copy was still in flight. Losing that
            // race is the correct outcome, not an error — and `saved` stays
            // false, because the failed INSERT is still in the change tracker
            // and any later SaveChanges on this context would replay it.
            log.LogDebug("Duplicate LiveKit webhook {WebhookId} ignored", webhookId);
        }
        catch (DbUpdateException ex)
        {
            // ANYTHING ELSE IS LOUD. This catch used to swallow every
            // DbUpdateException, which meant an RLS refusal — the row silently
            // not being written — looked identical to a harmless replay, and
            // we answered 200. LiveKit never retries a 200, so each of those
            // events was lost for good and the attendance table stayed empty
            // while every log said delivered.
            //
            // 500 is deliberate: it is visible, and it makes LiveKit retry.
            log.LogError(ex,
                "Could not record LiveKit webhook {Kind} for meeting {MeetingId}. "
                + "The event is LOST unless LiveKit retries.", kind, meetingId);
            return Results.StatusCode(500);
        }

        // ── AUTO-RECORD, after the event is safely written. ────────────────
        //
        // The flag was the host's request at creation time; the room starting
        // is the moment it is acted on, because that is when the media server
        // says the meeting exists. Kept OUT of the transaction above and
        // failure-isolated below: a recording that cannot start must cost a
        // recording, never the event — the event log sitting empty for the
        // module's whole life is how this file learned that priority.
        // MediaIsReadable first, and it is not merely "the flag is unchecked":
        // a private meeting cannot carry auto_record at all (the API refuses
        // it, and meetings_private_no_autorecord makes the row
        // unrepresentable), so this can only be reached by a row that
        // predates the constraint or was written around it. Either way the
        // answer is the same — there is nothing decodable to record — and
        // saying so here means the auto-record path is inert for private
        // meetings by its own test, not by the absence of a flag.
        if (saved && kind == "room_started"
            && meeting is { AutoRecord: true, MediaIsReadable: true })
        {
            await TryAutoRecordAsync(db, egress, recOptions, meeting, meetingTenantId, log, ct);
        }
        else if (saved && kind == "room_started" && meeting is { AutoRecord: true })
        {
            log.LogWarning(
                "Auto-record for {MeetingId} ignored: the meeting is private, so its media "
                + "cannot be decoded. A private meeting should not have carried this flag — "
                + "check how the row was written.", meeting.Id);
        }

        return Results.Ok();
    }

    /// <summary>
    /// Enter the tenant a meeting belongs to, from a webhook that carries no
    /// session. Returns the tenant, or null for a meeting that does not exist.
    ///
    /// No tenant is set yet, so this CANNOT be an ordinary query — forced RLS
    /// would return zero rows for a meeting that exists, and the handler would
    /// acknowledge the event while doing nothing (it did exactly that once;
    /// see the header). The definer function is the narrowest possible read:
    /// one column, keyed by primary key, granted only to the app role.
    ///
    /// ONE copy, shared by the room events and the screen-share events. The
    /// caller still owes db.SyncTenantAsync — see the comment where each path
    /// calls it for why that line is load-bearing.
    /// </summary>
    private static async Task<Guid?> EnterMeetingTenantAsync(
        AppDbContext db, TenantContext tenant, Guid meetingId, CancellationToken ct)
    {
        // AS "Value" is EF's required alias for scalar SqlQuery — same as every
        // other scalar SqlQuery in this codebase.
        var tenantIds = await db.Database
            .SqlQuery<Guid>($"""
                SELECT tenant_id AS "Value" FROM connect.webhook_meeting_tenant({meetingId})
                """)
            .ToListAsync(ct);
        if (tenantIds.Count == 0) return null;
        tenant.EnterAnonymousScope(tenantIds[0], "system");
        return tenantIds[0];
    }

    /// <summary>
    /// A screen share started or stopped. In a single-sharer meeting, bring
    /// every grant in the room into line; in any other meeting, do nothing.
    ///
    /// Always 200. Like the rest of this handler, a failure here is either a
    /// bug (which a retry repeats) or LiveKit not answering (which
    /// ConnectShareEnforcement already logs by meeting) — neither is helped by
    /// making LiveKit retry. And nothing is written to connect.meeting_events:
    /// a presenter toggling their slides is not attendance.
    /// </summary>
    private static async Task<IResult> HandleScreenShareAsync(
        string eventName, JsonElement root, AppDbContext db, TenantContext tenant,
        LiveKitRoomClient rooms, ILogger log, CancellationToken ct)
    {
        // Source, not type — see ConnectWire.TrackText.
        var source = ConnectWire.TrackText(root, "source");
        if (!string.Equals(source, "SCREEN_SHARE", StringComparison.OrdinalIgnoreCase))
            return Results.Ok();

        if (!ConnectWire.TryMeetingId(root, out var meetingId)) return Results.Ok();
        if (await EnterMeetingTenantAsync(db, tenant, meetingId, ct) is null) return Results.Ok();
        // The same load-bearing line as the room-event path: scope on the C#
        // object means nothing to RLS until it is pushed into the session.
        await db.SyncTenantAsync(ct);

        var meeting = await db.ConnectMeetings.AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == meetingId, ct);

        // Multiple mode needs nothing: every grant already follows the policy.
        if (meeting is null || meeting.ShareMode != ConnectShare.ModeSingle)
            return Results.Ok();

        var who = ConnectWire.ParticipantText(root, "identity");
        await ConnectShareEnforcement.ApplyAsync(db, rooms, meeting,
            justPublishedBy: eventName == "track_published" && !string.IsNullOrEmpty(who) ? who : null,
            log, ct);
        return Results.Ok();
    }

    /// <summary>
    /// Start the recording the host asked for at creation time.
    ///
    /// The THREE GATES from ConnectRecordingEndpoints.StartAsync, re-checked
    /// NOW rather than trusted from when the meeting was made: the org flag
    /// (switching recording off must stop auto-record on meetings that already
    /// carry the flag) and the storage pool. The who-may-command gate is the
    /// flag itself — only a host could set it. The "is anybody in the room"
    /// gate needs no LiveKit round-trip here: room_started IS the media server
    /// saying so.
    ///
    /// Every refusal is a LOG LINE, not a failure — there is no request to
    /// answer and nobody to show a sentence to. The log names the reason so
    /// "my meeting did not record itself" is a grep, not an investigation.
    /// </summary>
    private static async Task TryAutoRecordAsync(
        AppDbContext db, LiveKitEgressClient egress, ConnectRecordingOptions recOptions,
        ConnectMeeting meeting, Guid tenantId,
        ILogger<LiveKitTokenService> log, CancellationToken ct)
    {
        try
        {
            if (!egress.IsConfigured)
            {
                log.LogWarning("Auto-record for {MeetingId}: no egress on this server", meeting.Id);
                return;
            }

            var allowed = await db.Database
                .SqlQuery<bool>($"""SELECT connect.recording_allowed({tenantId}) AS "Value" """)
                .FirstOrDefaultAsync(ct);
            if (!allowed)
            {
                log.LogInformation(
                    "Auto-record for {MeetingId}: recording is switched off for the organisation",
                    meeting.Id);
                return;
            }

            // A retried room_started, or a host who beat the webhook to the
            // button, must not become a second egress.
            var already = await db.ConnectRecordings
                .Where(r => r.MeetingId == meeting.Id
                         && (r.Status == "starting" || r.Status == "recording"))
                .AnyAsync(ct);
            if (already) return;

            var headroom = await db.Database
                .SqlQuery<long>($"""SELECT connect.storage_headroom({tenantId}) AS "Value" """)
                .FirstOrDefaultAsync(ct);
            if (headroom >= 0 && headroom < recOptions.MinimumFreeBytes)
            {
                log.LogWarning(
                    "Auto-record for {MeetingId}: the organisation's storage pool is full",
                    meeting.Id);
                return;
            }

            // Audio, the measured default everywhere in this module — 1 CPU
            // against 4, on the box that is also running the SFU.
            var fileName = $"{meeting.Id:N}-{ConnectCodes.New()[..12]}.ogg";
            var started = await egress.StartAsync(meeting.Id, "audio", fileName, ct);
            if (started?.EgressId is not { Length: > 0 } egressId)
            {
                log.LogWarning("Auto-record for {MeetingId}: LiveKit did not start the egress",
                    meeting.Id);
                return;
            }

            db.ConnectRecordings.Add(new ConnectRecording
            {
                Id = Guid.NewGuid(),
                MeetingId = meeting.Id,
                EgressId = egressId,
                Mode = "audio",
                Status = "starting",
                FileName = fileName,
                ContentType = "audio/ogg",
                // Nobody pressed the button. The row says so honestly rather
                // than crediting the host with an act they scheduled.
                RequestedByUserId = null,
                Transcribe = true,
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow,
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The event above is already committed; auto-record failing may
            // cost the recording and nothing else.
            log.LogError(ex, "Auto-record for {MeetingId} threw", meeting.Id);
        }
    }

}

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
        LiveKitTokenService tokens, ILogger<LiveKitTokenService> log, CancellationToken ct)
    {
        try
        {
            return await HandleAsync(http, db, tenant, tokens, log, ct);
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
        LiveKitTokenService tokens, ILogger<LiveKitTokenService> log, CancellationToken ct)
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
        var tenantIds = await db.Database
            .SqlQuery<Guid>($"""
                SELECT tenant_id AS "Value" FROM connect.webhook_meeting_tenant({meetingId})
                """)
            .ToListAsync(ct);
        if (tenantIds.Count == 0) return Results.Ok();
        tenant.EnterAnonymousScope(tenantIds[0], "system");

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
            var person = await db.ConnectParticipants
                .Where(p => p.MeetingId == meetingId && p.Identity == identity)
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
                    if (state.Error is { Length: > 0 } err) recording.Error = err;
                    recording.UpdatedAt = DateTimeOffset.UtcNow;

                    // Derived, never incremented — see the migration header.
                    // Only when the size can actually have moved.
                    reconcileStorage = recording.Status is "ready" or "failed" or "aborted";
                }
            }
        }

        try
        {
            await db.SaveChangesAsync(ct);
            if (reconcileStorage)
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"SELECT connect.reconcile_recording_storage({tenantIds[0]})", ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            // 23505, unique_violation, on the webhook_id index: a replay that
            // arrived while the first copy was still in flight. Losing that
            // race is the correct outcome, not an error.
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

        return Results.Ok();
    }

}

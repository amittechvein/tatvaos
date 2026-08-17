using System.Text.Json;
using Microsoft.EntityFrameworkCore;
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

    private static async Task<IResult> ReceiveAsync(
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

        var eventName = Text(root, "event");
        if (string.IsNullOrEmpty(eventName)) return Results.Ok();

        var kind = eventName switch
        {
            "room_started" => "room_started",
            "room_finished" => "room_finished",
            "participant_joined" => "participant_joined",
            "participant_left" => "participant_left",
            "recording_started" => "recording_started",
            "recording_finished" => "recording_finished",
            _ => null,
        };
        // Unknown events are acknowledged and dropped: answering anything else
        // makes LiveKit retry forever over something we deliberately ignore.
        if (kind is null) return Results.Ok();

        if (!TryMeetingId(root, out var meetingId)) return Results.Ok();

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

        var webhookId = Text(root, "id");
        if (!string.IsNullOrEmpty(webhookId))
        {
            var seen = await db.ConnectMeetingEvents.AsNoTracking()
                .AnyAsync(e => e.WebhookId == webhookId, ct);
            if (seen) return Results.Ok();   // a retry, not a second join
        }

        var identity = ParticipantText(root, "identity");
        var displayName = ParticipantText(root, "name");
        var occurredAt = root.TryGetProperty("createdAt", out var created)
                         && created.TryGetInt64(out var unix)
            ? DateTimeOffset.FromUnixTimeSeconds(unix)
            : DateTimeOffset.UtcNow;

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

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // The unique index on webhook_id is the real guard against a
            // replay that arrives while the first copy is still in flight.
            // Losing that race is the correct outcome, not an error.
            log.LogDebug("Duplicate LiveKit webhook {WebhookId} ignored", webhookId);
        }

        return Results.Ok();
    }

    // ------------------------------------------------------------------
    //  LiveKit's payload, read defensively: this is external input.
    // ------------------------------------------------------------------
    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()
            : null;

    private static string? ParticipantText(JsonElement root, string name) =>
        root.TryGetProperty("participant", out var p) && p.ValueKind == JsonValueKind.Object
            ? Text(p, name)
            : null;

    /// <summary>
    /// The room name is m-{meetingId} and that is the only place the meeting
    /// id appears. A room LiveKit knows about but we do not — anything not
    /// matching the shape — is ignored rather than guessed at.
    /// </summary>
    private static bool TryMeetingId(JsonElement root, out Guid meetingId)
    {
        meetingId = Guid.Empty;
        if (!root.TryGetProperty("room", out var room) || room.ValueKind != JsonValueKind.Object)
            return false;

        var name = Text(room, "name");
        if (string.IsNullOrEmpty(name) || !name.StartsWith("m-", StringComparison.Ordinal))
            return false;

        return Guid.TryParse(name[2..], out meetingId);
    }
}

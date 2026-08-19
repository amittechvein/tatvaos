using System.Text;
using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// Minutes of meeting: the chat that goes into them, and the document that
/// comes out.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY CHAT IS POSTED HERE AT ALL, WHEN IT ALREADY WORKS.
///
///  It rides LiveKit's data channel, which is the right transport: no server
///  round trip, no dependency on the API being up, and it keeps working
///  through a deploy. What it is not is a RECORD. It lived only in the
///  browsers that were open, so every link, every "I'll send that by Friday"
///  and every question from somebody who could not unmute went away when the
///  tab closed. For a school that is a good half of what they needed.
///
///  So the transport is unchanged and a copy is posted here as well. The
///  meeting never waits on it and never fails because of it: chat that is
///  delivered but not stored is a worse record, while chat that is stored but
///  not delivered is a broken meeting.
///
///  WHO IS ALLOWED TO SAY WHAT SOMEBODY ELSE SAID.
///
///  A guest cannot call this API — they have no session — so a guest's line is
///  stored by one of the signed-in clients that received it. That means this
///  endpoint has to accept "here is a line from somebody who is not me", and
///  that is a door worth being careful about. The rule:
///
///    · you may always store YOUR OWN line;
///    · you may store a line from an identity that is a GUEST in this same
///      meeting;
///    · you may NEVER store a line attributed to another signed-in person.
///
///  So the worst a participant can do is put words in a guest's mouth, in a
///  meeting they were already in, and the platform never lets one colleague
///  forge another's words in the minutes. Guests are unauthenticated by
///  definition, which is why that boundary sits where it does — and it goes
///  to Core for review alongside the anonymous guest join path.
///
///  DUPLICATES ARE HANDLED IN THE DATABASE, NOT HERE. Every line carries the
///  id its sender's browser made up, and the insert is ON CONFLICT DO NOTHING
///  against (meeting_id, client_id). Five clients racing to store one guest
///  line leave one row. Checking first and then inserting would be two
///  statements and still a race.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectMinutesEndpoints
{
    /// <summary>Called from MapConnectRecordingEndpoints rather than from
    /// Program.cs. Program.cs is Core's file and a patch to it is a
    /// cross-lane change; this needs none.</summary>
    public static void MapConnectMinutesEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect")
            .RequireAuthorization("User")
            .WithTags("Connect");

        g.MapPost("/meetings/{id:guid}/chat", StoreChatAsync);
        g.MapGet("/meetings/{id:guid}/chat", ListChatAsync);

        // The document. Fetched with the Authorization header and saved as a
        // blob by the client — NOT a navigation, so it needs no signed ticket
        // the way a recording download does. A recording is hundreds of
        // megabytes and wants range requests; this is a few kilobytes of HTML.
        g.MapGet("/meetings/{id:guid}/minutes", MinutesAsync);

        g.MapPost("/meetings/{id:guid}/minutes/email", EmailNowAsync);
    }

    public sealed record ChatLineRequest(
        Guid? ClientId, string? Identity, string? DisplayName,
        bool? IsGuest, string? Body, DateTimeOffset? SentAt);

    /// <summary>A chat line is bounded, and the database says so too
    /// (meeting_chat_body_len). Checked here as well so the answer is a
    /// sentence rather than a constraint violation.</summary>
    private const int MaxBody = 4000;

    // ==================================================================
    //  Storing one line
    // ==================================================================
    private static async Task<IResult> StoreChatAsync(
        Guid id, ChatLineRequest req, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();

        var body = (req.Body ?? "").Trim();
        if (body.Length == 0) return Results.NoContent();
        if (body.Length > MaxBody) body = body[..MaxBody];

        var clientId = req.ClientId ?? Guid.Empty;
        if (clientId == Guid.Empty)
            return Results.BadRequest(new { error = "Every chat line needs a clientId." });

        // Membership first, and by the same rule as everything else here.
        if (!await ConnectRecordingEndpoints.SeenMeetingAsync(db, id, uid, ct))
            return ConnectRecordingEndpoints.NotFound();

        // Who this line is attributed to has to be somebody who was actually
        // in this meeting — not a name the caller invented.
        var identity = (req.Identity ?? "").Trim();
        if (identity.Length == 0)
            return Results.BadRequest(new { error = "Every chat line needs an identity." });

        var speaker = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == id && p.Identity == identity)
            .Select(p => new { p.UserId, p.IsGuest, p.DisplayName })
            .FirstOrDefaultAsync(ct);
        if (speaker is null)
            return Results.BadRequest(new { error = "That person was not in this meeting." });

        // The door described in the header. Your own line, or a guest's.
        var mine = speaker.UserId == uid;
        if (!mine && !speaker.IsGuest)
            return Results.Json(
                new { error = "You can only store your own messages." }, statusCode: 403);

        // The stored name is the one on the participant row, not the one the
        // caller sent. A display name is a fact the platform already holds,
        // and taking it from the request would let a client relabel somebody
        // in the permanent record of the meeting.
        var name = string.IsNullOrWhiteSpace(speaker.DisplayName) ? identity : speaker.DisplayName;

        // WHEN IT WAS SAID, not when the POST landed — clamped to something
        // sane. A line typed during a thirty-second reconnect belongs where it
        // was typed; a clock that is three days out belongs in the meeting
        // anyway, because minutes ordered by a broken client clock are
        // unreadable and there is no way to tell which client was wrong.
        var now = DateTimeOffset.UtcNow;
        var sentAt = req.SentAt ?? now;
        if (sentAt > now.AddMinutes(5) || sentAt < now.AddHours(-12)) sentAt = now;

        // ON CONFLICT DO NOTHING, in one statement. EF has no first-class way
        // to say this, and the alternative — SELECT then INSERT — is two round
        // trips and still a race between them.
        // ExecuteSqlInterpolatedAsync, not ExecuteSqlAsync — same thing, and it
        // is the name the other four call sites in this module already use.
        // Two names for one operation across one folder is how a reader ends
        // up wondering which of them is the special case.
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO connect.meeting_chat
                (meeting_id, client_id, identity, display_name, is_guest, body, sent_at)
            VALUES ({id}, {clientId}, {identity}, {name}, {speaker.IsGuest}, {body}, {sentAt})
            ON CONFLICT (meeting_id, client_id) DO NOTHING
            """, ct);

        return Results.NoContent();
    }

    // ==================================================================
    //  Reading it back
    // ==================================================================
    private static async Task<IResult> ListChatAsync(
        Guid id, AppDbContext db, TenantContext tenant, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await ConnectRecordingEndpoints.SeenMeetingAsync(db, id, uid, ct))
            return ConnectRecordingEndpoints.NotFound();

        var lines = await db.ConnectMeetingChat.AsNoTracking()
            .Where(c => c.MeetingId == id)
            .OrderBy(c => c.SentAt).ThenBy(c => c.Id)
            .Take(500)
            .Select(c => new { c.DisplayName, c.IsGuest, c.Body, c.SentAt })
            .ToListAsync(ct);

        return Results.Ok(new { lines });
    }

    // ==================================================================
    //  The document
    // ==================================================================
    private static async Task<IResult> MinutesAsync(
        Guid id, string? format, AppDbContext db, TenantContext tenant,
        IConfiguration config, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (!await ConnectRecordingEndpoints.SeenMeetingAsync(db, id, uid, ct))
            return ConnectRecordingEndpoints.NotFound();

        var input = await BuildAsync(db, id, config, ct);
        if (input is null)
            return Results.Json(new
            {
                error = "There are no minutes for this meeting yet. "
                      + "They are written a few minutes after it ends.",
            }, statusCode: 409);

        // Results.File, not Results.Text, for one reason: it sets
        // Content-Disposition and encodes the filename properly. The name
        // contains an em dash and may contain a title in any script, so the
        // header needs BOTH the plain filename= and the RFC 5987 filename*=
        // form — ASP.NET writes both, and hand-rolling that header is how a
        // document arrives called "ø€ø.html".
        //
        // A folder full of "minutes.html" is a folder nobody can search, which
        // is the whole reason the server names the file at all.
        var txt = string.Equals(format, "txt", StringComparison.OrdinalIgnoreCase);

        return txt
            ? Results.File(Encoding.UTF8.GetBytes(ConnectMinutes.Text(input)),
                           "text/plain; charset=utf-8",
                           ConnectMinutes.FileName(input, "txt"))
            : Results.File(Encoding.UTF8.GetBytes(ConnectMinutes.Html(input)),
                           "text/html; charset=utf-8",
                           ConnectMinutes.FileName(input, "html"));
    }

    /// <summary>The filename, so the client does not have to invent one and
    /// then disagree with the email's copy.</summary>
    internal static async Task<ConnectMinutes.Input?> BuildAsync(
        AppDbContext db, Guid meetingId, IConfiguration config, CancellationToken ct)
    {
        var meeting = await db.ConnectMeetings.AsNoTracking()
            .Where(m => m.Id == meetingId)
            .Select(m => new { m.Id, m.Title, m.StartedAt, m.EndedAt, m.CreatedByUserId })
            .FirstOrDefaultAsync(ct);
        if (meeting is null) return null;

        var notes = await db.ConnectMeetingNotes.AsNoTracking()
            .Where(n => n.MeetingId == meetingId && n.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (notes is null) return null;

        var host = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == meetingId && p.Role == "host")
            .Select(p => p.DisplayName)
            .FirstOrDefaultAsync(ct);

        var chat = await db.ConnectMeetingChat.AsNoTracking()
            .Where(c => c.MeetingId == meetingId)
            .OrderBy(c => c.SentAt).ThenBy(c => c.Id)
            .Take(500)
            .Select(c => new ConnectMinutes.ChatLine(c.DisplayName, c.IsGuest, c.Body, c.SentAt))
            .ToListAsync(ct);

        // Attendees with no address on this platform — almost always guests.
        // Counted so the document can say so; a recipient list that silently
        // omits half the room is how a decision reaches nobody it affects.
        var unreachable = await db.Database.SqlQuery<int>($"""
            SELECT connect.minutes_unreachable({meetingId}) AS "Value"
            """).FirstOrDefaultAsync(ct);

        return new ConnectMinutes.Input(
            MeetingTitle: string.IsNullOrWhiteSpace(meeting.Title) ? "Meeting" : meeting.Title,
            StartedAt: meeting.StartedAt,
            EndedAt: meeting.EndedAt,
            HostName: host,
            TimeZoneId: TimeZone(config),
            Notes: Read(notes),
            Chat: chat,
            HadTranscript: notes.HadTranscript,
            UnreachableAttendees: unreachable,
            BaseUrl: BaseUrl(config),
            MeetingId: meeting.Id);
    }

    /// <summary>
    /// The jsonb columns back into the shape the renderer wants.
    ///
    /// Through ConnectWire, like every other JSON read in this module —
    /// including the ones reading JSON this platform wrote itself. That is not
    /// belt and braces: TryGetProperty and TryGetInt64 THROW on the wrong kind
    /// rather than returning false, and one such line, on data we controlled,
    /// is what emptied connect.meeting_events for the module's whole life.
    /// </summary>
    private static ConnectNotesModel.Notes Read(ConnectMeetingNotes n)
    {
        return new ConnectNotesModel.Notes(
            Kind: string.IsNullOrWhiteSpace(n.Kind) ? "digest" : n.Kind,
            Provider: n.Provider,
            Model: n.Model,
            Summary: n.Summary ?? "",
            KeyPoints: Strings(n.KeyPoints),
            Decisions: Strings(n.Decisions),
            ActionItems: Strings(n.ActionItems),
            Speakers: Speakers(n.Speakers),
            Attendance: Attendance(n.Attendance));
    }

    private static List<string> Strings(string? raw)
    {
        var list = new List<string>();
        foreach (var item in Items(raw))
            if (item.ValueKind == System.Text.Json.JsonValueKind.String
                && item.GetString() is { Length: > 0 } s)
                list.Add(s);
        return list;
    }

    private static List<ConnectNotesModel.SpeakerTime> Speakers(string? raw)
    {
        var list = new List<ConnectNotesModel.SpeakerTime>();
        foreach (var item in Items(raw))
        {
            var name = ConnectWire.Text(item, "name", "Name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            list.Add(new ConnectNotesModel.SpeakerTime(
                name,
                ConnectWire.Number(item, "seconds", "Seconds") ?? 0,
                (int)Math.Clamp(ConnectWire.Number(item, "turns", "Turns") ?? 0, 0, int.MaxValue)));
        }
        return list;
    }

    private static List<ConnectNotesModel.Attendee> Attendance(string? raw)
    {
        var list = new List<ConnectNotesModel.Attendee>();
        foreach (var item in Items(raw))
        {
            var name = ConnectWire.Text(item, "name", "Name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            list.Add(new ConnectNotesModel.Attendee(
                name,
                ConnectWire.Flag(item, "guest", "Guest"),
                ConnectWire.Number(item, "seconds", "Seconds") ?? 0,
                (int)Math.Clamp(ConnectWire.Number(item, "joins", "Joins") ?? 0, 0, int.MaxValue)));
        }
        return list;
    }

    private static IEnumerable<System.Text.Json.JsonElement> Items(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) yield break;
        System.Text.Json.JsonDocument doc;
        try { doc = System.Text.Json.JsonDocument.Parse(raw); }
        catch (System.Text.Json.JsonException) { yield break; }
        using (doc)
        {
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) yield break;
            foreach (var item in doc.RootElement.EnumerateArray()) yield return item.Clone();
        }
    }

    // ==================================================================
    //  Sending it now
    // ==================================================================
    private static async Task<IResult> EmailNowAsync(
        Guid id, AppDbContext db, TenantContext tenant,
        TatvaOS.Api.Shared.Notify.SystemMailer mailer, IConfiguration config,
        ILoggerFactory loggers, CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (await ConnectRecordingEndpoints.RoleOfAsync(db, id, uid, ct) is not ("host" or "cohost"))
            return ConnectRecordingEndpoints.Forbidden();

        var notes = await db.ConnectMeetingNotes
            .Where(n => n.MeetingId == id && n.Status == "ready")
            .FirstOrDefaultAsync(ct);
        if (notes is null)
            return Results.Json(new
            {
                error = "There are no minutes to send yet. "
                      + "They are written a few minutes after the meeting ends.",
            }, statusCode: 409);

        // A HOST ASKING IS NOT THE WORKER'S THREE-STRIKES RULE. Somebody who
        // presses Send after fixing a bad address should not be told to wait,
        // so the attempt counter is reset here rather than being a wall.
        notes.EmailedAt = null;
        notes.EmailError = null;
        // 1, not 0: the caller owns the attempt counter (see
        // ConnectMinutesMailer), and this IS an attempt. Resetting to zero
        // would leave the worker three more tries on top of this one.
        notes.EmailAttempts = 1;

        var sent = await ConnectMinutesMailer.SendAsync(
            mailer, config, loggers.CreateLogger("Connect.Minutes"), db, id, notes, ct);
        await db.SaveChangesAsync(ct);

        return sent.Sent
            ? Results.Ok(new { sent = true, recipients = sent.Recipients })
            : Results.Json(new { sent = false, error = sent.Error }, statusCode: 502);
    }

    // ── configuration ─────────────────────────────────────────────────
    //
    // Both read from configuration with a sensible default rather than being
    // constants, because the one thing worse than a hardcoded hostname is a
    // hardcoded hostname in a link somebody in another organisation clicks.
    internal static string BaseUrl(IConfiguration config) =>
        config["Connect:PublicUrl"]
        ?? config["App:PublicUrl"]
        ?? "https://connect.tatvaos.com";

    /// <summary>
    /// The clock the minutes are written in.
    ///
    /// Minutes stamped 04:30 for a meeting everybody remembers at 10:00 are
    /// minutes nobody trusts. This platform serves Indian schools, so that is
    /// the default; it is configuration because the day it serves one that is
    /// not, a rebuild would be the wrong answer.
    /// </summary>
    internal static string TimeZone(IConfiguration config) =>
        config["Connect:TimeZone"] ?? "Asia/Kolkata";
}

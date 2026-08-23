using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Tenancy;

namespace TatvaOS.Api.Modules.Connect.Endpoints;

/// <summary>
/// Collecting live captions from participants' browsers.
///
/// ─────────────────────────────────────────────────────────────────────────
///  ONE ENDPOINT, AND IT IS DELIBERATELY BORING.
///
///  The browser recognises speech as it is spoken and posts finished lines
///  here in small batches. The server decides WHO said them, from the caller's
///  own token, and writes them down. Nothing else.
///
///  Why it matters: paid transcription was 97% of what AI meeting notes cost
///  (₹16.6 against ₹0.40 on a real 31-minute meeting). The browser does that
///  same work for nothing, so this endpoint is the difference between roughly
///  ₹7,200 a month and ₹90.
///
///  ─────────────────────────────────────────────────────────────────────────
///  SIGNED-IN PARTICIPANTS ONLY, IN THIS VERSION, AND SAID OUT LOUD
///
///  A guest holds a LiveKit token that expires every ten minutes, so guest
///  captions need a signed ticket of their own — the ConnectDownloadTicket
///  shape — which is a separate piece of work rather than a line here. Until
///  then a meeting's guests contribute nothing to its transcript.
///
///  That is a real gap, not a rounding error, and it sits on top of the ones
///  captions already have: Chrome only, and each browser hears only its own
///  microphone. A caption transcript is PARTIAL BY CONSTRUCTION. Everything
///  that reads one has to say so rather than implying it is the meeting.
///
///  ─────────────────────────────────────────────────────────────────────────
///  THE SPEAKER IS NEVER TAKEN FROM THE REQUEST
///
///  The body carries text and a time. It does not carry a name, and if it did
///  this would ignore it. Anybody in a meeting could otherwise attribute a
///  sentence to a colleague in a document that later goes to a board as the
///  minutes — which is a forgery with a nice UI on it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectCaptionEndpoints
{
    /// <summary>
    /// Most a browser may post at once. It batches every few seconds, so a
    /// normal request carries one or two lines; fifty is far above any honest
    /// client and far below "unbounded".
    /// </summary>
    private const int MaxLinesPerRequest = 50;

    /// <summary>
    /// Matches the CHECK constraint on the column exactly. Two guards saying
    /// the same number is deliberate — this one gives a sentence, the database
    /// one means a bug here cannot become bad data.
    /// </summary>
    private const int MaxLineLength = 2000;

    /// <summary>
    /// A ceiling per meeting, so a stuck client cannot fill the disk Mail
    /// shares. Roughly 12,000 lines is a very talkative eight-hour meeting;
    /// past it we keep what we have and stop, because a transcript that is
    /// missing its tail is better than a database that is full.
    /// </summary>
    private const int MaxLinesPerMeeting = 12_000;

    public static void MapConnectCaptionEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/connect")
            .RequireAuthorization("User")
            .WithTags("Connect");

        g.MapPost("/meetings/{id:guid}/captions", PostAsync);
    }

    public sealed record CaptionLine(string? Text, DateTimeOffset? At);
    public sealed record CaptionRequest(List<CaptionLine>? Lines);

    private static async Task<IResult> PostAsync(
        Guid id, CaptionRequest? req, AppDbContext db, TenantContext tenant,
        CancellationToken ct)
    {
        if (tenant.UserId is not Guid uid) return Results.Unauthorized();
        if (req?.Lines is not { Count: > 0 }) return Results.Ok(new { accepted = 0 });

        // WHO, from the token. The participant row also proves the caller is
        // in this meeting at all — one query doing both jobs, so there is no
        // way to pass the membership check and miss the attribution.
        var participant = await db.ConnectParticipants.AsNoTracking()
            .Where(p => p.MeetingId == id && p.UserId == uid)
            .Select(p => new { p.Id })
            .FirstOrDefaultAsync(ct);

        // Not "forbidden" with an explanation: whether a given meeting exists
        // and who is in it are both things a stranger should not learn from
        // the difference between two error messages.
        if (participant is null) return Results.NotFound();

        var existing = await db.ConnectCaptionLines
            .CountAsync(c => c.MeetingId == id, ct);
        if (existing >= MaxLinesPerMeeting) return Results.Ok(new { accepted = 0, full = true });

        var now = DateTimeOffset.UtcNow;
        var room = MaxLinesPerMeeting - existing;
        var accepted = 0;

        foreach (var line in req.Lines.Take(Math.Min(MaxLinesPerRequest, room)))
        {
            var text = line.Text?.Trim();
            if (string.IsNullOrEmpty(text)) continue;
            if (text.Length > MaxLineLength) text = text[..MaxLineLength];

            db.ConnectCaptionLines.Add(new ConnectCaptionLine
            {
                Id = Guid.NewGuid(),
                MeetingId = id,
                ParticipantId = participant.Id,
                Text = text,
                // A client clock that is wrong by a day would put every line of
                // one person's speech at the end of the transcript, or the
                // start. Anything outside a generous window around now is
                // replaced by server time: ordering is what this field is for,
                // and a plausible order beats a precise-looking wrong one.
                SpokenAt = Plausible(line.At, now) ? line.At!.Value : now,
                CreatedAt = now,
            });
            accepted++;
        }

        if (accepted > 0) await db.SaveChangesAsync(ct);
        return Results.Ok(new { accepted });
    }

    /// <summary>
    /// Within a day either side of now. Wide on purpose — a laptop several
    /// minutes out is ordinary and its captions still order correctly against
    /// its own; a laptop a year out is a broken clock, not a slow one.
    /// </summary>
    private static bool Plausible(DateTimeOffset? at, DateTimeOffset now) =>
        at is DateTimeOffset value
        && value > now.AddDays(-1)
        && value < now.AddDays(1);
}

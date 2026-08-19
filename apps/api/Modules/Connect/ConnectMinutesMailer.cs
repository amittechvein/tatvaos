using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;
using TatvaOS.Api.Shared.Notify;

namespace TatvaOS.Api.Modules.Connect;

/// <summary>
/// Sends the minutes to the people who were in the room.
///
/// ─────────────────────────────────────────────────────────────────────────
///  STATIC, AND NOT IN THE CONTAINER, ON PURPOSE.
///
///  Registering a service means editing Program.cs, and Program.cs is Core's
///  file — a change there is a patch, a review and a merge conflict waiting
///  for whoever else touched it that week. Everything this needs is already
///  registered by Core: SystemMailer, AppDbContext, IConfiguration. So it
///  takes them as arguments and ships without asking anybody for anything.
///
///  THE ATTEMPT IS COUNTED BEFORE ANYTHING IS SENT, AND THE CALLER SAVES IT
///  BEFORE CALLING. That order is the whole design.
///
///  Counting first can lose one send: a crash between the save and the send
///  burns an attempt that never happened, and after three of those the
///  minutes stop being tried. Counting afterwards can send the same minutes
///  every minute until the process stops crashing, to everyone who was in the
///  meeting. calendar.reminder_sends made exactly this choice for exactly
///  this reason — a reminder that arrives twice is how people learn to filter
///  your mail — and three attempts is the ceiling on how badly the first
///  failure mode can go.
///
///  ONE BAD ADDRESS MUST NOT STOP THE REST. Every send is attempted
///  individually and a failure is counted, not thrown. Eleven people should
///  not miss the minutes because one mailbox is full.
///
///  RECIPIENTS COME FROM A DEFINER FUNCTION, NOT FROM A JOIN HERE. The worker
///  runs with no tenant set, so an ordinary query under FORCED RLS returns
///  nothing — quietly, while the log says the sweep ran. connect.
///  minutes_recipients is SECURITY DEFINER with a pinned search_path, like
///  every other pre-tenant read in this module.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ConnectMinutesMailer
{
    public sealed record Result(bool Sent, int Recipients, string? Error);

    /// <summary>
    /// Send the minutes for one meeting.
    ///
    /// THE CALLER OWNS THE ATTEMPT COUNTER AND THE TRANSACTION. This method
    /// does not increment EmailAttempts and does not save — it fills in the
    /// outcome fields and returns.
    ///
    /// That split is deliberate and it went the other way first. When this
    /// counted its own attempt, the worker — which must claim a row BEFORE
    /// doing any work, or two containers send the same minutes twice — ended
    /// up incrementing, saving, calling here, and then decrementing to undo
    /// the second count. Three operations to express one fact, and the kind
    /// of arithmetic that is wrong the first time somebody adds an early
    /// return. Claiming is the caller's job because only the caller knows
    /// whether it is a worker sweeping a queue or a host pressing Send.
    /// </summary>
    public static async Task<Result> SendAsync(
        SystemMailer mailer, IConfiguration config, ILogger log,
        AppDbContext db, Guid meetingId, ConnectMeetingNotes notes, CancellationToken ct)
    {
        var input = await Endpoints.ConnectMinutesEndpoints.BuildAsync(db, meetingId, config, ct);
        if (input is null)
        {
            notes.EmailError = "There is nothing to send — the notes are not ready.";
            return new Result(false, 0, notes.EmailError);
        }

        // Addresses only. SqlQuery maps SCALARS — asking it for a record with
        // two columns compiles and fails at runtime, which is a discovery best
        // made at a keyboard rather than by a worker at 2 a.m. The display
        // name is not needed: the document already carries who attended.
        var people = await db.Database.SqlQuery<string>($"""
            SELECT email::text AS "Value" FROM connect.minutes_recipients({meetingId})
            """).ToListAsync(ct);

        if (people.Count == 0)
        {
            // NOT an error, and not something to retry three times. A meeting
            // whose attendees were all guests has nobody on this platform to
            // write to, and saying so once is the honest end of it.
            notes.EmailedAt = DateTimeOffset.UtcNow;
            notes.EmailRecipients = 0;
            notes.EmailError = "Nobody in this meeting has an address on this platform.";
            log.LogInformation("Minutes for {Meeting} have no reachable recipients", meetingId);
            return new Result(true, 0, null);
        }

        var subject = ConnectMinutes.Subject(input);
        var html = ConnectMinutes.Html(input);

        var delivered = 0;
        var failed = 0;
        foreach (var address in people)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                if (await mailer.SendHtmlAsync(address, subject, html, from: null, ct))
                    delivered++;
                else
                    failed++;
            }
            catch (Exception ex)
            {
                // One bad address must not stop the rest.
                failed++;
                log.LogWarning(ex, "Minutes for {Meeting} could not be sent to one recipient", meetingId);
            }
        }

        notes.EmailRecipients = delivered;

        if (delivered == 0)
        {
            // Nothing got through. Leave emailed_at NULL so the worker tries
            // again — up to its three attempts — because this is usually the
            // mail server being briefly unreachable.
            notes.EmailError = $"None of the {people.Count} recipients could be reached.";
            log.LogWarning("Minutes for {Meeting} reached nobody ({Count} tried)", meetingId, people.Count);
            return new Result(false, 0, notes.EmailError);
        }

        notes.EmailedAt = DateTimeOffset.UtcNow;
        // Partial success is recorded as success WITH a note, not retried. A
        // retry would re-send to everybody who already had it in order to
        // reach the one who did not, and the people who got it twice have no
        // way to know why.
        notes.EmailError = failed == 0
            ? null
            : $"{failed} of {people.Count} recipients could not be reached.";

        log.LogInformation(
            "Minutes for {Meeting} sent to {Delivered} of {Total}", meetingId, delivered, people.Count);
        return new Result(true, delivered, notes.EmailError);
    }
}

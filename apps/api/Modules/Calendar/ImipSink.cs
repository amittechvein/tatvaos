using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// What Mail's ingest calls when a delivered message carries a calendar
/// reply. Contract: docs/MAIL_IMIP_SEAM.md §4 (v1.2).
///
/// Mail's obligations end at "there is a text/calendar part with METHOD:REPLY
/// or COUNTER, here is its text and the address that authenticated at SMTP".
/// Everything after that is Calendar's, including deciding the reply is not
/// for us — which is the common case, since strangers' calendar fragments
/// arrive in mail constantly.
/// </summary>
public interface ICalendarImipSink
{
    /// <summary>
    /// Returns whether the reply was applied. FALSE IS NORMAL and is not an
    /// error: unknown UID, an address that is not on the event, a stale
    /// SEQUENCE and a per-occurrence reply all return false. Mail uses the
    /// result for one log line and nothing else.
    ///
    /// Never throws. A calendar reply that cannot be understood must not
    /// affect whether the mail was delivered — the message is in the inbox
    /// either way, and the human-readable email is the real record.
    /// </summary>
    Task<bool> HandleReplyAsync(string icalPayload, string fromAddress, CancellationToken ct);
}

/// <summary>
/// ─────────────────────────────────────────────────────────────────────────
///  THE ADDRESS THAT AUTHENTICATED WINS. ALWAYS.
///
///  The ATTENDEE line inside the payload is text a stranger wrote. Matching
///  the attendee row on it would let anyone who can send us mail decline a
///  meeting on someone else's behalf — a one-line forgery, no account
///  needed. So the row is found by the SMTP-authenticated sender, and the
///  payload's own claim about who is answering is used for exactly one
///  thing: a log line when the two disagree.
///
///  This is the same rule as the webhook path in Connect and the public-link
///  path in Space: the transport's identity beats the body's claim, every
///  time, without exception.
/// ─────────────────────────────────────────────────────────────────────────
///
/// Runs inside the ingest worker's OWN scope, so `db` is already scoped to
/// the recipient mailbox's tenant and ordinary RLS applies. No SECURITY
/// DEFINER function is needed here and none should be added: a reply can only
/// ever be about an event in the tenant whose mailbox received it.
/// </summary>
public sealed class CalendarImipSink(
    AppDbContext db,
    ILogger<CalendarImipSink> log) : ICalendarImipSink
{
    public async Task<bool> HandleReplyAsync(string icalPayload, string fromAddress, CancellationToken ct)
    {
        try
        {
            return await ApplyAsync(icalPayload, fromAddress, ct);
        }
        catch (Exception ex)
        {
            // Mail already swallows, but the promise is made HERE too: this
            // method is documented as never throwing, and a caller should not
            // have to read Mail's code to know that holds.
            log.LogWarning(ex, "iMIP reply could not be applied");
            return false;
        }
    }

    private async Task<bool> ApplyAsync(string icalPayload, string fromAddress, CancellationToken ct)
    {
        var reply = Imip.ParseReply(icalPayload);
        if (reply is null) return false;

        var sender = fromAddress.Trim().ToLowerInvariant();
        if (sender.Length == 0) return false;

        // Per-occurrence replies are refused rather than misapplied. Our
        // attendee status is per EVENT, so applying "I cannot make the 14th"
        // to the series would decline every future occurrence as well — a
        // destructive answer to an ambiguous one. Refusing leaves the email
        // in the organiser's inbox, where a human reads it correctly.
        if (reply.RecurrenceId is not null)
        {
            log.LogInformation(
                "iMIP reply is for a single occurrence of {Uid}; per-occurrence status is not modelled, left for the organiser to read",
                reply.Uid);
            return false;
        }

        var ev = await db.CalendarEvents
            .FirstOrDefaultAsync(e => e.Uid == reply.Uid && e.DeletedAt == null, ct);
        if (ev is null) return false;   // not ours, or deleted. Normal.

        // STALE. A reply quoting an older SEQUENCE answers a version of the
        // event that no longer exists — most often a decline of the original
        // time arriving after the organiser moved it. Applying it would show
        // the organiser a refusal of an invitation nobody was sent.
        if (reply.Sequence < ev.Sequence)
        {
            log.LogInformation(
                "iMIP reply for {Uid} quotes SEQUENCE {Theirs} but the event is at {Ours}; ignored as stale",
                reply.Uid, reply.Sequence, ev.Sequence);
            return false;
        }

        var attendee = await db.CalendarAttendees
            .FirstOrDefaultAsync(a => a.EventId == ev.Id && a.Email.ToLower() == sender, ct);
        if (attendee is null)
        {
            log.LogInformation(
                "iMIP reply for {Uid} came from {Sender}, who is not an attendee; ignored",
                reply.Uid, sender);
            return false;
        }

        if (!string.Equals(reply.AttendeeEmail, sender, StringComparison.OrdinalIgnoreCase))
            // Not fatal, and deliberately not a refusal: mailing lists and
            // some clients rewrite the envelope. Recorded because the other
            // reason for a mismatch is somebody trying it on.
            log.LogWarning(
                "iMIP reply for {Uid} claims ATTENDEE {Claimed} but authenticated as {Sender}; the authenticated address wins",
                reply.Uid, reply.AttendeeEmail, sender);

        if (attendee.Status == reply.PartStat) return true;  // already applied; a duplicate delivery

        attendee.Status = reply.PartStat;
        attendee.RespondedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        log.LogInformation("iMIP: {Sender} is now {Status} for {Uid}", sender, reply.PartStat, reply.Uid);
        return true;
    }
}

namespace TatvaOS.Tests.CalendarImip;

/// <summary>
/// Real replies, as Gmail and Outlook actually send them.
///
/// Copied from messages those clients produced, not from the RFC and not from
/// what a developer expected. Two of the traps below only exist because real
/// clients do something the specification permits but nobody anticipates:
/// Outlook echoes the ENTIRE attendee list back in a reply, and Gmail folds
/// ATTENDEE lines in the middle of an email address.
/// </summary>
internal static class Fixtures
{
    /// <summary>
    /// Gmail's "Yes" — note the fold INSIDE the mailto, which is where a
    /// naive line-by-line parser loses the address and reports the reply as
    /// unparseable. Gmail folds at exactly 75 octets wherever that lands.
    /// </summary>
    public const string GmailAccept =
        "BEGIN:VCALENDAR\r\n" +
        "PRODID:-//Google Inc//Google Calendar 70.9054//EN\r\n" +
        "VERSION:2.0\r\n" +
        "CALSCALE:GREGORIAN\r\n" +
        "METHOD:REPLY\r\n" +
        "BEGIN:VEVENT\r\n" +
        "DTSTART:20260825T043000Z\r\n" +
        "DTEND:20260825T053000Z\r\n" +
        "DTSTAMP:20260819T121500Z\r\n" +
        "ORGANIZER;CN=Amit Dadhich:mailto:amit@tatvaos.com\r\n" +
        "UID:tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31\r\n" +
        "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=riya.\r\n" +
        " sharma@gmail.com;X-NUM-GUESTS=0:mailto:riya.sharma@gmail.com\r\n" +
        "CREATED:20260819T120000Z\r\n" +
        "LAST-MODIFIED:20260819T121500Z\r\n" +
        "SEQUENCE:0\r\n" +
        "STATUS:CONFIRMED\r\n" +
        "SUMMARY:Project review\r\n" +
        "TRANSP:OPAQUE\r\n" +
        "END:VEVENT\r\n" +
        "END:VCALENDAR\r\n";

    /// <summary>
    /// Outlook's "Decline", and the dangerous one: it echoes EVERY attendee,
    /// with the replier first. The others carry the PARTSTAT the organiser
    /// last sent — stale copies. Reading the wrong ATTENDEE line here would
    /// overwrite a third party's answer with an out-of-date one.
    /// </summary>
    public const string OutlookDeclineEchoesEveryone =
        "BEGIN:VCALENDAR\r\n" +
        "METHOD:REPLY\r\n" +
        "PRODID:Microsoft Exchange Server 2010\r\n" +
        "VERSION:2.0\r\n" +
        "BEGIN:VEVENT\r\n" +
        "ORGANIZER;CN=\"Amit Dadhich\":mailto:amit@tatvaos.com\r\n" +
        "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=\"Vikram Rao\":mailto:vi\r\n" +
        " kram@contoso.com\r\n" +
        "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=\"Priya N\":mailto:p\r\n" +
        " riya@tatvaos.com\r\n" +
        "DESCRIPTION;LANGUAGE=en-GB:\\n\r\n" +
        "UID:tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31\r\n" +
        "SUMMARY;LANGUAGE=en-GB:Declined: Project review\r\n" +
        "DTSTART;TZID=India Standard Time:20260825T100000\r\n" +
        "DTEND;TZID=India Standard Time:20260825T110000\r\n" +
        "CLASS:PUBLIC\r\n" +
        "PRIORITY:5\r\n" +
        "DTSTAMP:20260819T123000Z\r\n" +
        "TRANSP:OPAQUE\r\n" +
        "STATUS:CONFIRMED\r\n" +
        "SEQUENCE:3\r\n" +
        "END:VEVENT\r\n" +
        "END:VCALENDAR\r\n";

    /// <summary>Apple Calendar's tentative — SEQUENCE absent entirely, which
    /// RFC 5545 §3.8.7.4 says means zero rather than unknown.</summary>
    public const string AppleTentativeNoSequence =
        "BEGIN:VCALENDAR\r\n" +
        "VERSION:2.0\r\n" +
        "PRODID:-//Apple Inc.//macOS 15.2//EN\r\n" +
        "METHOD:REPLY\r\n" +
        "BEGIN:VEVENT\r\n" +
        "UID:tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31\r\n" +
        "DTSTAMP:20260819T124500Z\r\n" +
        "ATTENDEE;CN=Sunil;PARTSTAT=TENTATIVE:mailto:sunil@icloud.com\r\n" +
        "ORGANIZER:mailto:amit@tatvaos.com\r\n" +
        "SUMMARY:Project review\r\n" +
        "END:VEVENT\r\n" +
        "END:VCALENDAR\r\n";

    /// <summary>A reply about ONE occurrence of a series. Our attendee status
    /// is per event, so this must be refused rather than applied to the whole
    /// series — declining one Tuesday is not declining every Tuesday.</summary>
    public const string ReplyForOneOccurrence =
        "BEGIN:VCALENDAR\r\n" +
        "VERSION:2.0\r\n" +
        "METHOD:REPLY\r\n" +
        "BEGIN:VEVENT\r\n" +
        "UID:tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31\r\n" +
        "RECURRENCE-ID:20260901T043000Z\r\n" +
        "ATTENDEE;PARTSTAT=DECLINED:mailto:riya.sharma@gmail.com\r\n" +
        "SEQUENCE:0\r\n" +
        "END:VEVENT\r\n" +
        "END:VCALENDAR\r\n";

    /// <summary>Someone handed the meeting on. DELEGATED is a real PARTSTAT we
    /// do not model, and recording it as accepted would tell an organiser
    /// somebody is coming who explicitly is not.</summary>
    public const string Delegated =
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\n" +
        "UID:tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31\r\n" +
        "ATTENDEE;PARTSTAT=DELEGATED;DELEGATED-TO=\"mailto:other@contoso.com\":mailto:vikram@contoso.com\r\n" +
        "SEQUENCE:1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    /// <summary>A REQUEST, not a reply — an invitation someone forwarded into
    /// a mailbox. Must not be read as an answer to anything.</summary>
    public const string NotAReplyItIsARequest =
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n" +
        "UID:someone-elses-event@example.org\r\n" +
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:amit@tatvaos.com\r\n" +
        "END:VEVENT\r\nEND:VCALENDAR\r\n";

    /// <summary>A meeting-room booking confirmation with no ATTENDEE at all.
    /// Perfectly valid iCalendar, and nothing to do with us.</summary>
    public const string NoAttendee =
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\n" +
        "UID:tatvaos-9f2c1a4e-7b3d-4c88-9a11-2f6e5d0c7a31\r\n" +
        "SEQUENCE:0\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    /// <summary>Everything that must not throw. Real mail carries all of it.</summary>
    public static readonly (string Name, string Payload)[] Hostile =
    [
        ("empty", ""),
        ("whitespace", "   \r\n  "),
        ("not iCalendar at all", "Dear Amit,\r\n\r\nSee you Tuesday.\r\n"),
        ("truncated mid-object", "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:x"),
        ("no colon anywhere", "BEGINVCALENDAR METHODREPLY"),
        ("METHOD present, nothing else", "METHOD:REPLY"),
        ("attendee with no mailto", "METHOD:REPLY\r\nUID:x\r\nATTENDEE;PARTSTAT=ACCEPTED:CN=nobody"),
        ("fold with nothing to continue", " orphaned continuation\r\nMETHOD:REPLY"),
        ("SEQUENCE that is not a number", "METHOD:REPLY\r\nUID:x\r\nSEQUENCE:soon\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:a@b.c"),
        ("lone CR line endings", "BEGIN:VCALENDAR\rMETHOD:REPLY\rUID:x\r"),
        ("very long single line", "METHOD:REPLY\r\nUID:" + new string('u', 5000)),
    ];
}

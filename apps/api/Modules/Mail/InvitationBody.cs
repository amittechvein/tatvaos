using System.Text;
using System.Text.RegularExpressions;
using MimeKit;

namespace TatvaOS.Api.Modules.Mail;

// ============================================================================
//  Assembling an invitation — deliberately dependency-free
// ============================================================================
//
//  MimeKit and nothing else. No DbContext, no IConfiguration, no MailKit, no
//  await. That is the whole point of this file existing separately from
//  MailSender: Calendar's structure test links this one source file and runs
//  the REAL assembly, instead of needing a database and a config provider to
//  check a MIME tree.
//
//  The alternative was Calendar writing its own assembler to test against,
//  which proves their assembler correct and mine untested — the same
//  two-implementations problem that produced a duplicate link client on this
//  platform this morning.
//
//  Everything here is public rather than internal so it works whether the
//  test links the source or references the assembly.
// ============================================================================
public static class InvitationBody
{
    /// <summary>
    /// ONE ENTRY POINT: the assembled body, or the reason it was refused.
    /// Exactly one of the two is ever non-null.
    ///
    /// Both outcomes come from the same call deliberately. A caller that has
    /// to remember to check the method separately before assembling is a
    /// caller that will one day forget, and the failure that produces — an
    /// invitation whose header and body disagree — is silent at every layer
    /// until it reaches somebody's calendar.
    ///
    /// It also means a test gets both cases from one method rather than
    /// exercising two paths that could drift apart.
    /// </summary>
    public static (Multipart? Body, string? Refusal) TryBuild(
        string textBody, string htmlBody, string iCalendar, string method)
    {
        if (Mismatch(iCalendar, method) is string problem)
            return (null, problem);

        return (Build(textBody, htmlBody, iCalendar, method), null);
    }

    /// <summary>
    /// The problem with this invitation, or null when there is none.
    ///
    /// THE HEADER AND THE BODY MUST AGREE. Gmail decides whether to draw
    /// Accept/Decline from method= on the content type; the recipient's
    /// calendar acts on the METHOD: line inside the payload. A message whose
    /// header says REQUEST and whose body says CANCEL renders as an invitation
    /// and cancels the meeting — the worst of both.
    ///
    /// Today this cannot happen: Calendar writes both from one argument. That
    /// is exactly why it is worth checking, because it is the thing that
    /// notices the day that stops being true.
    /// </summary>
    public static string? Mismatch(string iCalendar, string method)
    {
        var declared = (method ?? string.Empty).Trim();
        if (declared.Length == 0) return "no method was declared";

        var inBody = Regex.Match(iCalendar, @"^METHOD:[ \t]*([A-Za-z]+)", RegexOptions.Multiline);
        if (!inBody.Success) return "the payload has no METHOD: line";

        return string.Equals(inBody.Groups[1].Value, declared, StringComparison.OrdinalIgnoreCase)
            ? null
            : $"the content type says {declared} but the payload says {inBody.Groups[1].Value}";
    }

    /// <summary>
    /// The dual carriage, as a multipart/mixed ready to be a message body.
    ///
    /// The SAME iCalendar content appears twice: as a sibling inside
    /// multipart/alternative, and again as an invite.ics attachment. Gmail
    /// reads the alternative; some Outlook versions only ever see the
    /// attachment. Send one without the other and it works for half the
    /// recipients, and not the half we get to choose.
    ///
    /// The caller adds any ordinary file attachments to the returned part.
    /// They are not a parameter here because nothing about them is
    /// calendar-specific and keeping them out keeps the test's call one line.
    /// </summary>
    public static Multipart Build(string textBody, string htmlBody, string iCalendar, string method)
    {
        var ical = Crlf(iCalendar);

        // ORDER MATTERS, and it is a rule rather than a habit. RFC 2046
        // §5.1.4: alternatives run in INCREASING order of preference and a
        // receiver takes the last one it understands. A calendar part placed
        // before the HTML is a calendar part Gmail will pass over.
        // EVERY part's encoding is chosen, not just the calendar one.
        //
        // The first version of this set quoted-printable on the invitation and
        // left these two to MimeKit, which picked 8bit for a Devanagari body.
        // Confirmed on a real message to Gmail: the text/plain part went out
        // as `Content-Transfer-Encoding: 8bit` carrying raw UTF-8.
        //
        // 8bit is legal and it arrived - but only because every hop on that
        // route advertised 8BITMIME. It is the same "correct if the library
        // behaves" trade we rejected one part over, made again on the part
        // beside it. An invitation whose summary renders and whose body is
        // mojibake is a worse failure than either half alone.
        var alternative = new Multipart("alternative");
        if (!string.IsNullOrWhiteSpace(textBody))
            alternative.Add(new TextPart("plain")
            {
                Text = textBody,
                ContentTransferEncoding = ContentEncoding.QuotedPrintable,
            });
        if (!string.IsNullOrWhiteSpace(htmlBody))
            alternative.Add(new TextPart("html")
            {
                Text = htmlBody,
                ContentTransferEncoding = ContentEncoding.QuotedPrintable,
            });

        var invitation = new TextPart("calendar");
        invitation.ContentType.Parameters["method"] = method.Trim().ToUpperInvariant();
        invitation.SetText(Encoding.UTF8, ical);

        // CHOSEN, not left to the library, and this line is the whole reason
        // this comment is long. Without it MimeKit writes NO
        // Content-Transfer-Encoding header at all, and an absent header means
        // 7bit under RFC 2045 - so a part carrying 8-bit octets is
        // non-conformant. It survives today only because MailKit's Prepare()
        // downgrades on the fly using whatever the receiving server
        // advertised, and Postfix and Gmail both advertise 8BITMIME. That is
        // a capability negotiation we neither observe nor log, silently
        // deciding the encoding of the one part that makes Gmail draw
        // Accept/Decline.
        //
        // A DEVANAGARI MEETING TITLE IS 8-BIT UTF-8. This is our market's
        // ordinary case, not an edge one - and an English title would have
        // passed every test anybody would naturally think to run.
        //
        // Quoted-printable rather than base64, and the asymmetry with the
        // attachment below is now DELIBERATE rather than accidental. The two
        // parts have different readers. When an invitation renders as a
        // paperclip instead of buttons, the first thing anyone does is "Show
        // original" - quoted-printable leaves BEGIN:VCALENDAR legible there,
        // base64 is an opaque blob at exactly the moment you need to read it.
        // The attachment is a file a client parses and nobody reads, so
        // unconditional base64 costs nothing there and buys certainty.
        invitation.ContentTransferEncoding = ContentEncoding.QuotedPrintable;

        alternative.Add(invitation);

        var mixed = new Multipart("mixed") { alternative };
        mixed.Add(InviteAttachment(ical));
        return mixed;
    }

    /// <summary>
    /// The second carriage. Base64, so the CRLF line endings iCalendar
    /// requires survive byte for byte. Quoted-printable would also preserve
    /// them, but base64 makes that unconditional rather than dependent on the
    /// encoder's line handling — and "definitely correct" beats "correct if
    /// the library behaves".
    /// </summary>
    public static MimePart InviteAttachment(string iCalendar)
    {
        var part = new MimePart("application", "ics")
        {
            ContentDisposition = new ContentDisposition(ContentDisposition.Attachment)
            {
                FileName = "invite.ics",
            },
            ContentTransferEncoding = ContentEncoding.Base64,
            Content = new MimeContent(new MemoryStream(Encoding.UTF8.GetBytes(iCalendar))),
        };
        part.ContentType.Name = "invite.ics";
        return part;
    }

    /// <summary>
    /// An ordinary file attachment, base64 for the same reason.
    /// </summary>
    public static MimePart FileAttachment(string fileName, string contentType, byte[] content)
    {
        var parsed = ContentType.Parse(
            string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType);

        return new MimePart(parsed)
        {
            ContentDisposition = new ContentDisposition(ContentDisposition.Attachment)
            {
                FileName = fileName,
            },
            ContentTransferEncoding = ContentEncoding.Base64,
            Content = new MimeContent(new MemoryStream(content)),
        };
    }

    /// <summary>
    /// CRLF throughout, including the last line.
    ///
    /// A BARE LF IS THE WORST FAILURE AVAILABLE HERE: Gmail accepts it and
    /// Exchange rejects it, so it passes every test we would naturally run and
    /// breaks for the customer who bought the product for Outlook.
    /// </summary>
    public static string Crlf(string text)
    {
        var normalised = text.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "\r\n");
        return normalised.EndsWith("\r\n", StringComparison.Ordinal) ? normalised : normalised + "\r\n";
    }
}

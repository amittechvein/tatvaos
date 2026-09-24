using System.Net.Mail;
using System.Text;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The shape of every system email: what parts it has, and which headers.
///
/// ── WHY IT IS SEPARATE FROM SENDING ──────────────────────────────────────
///
///  Because the shape is what keeps going wrong, and sending needs a server
///  while shape does not. Three faults in one day, 24 September 2026, all of
///  them invisible from the code and obvious in the raw message:
///
///    1. HTML with NO text/plain part at all. Every system email since the
///       platform began.
///    2. NO Message-ID: Gmail stamped SMTPIN_ADDED_MISSING and invented one.
///    3. The fix for (1) sent the text part TWICE — MailMessage.Body is
///       itself an alternative, and a text/plain AlternateView beside it
///       duplicates it. Seen in the first message out of the new code.
///
///  Each was found by reading a message Amit forwarded, never by a test,
///  because nothing here could be tested without an SMTP server. Now it can:
///  System.Net.Mail will write this message to a directory instead of a
///  socket, so tests/email-plaintext asserts the REAL MIME — how many
///  text/plain parts, the Message-ID, the headers.
/// </summary>
public static class SystemMailMessage
{
    /// <param name="html">True when <paramref name="body"/> is HTML.</param>
    /// <param name="unsubscribe">
    /// Somewhere this KIND of message can be turned off, or null. Null for
    /// anything that cannot be: a password reset, an invitation, a security
    /// alert. Offering to unsubscribe from those would be a lie and a way to
    /// switch off the warning that someone signed in.
    /// </param>
    public static MailMessage Build(
        string sender, string to, string subject, string body, bool html, string? unsubscribe = null)
    {
        var msg = new MailMessage(sender, to) { Subject = subject, SubjectEncoding = Encoding.UTF8 };

        // ── BOTH PARTS, ONCE EACH ───────────────────────────────────────────
        //
        //  HTML with no text alternative is a long-standing spam signal, and
        //  worse mail besides: a text-only client, a watch or a screen reader
        //  had nothing to show. The text is DERIVED from the HTML, so the two
        //  cannot drift apart the way a hand-written second copy would.
        //
        //  The Body IS the text alternative. Adding a text/plain
        //  AlternateView as well sends it twice — the 10:00 UTC message on
        //  24 Sept had two identical text parts.
        if (html)
        {
            msg.Body = HtmlToText.Convert(body);
            msg.IsBodyHtml = false;
            msg.BodyEncoding = Encoding.UTF8;
            msg.AlternateViews.Add(
                AlternateView.CreateAlternateViewFromString(body, Encoding.UTF8, "text/html"));
        }
        else
        {
            msg.Body = body;
            msg.IsBodyHtml = false;
            msg.BodyEncoding = Encoding.UTF8;
        }

        // RFC 3834: a machine is writing, so an out-of-office must not answer
        // it and a mail loop cannot start.
        msg.Headers.Add("Auto-Submitted", "auto-generated");

        // On OUR domain, never the container's hostname — see MailIdentity.
        msg.Headers.Add("Message-ID", MailIdentity.MessageIdFor(sender));

        if (!string.IsNullOrWhiteSpace(unsubscribe))
        {
            msg.Headers.Add("List-Unsubscribe",
                unsubscribe.StartsWith('<') ? unsubscribe : $"<{unsubscribe}>");
            if (unsubscribe.Contains("http", StringComparison.OrdinalIgnoreCase))
                msg.Headers.Add("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
        }

        return msg;
    }
}

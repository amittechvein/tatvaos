using MimeKit;
using MimeKit.Text;
using MimeKit.Utils;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The shape of every system email: its parts, and its headers.
///
/// ── WHY THIS IS MIMEKIT NOW, LIKE WEBMAIL ────────────────────────────────
///
///  Mr. Singh, 24 September 2026, ruling on the day's three mail fixes:
///  "There are two mail paths, fixes to one do not propagate to the other,
///  and we have now found three divergences by reading three messages. The
///  sample was three and the hit rate was three... Diff the two paths
///  deliberately."
///
///  The diff found a fourth, and it was the worst of them: System.Net.Mail
///  gives no way to set the EHLO name, so every system email announced
///  itself to Postfix as the container's hostname — a random hex Docker id
///  that resolves to nothing:
///
///      webmail:      Received: from mx.tatvaos.com (tatvaos-api-1 ...)
///      system mail:  Received: from fab1a52ccfd5 (tatvaos-api-1 ...)
///
///  MailSender has set `client.LocalDomain` since the carriage work. The
///  system path could not, because of the library it used.
///
///  It also found: no display name on From (webmail sets one), a Date with
///  no day-of-week, and base64 where quoted-printable belongs.
///
///  Each of those is a small thing. FOUR of them, all in one direction, is
///  not a coincidence — it is what happens when one path gets the attention
///  and the other is written once and forgotten. So the answer is not four
///  more patches: it is to build system mail with the SAME library, the same
///  way, and to test the bytes.
///
/// ── WHAT IS DELIBERATELY DIFFERENT FROM WEBMAIL ──────────────────────────
///
///   · Auto-Submitted: auto-generated — a machine is writing (RFC 3834), so
///     an out-of-office must not answer and a loop cannot start. Webmail is
///     a person typing; it must NOT carry this.
///   · No List-Unsubscribe. Nothing TatvaOS sends can be turned off, and
///     offering to unsubscribe from a password reset or a sign-in alert
///     would be a lie and a way to switch off a security warning
///     (Mr. Singh, 24 Sept: leave it unwired; security mail never carries
///     one).
/// </summary>
public static class SystemMailMessage
{
    /// <summary>The name recipients see beside the address.</summary>
    public const string FromName = "TatvaOS";

    /// <param name="html">True when <paramref name="body"/> is HTML.</param>
    /// <param name="unsubscribe">
    /// Somewhere this KIND of message can be turned off, or null. Null for
    /// everything today — see the header.
    /// </param>
    public static MimeMessage Build(
        string sender, string to, string subject, string body, bool html, string? unsubscribe = null)
    {
        var mime = new MimeMessage();
        mime.From.Add(new MailboxAddress(FromName, sender));
        mime.To.Add(MailboxAddress.Parse(to));
        mime.Subject = subject;

        // On OUR domain, never the container's hostname. Identical to the call
        // webmail makes: a Message-ID that resolves to nothing is a spam
        // signal, and an absent one lets the receiver invent its own —
        // "SMTPIN_ADDED_MISSING@mx.google.com" was in a real message on
        // 24 Sept.
        var at = sender.LastIndexOf('@');
        mime.MessageId = MimeUtils.GenerateMessageId(
            at >= 0 && at < sender.Length - 1 ? sender[(at + 1)..] : "tatvaos.com");

        // MimeKit writes a Date with its day-of-week ("Thu, 24 Sep 2026
        // 11:30:10 +0000"). System.Net.Mail wrote it without, which is legal
        // and unusual, and unusual is what a filter scores.
        mime.Date = DateTimeOffset.UtcNow;

        var builder = new BodyBuilder();
        if (html)
        {
            // BOTH parts, ONCE each. The text is derived from the HTML so the
            // two cannot drift; a text/plain part added BESIDE the body is
            // what sent it twice on 24 Sept.
            builder.HtmlBody = body;
            builder.TextBody = HtmlToText.Convert(body);
        }
        else
        {
            builder.TextBody = body;
        }
        mime.Body = builder.ToMessageBody();

        // Quoted-printable, not base64: a plain-text part that a person may
        // have to read in "show original" should stay legible there.
        foreach (var part in mime.BodyParts.OfType<TextPart>())
            part.ContentTransferEncoding = ContentEncoding.QuotedPrintable;

        mime.Headers.Add("Auto-Submitted", "auto-generated");

        if (!string.IsNullOrWhiteSpace(unsubscribe))
        {
            mime.Headers.Add("List-Unsubscribe",
                unsubscribe.StartsWith('<') ? unsubscribe : $"<{unsubscribe}>");
            if (unsubscribe.Contains("http", StringComparison.OrdinalIgnoreCase))
                mime.Headers.Add("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
        }

        return mime;
    }
}

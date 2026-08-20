using MimeKit;

namespace TatvaOS.Api.Modules.Calendar;

/// <summary>
/// Checks an ASSEMBLED iMIP message against the structural rules in
/// docs/MAIL_IMIP_SEAM.md. Mail builds the message; this says whether the
/// result is one Gmail and Outlook will render as an invitation.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS, AND WHY IT LIVES HERE
///
///  The seam splits cleanly — Calendar produces the VCALENDAR text, Mail
///  assembles the MIME. But that left a gap neither side could close alone:
///  Mail can assemble correctly and has no Gmail samples to check against;
///  Calendar has the samples and does not own the assembly. Mail named the
///  gap rather than papering over it, which is why it is being closed.
///
///  So the RULES live with the seam that defines them, and the ASSEMBLY stays
///  with Mail. One definition of correct, checked by whoever builds. The
///  alternative — Calendar writing a second assembler for its tests — is the
///  two-implementations problem that produced a duplicate endpoint client on
///  this platform earlier the same day.
///
///  Returns a list of problems rather than throwing or returning a bool: a
///  test wants to print what is wrong, and "the structure is not right" with
///  no detail is the kind of failure that costs an afternoon.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class ImipStructure
{
    /// <summary>
    /// Empty list means the message satisfies every structural rule the seam
    /// specifies. It does NOT mean Gmail will render buttons — only a real
    /// send can tell you that (seam §7). It means nothing we already know to
    /// be wrong is wrong.
    /// </summary>
    public static IReadOnlyList<string> Check(MimeMessage message, string expectedMethod)
    {
        var problems = new List<string>();
        if (message is null) return ["the message is null"];

        var alternative = FindAlternative(message.Body);
        if (alternative is null)
        {
            problems.Add("no multipart/alternative — the invitation must be an ALTERNATIVE to the "
                       + "text and HTML bodies, not merely attached. Gmail reads the alternative "
                       + "part; an attachment alone renders as a paperclip.");
        }
        else
        {
            var calendarParts = alternative.OfType<MimePart>()
                .Where(p => p.ContentType.IsMimeType("text", "calendar"))
                .ToList();

            if (calendarParts.Count == 0)
            {
                problems.Add("multipart/alternative contains no text/calendar part");
            }
            else
            {
                // LAST, not merely present. A receiver picks the last
                // alternative it understands (RFC 2046 §5.1.4), so a calendar
                // part before the HTML is a calendar part Gmail will skip.
                if (!ReferenceEquals(alternative.Last(), calendarParts[^1]))
                    problems.Add("the text/calendar part is not LAST inside multipart/alternative. "
                               + "A receiver picks the last alternative it understands, so this "
                               + "one will be passed over in favour of the HTML.");

                var part = calendarParts[^1];
                var method = part.ContentType.Parameters["method"];

                if (string.IsNullOrEmpty(method))
                    problems.Add("the text/calendar Content-Type has no method= parameter. That "
                               + "parameter — not the body — is what makes Gmail render "
                               + "Accept/Decline instead of a file.");
                else if (!method.Equals(expectedMethod, StringComparison.OrdinalIgnoreCase))
                    problems.Add($"Content-Type method={method} but the caller said {expectedMethod}");

                var charset = part.ContentType.Charset;
                if (string.IsNullOrEmpty(charset) || !charset.Equals("utf-8", StringComparison.OrdinalIgnoreCase))
                    problems.Add($"text/calendar charset is '{charset}', expected utf-8");

                problems.AddRange(CheckPayload(part, expectedMethod, "alternative part"));
            }
        }

        // The second carriage. Gmail reads the alternative; some Outlook
        // versions only ever see the attachment. Both, always — this is the
        // single most load-bearing compatibility fact in the seam.
        var attachment = message.BodyParts.OfType<MimePart>().FirstOrDefault(p =>
            p.IsAttachment && (p.FileName ?? "").EndsWith(".ics", StringComparison.OrdinalIgnoreCase));

        if (attachment is null)
            problems.Add("no .ics ATTACHMENT. The dual carriage is not optional: Gmail reads the "
                       + "alternative part, some Outlook versions only see the attachment.");
        else
            problems.AddRange(CheckPayload(attachment, expectedMethod, "attachment"));

        return problems;
    }

    /// <summary>
    /// The payload survived assembly intact. Encoding is deliberately NOT
    /// asserted — base64 and quoted-printable both preserve the bytes, and
    /// pinning one would fail a correct message for a reason that does not
    /// matter. What matters is what comes back out.
    /// </summary>
    private static IEnumerable<string> CheckPayload(MimePart part, string expectedMethod, string where)
    {
        string text;
        try
        {
            using var memory = new MemoryStream();
            part.Content.DecodeTo(memory);
            text = System.Text.Encoding.UTF8.GetString(memory.ToArray());
        }
        catch (Exception ex)
        {
            yield return $"{where}: the payload could not be decoded ({ex.GetType().Name})";
            yield break;
        }

        if (!text.Contains("BEGIN:VCALENDAR", StringComparison.Ordinal))
        {
            yield return $"{where}: payload is not a VCALENDAR";
            yield break;
        }

        // Bare LF is accepted by Gmail and REJECTED by Exchange — the worst
        // possible split, because it passes every test until it reaches the
        // customer who bought the product for Outlook.
        if (text.Replace("\r\n", "").Contains('\n'))
            yield return $"{where}: payload contains bare LF. Line endings must be CRLF throughout.";

        if (!text.EndsWith("\r\n", StringComparison.Ordinal))
            yield return $"{where}: payload does not end with CRLF";

        // The header says one thing and the body another is the drift the
        // seam's mismatch check exists to catch. Assert it on the real bytes.
        var methodLine = Imip.Unfold(text)
            .FirstOrDefault(l => l.StartsWith("METHOD:", StringComparison.OrdinalIgnoreCase));
        if (methodLine is null)
            yield return $"{where}: payload has no METHOD: line";
        else if (!methodLine["METHOD:".Length..].Trim()
                 .Equals(expectedMethod, StringComparison.OrdinalIgnoreCase))
            yield return $"{where}: payload says {methodLine}, caller said METHOD:{expectedMethod}";

        // 75 OCTETS, not characters. A Hindi meeting title is three bytes a
        // character, so this is the check that fails for our customers and
        // not for us.
        foreach (var line in text.Split("\r\n"))
            if (System.Text.Encoding.UTF8.GetByteCount(line) > 75)
            {
                yield return $"{where}: a line exceeds 75 octets — folding was lost in assembly";
                break;
            }
    }

    /// <summary>
    /// Matched on the CONTENT TYPE, deliberately, and not on the CLR type.
    ///
    /// MimeKit only instantiates its MultipartAlternative class when it PARSES
    /// a message. Code that builds one — which is what Mail does, and what any
    /// caller of this method will hand us — writes `new Multipart("alternative")`
    /// and gets a plain Multipart whose subtype happens to be "alternative".
    /// The two produce byte-identical output; only the object graph differs.
    ///
    /// Checking `is MultipartAlternative` therefore rejected every correctly
    /// assembled message that had not been round-tripped through the parser.
    /// Found 20 August 2026, by running this against Mail's real builder rather
    /// than against a message this file had assembled itself — which is the
    /// entire argument for linking the production file instead of copying it.
    /// </summary>
    private static Multipart? FindAlternative(MimeEntity? entity)
    {
        if (entity is Multipart multipart)
        {
            if (multipart.ContentType.IsMimeType("multipart", "alternative")) return multipart;
            foreach (var child in multipart)
                if (FindAlternative(child) is { } found) return found;
        }
        return null;
    }
}

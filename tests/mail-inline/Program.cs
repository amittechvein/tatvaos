using MimeKit;
using TatvaOS.Api.Modules.Mail;

namespace TatvaOS.Tests.MailInline;

/// <summary>
/// Usage:  dotnet run --project tests/mail-inline
/// Exit:   0 = all assertions passed, 1 = at least one failed. Read the last line.
/// </summary>
internal static class Program
{
    private static int _failed, _passed;

    private static void Check(string what, object? expected, object? actual)
    {
        if (Equals(expected, actual)) { _passed++; Console.WriteLine($"  ok    {what}"); return; }
        _failed++;
        Console.WriteLine($"  FAIL  {what}");
        Console.WriteLine($"          expected  {expected}");
        Console.WriteLine($"          actual    {actual}");
    }

    // The smallest valid PNG there is: 1x1, transparent.
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

    private static MimePart Picture(string cid, string disposition, string subtype = "png", byte[]? bytes = null, string? name = null) => new("image", subtype)
    {
        Content = new MimeContent(new MemoryStream(bytes ?? Png)),
        ContentId = cid,
        ContentDisposition = new ContentDisposition(disposition) { FileName = name },
        ContentTransferEncoding = ContentEncoding.Base64,
    };

    /// <summary>Through text and back through MailContent.Parse: the door a stored message uses.</summary>
    private static MimeMessage Stored(string html, params MimeEntity[] parts)
    {
        var related = new MultipartRelated { new TextPart("html") { Text = html } };
        foreach (var p in parts.Where(p => p is MimePart { ContentDisposition.Disposition: "inline" })) related.Add(p);
        var mixed = new Multipart("mixed") { related };
        foreach (var p in parts.Where(p => p is not MimePart { ContentDisposition.Disposition: "inline" })) mixed.Add(p);

        var m = new MimeMessage();
        m.From.Add(new MailboxAddress("Sender", "s@example.com"));
        m.To.Add(new MailboxAddress("Amit", "amit@example.com"));
        m.Subject = "pictures";
        m.Body = mixed;
        using var ms = new MemoryStream();
        m.WriteTo(ms);
        return MailContent.Parse(MailContent.RawEncoding.GetString(ms.ToArray()));
    }

    private static int Main()
    {
        Console.WriteLine();
        Console.WriteLine("  MailInlineImages — the pictures an email points at with cid:");
        Console.WriteLine("  ═════════════════════════════════════════════════════════════");

        // ── Outlook's shape: disposition inline, NOT among the attachments ──
        {
            var html = "<p>Regards</p><img src=\"cid:logo@corp\" alt=\"logo\">";
            var msg = Stored(html, Picture("logo@corp", "inline"));
            var got = MailInlineImages.For(msg, msg.HtmlBody);
            Check("outlook: the picture is found", 1, got.Count);
            Check("outlook: keyed by the bare Content-ID", "logo@corp", got.FirstOrDefault()?.Cid);
            Check("outlook: a png data URI carrying the bytes", "data:image/png;base64," + Convert.ToBase64String(Png), got.FirstOrDefault()?.DataUri);
            Check("outlook: it is not an attachment, so no index", null, got.FirstOrDefault()?.AttachmentIndex);
            Check("outlook: and the attachment list is empty", 0, MailContent.AttachmentParts(msg).Count);
        }

        // ── Gmail's shape, the one seen on the phone: disposition ATTACHMENT, with a Content-ID ──
        {
            var html = "<table><tr><td><img src='cid:icon.png' alt='Error Icon'></td></tr></table>";
            var msg = Stored(html,
                new MimePart("application", "pdf") { Content = new MimeContent(new MemoryStream([1, 2, 3])), ContentDisposition = new ContentDisposition("attachment") { FileName = "report.pdf" } },
                Picture("icon.png", "attachment", name: "icon.png"));
            var got = MailInlineImages.For(msg, msg.HtmlBody);
            Check("gmail: the picture is found though it is 'an attachment'", 1, got.Count);
            Check("gmail: and says WHICH attachment it is (the pdf is 0, the icon 1)", 1, got.FirstOrDefault()?.AttachmentIndex);
        }

        // ── a Content-ID nobody points at is an attachment, not a picture ──
        {
            var msg = Stored("<p>see attached</p>", Picture("unused@x", "attachment", name: "photo.png"));
            Check("unreferenced: nothing is inlined", 0, MailInlineImages.For(msg, msg.HtmlBody).Count);
        }

        // ── the scanner's refusal holds ──
        {
            var msg = Stored("<img src=\"cid:bad\">", Picture("bad", "attachment", name: "bad.png"));
            Check("infected: a refused download does not come back as a picture", 0,
                MailInlineImages.For(msg, msg.HtmlBody, new HashSet<int> { 0 }).Count);
            Check("infected: the same message, not blocked, would have shown it", 1,
                MailInlineImages.For(msg, msg.HtmlBody, new HashSet<int>()).Count);
        }

        // ── types ──
        {
            var svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"u8.ToArray();
            var msg = Stored("<img src=\"cid:v\"><img src=\"cid:j\">",
                Picture("v", "inline", "svg+xml", svg), Picture("j", "inline", "jpg"));
            var got = MailInlineImages.For(msg, msg.HtmlBody);
            Check("svg is never inlined; the jpeg beside it is", "j", string.Join(",", got.Select(g => g.Cid)));
            Check("'jpg' is said as image/jpeg", "image/jpeg", got.FirstOrDefault()?.ContentType);

            var liar = new MimePart("text", "html") { Content = new MimeContent(new MemoryStream("<script>x</script>"u8.ToArray())), ContentId = "h", ContentDisposition = new ContentDisposition("inline") };
            var msg2 = Stored("<img src=\"cid:h\">", liar);
            Check("a non-image part with a Content-ID is not a picture", 0, MailInlineImages.For(msg2, msg2.HtmlBody).Count);
        }

        // ── size ──
        {
            var big = new byte[MailInlineImages.MaxBytesEach + 1];
            var msg = Stored("<img src=\"cid:big\"><img src=\"cid:small\">", Picture("big", "inline", bytes: big), Picture("small", "inline"));
            Check("over the per-picture cap is skipped; the small one still shows", "small",
                string.Join(",", MailInlineImages.For(msg, msg.HtmlBody).Select(g => g.Cid)));

            var chunk = new byte[MailInlineImages.MaxBytesEach];
            var many = Enumerable.Range(0, 5).Select(i => (MimeEntity)Picture($"p{i}", "inline", bytes: chunk)).ToArray();
            var msg2 = Stored(string.Concat(Enumerable.Range(0, 5).Select(i => $"<img src=\"cid:p{i}\">")), many);
            Check("the per-message cap stops at three of five 2 MB pictures", 3, MailInlineImages.For(msg2, msg2.HtmlBody).Count);
        }

        // ── references ──
        {
            var refs = MailInlineImages.Referenced("<img src=\"cid:a@b\"> <img src='CID:c%40d'> <td background=cid:e> url(cid:f)");
            Check("references: quoted, upper-case scheme, url-encoded, unquoted, css url()", "a@b,c@d,e,f", string.Join(",", refs.OrderBy(x => x, StringComparer.Ordinal)));
            Check("references: none in plain html", 0, MailInlineImages.Referenced("<p>hello</p>").Count);
            Check("references: null is none", 0, MailInlineImages.Referenced(null).Count);

            var msg = Stored("<img src=\"cid:same\"><img src=\"cid:same\">", Picture("same", "inline"));
            Check("one picture used twice is sent once", 1, MailInlineImages.For(msg, msg.HtmlBody).Count);
        }

        Console.WriteLine();
        Console.WriteLine(_failed == 0 ? $"  PASSED  {_passed} checks" : $"  FAILED  {_failed} of {_passed + _failed} checks");
        return _failed == 0 ? 0 : 1;
    }
}

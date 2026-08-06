using System.Text;
using MimeKit;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Everything that turns a raw MIME message into what the client renders.
///
/// The raw message is the canonical copy — bodies and attachment bytes are
/// never stored twice. This class is the ONLY place that parses it, so the
/// day blobs move from the raw_body column to object storage, the change is
/// confined to whoever hands this class its bytes.
/// </summary>
public static class MailContent
{
    /// <summary>
    /// Raw MIME is a byte sequence, but it is stored in a text column. Latin-1
    /// maps every byte to exactly one char and back, so encode/decode through
    /// it round-trips byte-for-byte. UTF-8 would corrupt any 8-bit body the
    /// first time it met a byte sequence that is not valid UTF-8.
    /// </summary>
    public static readonly Encoding RawEncoding = Encoding.Latin1;

    public static MimeMessage Parse(string rawBody)
    {
        using var stream = new MemoryStream(RawEncoding.GetBytes(rawBody));
        return MimeMessage.Load(stream);
    }

    /// <summary>
    /// The list row's preview. Plain text preferred; when the sender only
    /// provided HTML, tags are stripped crudely — this is a one-line preview,
    /// not a rendering.
    /// </summary>
    public static string Snippet(MimeMessage message, int maxLength = 300)
    {
        var text = message.TextBody;
        if (string.IsNullOrWhiteSpace(text))
        {
            var html = message.HtmlBody;
            if (string.IsNullOrWhiteSpace(html)) return "";
            text = StripHtml(html);
        }

        var collapsed = CollapseWhitespace(text);
        return collapsed.Length <= maxLength ? collapsed : collapsed[..maxLength];
    }

    /// <summary>
    /// The message's attachments in document order. The index into this list
    /// is what mail.attachments.part_index stores, so the enumeration must be
    /// deterministic — MimeKit walks the tree in document order, which is.
    /// </summary>
    public static List<MimePart> AttachmentParts(MimeMessage message) =>
        message.Attachments.OfType<MimePart>().ToList();

    public static (string? Name, string? Address) FirstFrom(MimeMessage message)
    {
        var from = message.From.Mailboxes.FirstOrDefault();
        return (string.IsNullOrWhiteSpace(from?.Name) ? null : from!.Name, from?.Address);
    }

    public static string[] Addresses(InternetAddressList list) =>
        list.Mailboxes.Select(m => m.Address).ToArray();

    private static string StripHtml(string html)
    {
        var sb = new StringBuilder(html.Length);
        var inTag = false;
        foreach (var c in html)
        {
            if (c == '<') { inTag = true; continue; }
            if (c == '>') { inTag = false; sb.Append(' '); continue; }
            if (!inTag) sb.Append(c);
        }
        return System.Net.WebUtility.HtmlDecode(sb.ToString());
    }

    private static string CollapseWhitespace(string s)
    {
        var sb = new StringBuilder(s.Length);
        var lastWasSpace = true;
        foreach (var c in s)
        {
            if (char.IsWhiteSpace(c))
            {
                if (!lastWasSpace) sb.Append(' ');
                lastWasSpace = true;
            }
            else
            {
                sb.Append(c);
                lastWasSpace = false;
            }
        }
        return sb.ToString().Trim();
    }
}

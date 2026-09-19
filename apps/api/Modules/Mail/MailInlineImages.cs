using System.Text.RegularExpressions;
using MimeKit;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// The pictures an email carries INSIDE itself and points at from its HTML as
/// &lt;img src="cid:…"&gt; — a logo in a signature, the icon in a bounce, a
/// screenshot pasted into a reply.
///
/// Until 19 Sept 2026 nothing in the product resolved them. The reading pane
/// handed the sender's HTML over as it came; "cid:" is not an address any
/// browser can fetch, so every such picture drew as a broken-image icon with
/// its alt text, on the web and on the phone. Seen on Amit's Samsung in a
/// Gmail bounce: "Error Icon", and the same picture listed underneath as an
/// attachment called icon.png.
///
/// WHY THE BYTES TRAVEL WITH THE MESSAGE, AS data: URIs, IN THEIR OWN FIELD.
///  • An &lt;img&gt; cannot send an Authorization header, so it cannot fetch
///    the attachment endpoint; a cookie-less API has no other way to let a
///    page load a private picture. The client has to be GIVEN the bytes.
///  • They are NOT written into bodyHtml. Reply and forward quote bodyHtml,
///    and a quoted data: URI is megabytes of base64 in an outgoing email.
///    Clients substitute at display time and nowhere else.
///  • Raster types only. An SVG is a document that can carry script; inside
///    an &lt;img&gt; it cannot run it, but a client that one day renders this
///    field some other way should not inherit that bet.
///  • Capped, per picture and per message. Past the cap a picture is left as
///    it was: broken in the body, and still listed as an attachment where it
///    was one — never silently dropped from both places.
///
/// No schema change: the stored raw message is re-parsed on every read anyway
/// (MailEndpoints.GetMessageAsync), and the Content-ID is read there.
/// </summary>
public static partial class MailInlineImages
{
    public const int MaxBytesEach = 2 * 1024 * 1024;
    public const int MaxBytesTotal = 6 * 1024 * 1024;

    private static readonly HashSet<string> Raster = new(StringComparer.OrdinalIgnoreCase)
        { "png", "jpeg", "jpg", "gif", "webp", "bmp" };

    /// <param name="Cid">The Content-ID without its angle brackets — what follows "cid:" in the HTML.</param>
    /// <param name="DataUri">data:image/…;base64,…</param>
    /// <param name="AttachmentIndex">This part's index in <see cref="MailContent.AttachmentParts"/> when it is
    /// ALSO listed as an attachment (Gmail marks inline pictures that way), else null.</param>
    public sealed record Image(string Cid, string ContentType, string DataUri, int? AttachmentIndex);

    [GeneratedRegex("""cid:([^"'\s<>)]+)""", RegexOptions.IgnoreCase)]
    private static partial Regex CidRef();

    /// <summary>Every Content-ID the HTML points at, URL-decoded, as written otherwise.</summary>
    public static HashSet<string> Referenced(string? html)
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(html)) return found;
        foreach (Match m in CidRef().Matches(html))
            found.Add(Uri.UnescapeDataString(m.Groups[1].Value));
        return found;
    }

    /// <summary>
    /// The pictures <paramref name="html"/> actually points at, in document
    /// order. A part nobody references is not returned: it is an attachment,
    /// or nothing, and either way not this method's business.
    /// </summary>
    /// <param name="blockedAttachmentIndexes">Attachment indexes the scanner
    /// marked infected. A refused download must not come back as a picture.</param>
    public static List<Image> For(MimeMessage message, string? html, ISet<int>? blockedAttachmentIndexes = null)
    {
        var images = new List<Image>();
        var wanted = Referenced(html);
        if (wanted.Count == 0) return images;

        var attachmentParts = MailContent.AttachmentParts(message);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        long total = 0;

        foreach (var part in message.BodyParts.OfType<MimePart>())
        {
            var cid = part.ContentId;
            if (string.IsNullOrWhiteSpace(cid)) continue;
            cid = cid.Trim().TrimStart('<').TrimEnd('>');
            if (!wanted.Contains(cid) || !seen.Add(cid)) continue;

            if (!part.ContentType.IsMimeType("image", "*") || !Raster.Contains(part.ContentType.MediaSubtype)) continue;
            if (part.Content is null) continue;

            var index = attachmentParts.IndexOf(part);
            if (index >= 0 && blockedAttachmentIndexes is not null && blockedAttachmentIndexes.Contains(index)) continue;

            using var buffer = new MemoryStream();
            part.Content.DecodeTo(buffer);
            if (buffer.Length == 0 || buffer.Length > MaxBytesEach) continue;
            if (total + buffer.Length > MaxBytesTotal) continue;
            total += buffer.Length;

            // The type is rebuilt from the allow-list match, never echoed from
            // the header: a header is sender-controlled text, and this string
            // ends up inside a URI inside somebody's page.
            var subtype = part.ContentType.MediaSubtype.ToLowerInvariant();
            if (subtype == "jpg") subtype = "jpeg";
            var type = $"image/{subtype}";
            images.Add(new Image(cid, type, $"data:{type};base64,{Convert.ToBase64String(buffer.GetBuffer(), 0, (int)buffer.Length)}",
                index >= 0 ? index : null));
        }
        return images;
    }
}

using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Pictures inside an outgoing message, turned into real inline attachments.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY. The composer holds a picture as a data: URI in the HTML — that is
///  what a pasted screenshot is, and what the "Insert image" button produces.
///  Until 25 Sept 2026 MailSender put that HTML into the message as it came,
///  so every picture travelled as <img src="data:image/png;base64,…">.
///
///  Gmail does not display data: images in received mail, and Outlook
///  blocks them. The sender saw the picture in their own compose window and
///  their Sent folder; the recipient saw a gap. That is the failure this
///  codebase calls silent: nothing errors, the evidence is on someone else's
///  screen.
///
///  So at send time each data: image becomes a MIME part with a Content-ID,
///  and the HTML points at it with cid: — multipart/related, which is how
///  Gmail, Outlook and Apple Mail send pictures themselves. The Sent copy
///  keeps the MIME, and MailInlineImages turns cid: back into something our
///  own viewer can show, so the sender's view is unchanged.
///
///  The same picture used twice is attached once. Anything that does not
///  decode is left exactly as it was: a send never fails because of this.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static partial class OutgoingInlineImages
{
    /// <param name="ContentId">Without angle brackets — what follows "cid:".</param>
    /// <param name="Subtype">png, jpeg, gif or webp.</param>
    public sealed record Image(string ContentId, string Subtype, byte[] Bytes)
    {
        public string FileName(int n) => $"image{n}.{(Subtype == "jpeg" ? "jpg" : Subtype)}";
    }

    // An <img ...src="data:image/TYPE;base64,DATA"> with either quote, the
    // src in any position among the attributes. The data class admits
    // whitespace because some editors wrap long base64. No nested
    // quantifiers, so the match is linear in the size of the body.
    [GeneratedRegex(
        """(<img\b[^>]*?\bsrc\s*=\s*)(["'])data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)\2""",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DataImage();

    /// <summary>
    /// The HTML with each data: image replaced by cid:, and the images to
    /// attach. <paramref name="domain"/> is the sender's domain, so the
    /// Content-IDs look like the Message-ID beside them.
    /// </summary>
    public static (string Html, IReadOnlyList<Image> Images) Extract(string html, string domain)
    {
        if (string.IsNullOrEmpty(html)
            || html.IndexOf("data:image", StringComparison.OrdinalIgnoreCase) < 0)
            return (html, Array.Empty<Image>());

        var images = new List<Image>();
        var cidByHash = new Dictionary<string, string>(StringComparer.Ordinal);

        var rewritten = DataImage().Replace(html, m =>
        {
            var b64 = StripWhitespace(m.Groups[4].Value);
            byte[] bytes;
            try { bytes = Convert.FromBase64String(b64); }
            catch (FormatException) { return m.Value; }   // not ours to fix; leave it
            if (bytes.Length == 0) return m.Value;

            var hash = Convert.ToHexString(SHA256.HashData(bytes));
            if (!cidByHash.TryGetValue(hash, out var cid))
            {
                cid = $"{Guid.NewGuid():N}@{domain}";
                cidByHash[hash] = cid;
                var sub = m.Groups[3].Value.ToLowerInvariant();
                images.Add(new Image(cid, sub == "jpg" ? "jpeg" : sub, bytes));
            }
            var q = m.Groups[2].Value;
            return $"{m.Groups[1].Value}{q}cid:{cid}{q}";
        });

        return (rewritten, images);
    }

    private static string StripWhitespace(string s)
    {
        if (s.AsSpan().IndexOfAny(" \t\r\n") < 0) return s;
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (var c in s) if (!char.IsWhiteSpace(c)) sb.Append(c);
        return sb.ToString();
    }
}

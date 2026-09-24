using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// The plain-text half of an HTML email, derived from the HTML itself.
///
/// ── WHY ──────────────────────────────────────────────────────────────────
///
///  Amit, 24 September 2026: TatvaOS mail landing in Gmail's spam folder.
///  Gmail's own verdict on the message he forwarded was dkim=pass, spf=pass,
///  dmarc=pass — the authentication was perfect. What was wrong was the
///  MESSAGE: SystemMailer sent `IsBodyHtml = true` and nothing else, so every
///  invitation, sign-in link, welcome, alert and storage warning went out as
///  HTML with NO text/plain alternative. That is a spam signal of long
///  standing (genuine senders send both), and it is also simply worse mail: a
///  watch, a screen reader, or a text-only client had nothing to show.
///
///  Mail's own composer and the calendar invitations were never affected —
///  they build multipart/alternative through MailSender. Only the system
///  notices used this path.
///
/// ── WHAT IT PRODUCES ─────────────────────────────────────────────────────
///
///  Something a person can read, not a markup dump. Headings and paragraphs
///  become blank-line-separated blocks, list items become "- item", and a
///  link becomes "text (https://...)" so the address is READABLE rather than
///  lost — which matters most for the one link these emails exist to carry.
///
///  Hidden preheader text is dropped: it exists to fill the inbox preview and
///  reads as a duplicate first line in a text part.
///
///  This is deliberately NOT a general HTML renderer. It handles the mail
///  templates in this repository — tables, inline styles, buttons — and each
///  of those shapes has a test.
/// </summary>
public static class HtmlToText
{
    private static readonly RegexOptions Opts =
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant;

    /// <summary>Everything whose CONTENT is not for a reader.</summary>
    private static readonly Regex Invisible =
        new(@"<(script|style|head|title)\b[^>]*>.*?</\1\s*>", Opts);

    /// <summary>A preheader: a div styled to be invisible, holding the inbox preview.</summary>
    private static readonly Regex Preheader =
        new(@"<div[^>]*style=""[^""]*display\s*:\s*none[^""]*""[^>]*>.*?</div\s*>", Opts);

    private static readonly Regex Anchor =
        new(@"<a\b[^>]*href\s*=\s*[""']([^""']+)[""'][^>]*>(.*?)</a\s*>", Opts);

    private static readonly Regex Breaks =
        new(@"<br\s*/?>|</(p|div|h[1-6]|tr|table|li|blockquote)\s*>", Opts);

    private static readonly Regex ListItem = new(@"<li\b[^>]*>", Opts);
    private static readonly Regex Rule = new(@"<hr\s*/?>", Opts);
    private static readonly Regex AnyTag = new(@"<[^>]+>", Opts);
    private static readonly Regex ManyBlankLines = new(@"(\r?\n[ \t]*){3,}", Opts);
    private static readonly Regex TrailingSpace = new(@"[ \t]+(\r?\n)", Opts);
    private static readonly Regex ManySpaces = new(@"[ \t]{2,}", Opts);

    public static string Convert(string? html)
    {
        if (string.IsNullOrWhiteSpace(html)) return string.Empty;

        var s = html;
        s = Invisible.Replace(s, " ");
        s = Preheader.Replace(s, " ");

        // A link keeps its address. "Set your password (https://…)" — without
        // this, the text part of an email whose whole purpose is one button
        // would contain no way to act on it.
        s = Anchor.Replace(s, m =>
        {
            var url = WebUtility.HtmlDecode(m.Groups[1].Value).Trim();
            var label = AnyTag.Replace(m.Groups[2].Value, " ").Trim();
            label = WebUtility.HtmlDecode(label);
            label = ManySpaces.Replace(label, " ").Trim();
            if (url.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
                return label.Length == 0 ? url[7..] : label;
            if (label.Length == 0) return url;
            // Don't print the address twice when the label IS the address.
            return string.Equals(label, url, StringComparison.OrdinalIgnoreCase)
                ? url
                : $"{label} ({url})";
        });

        s = ListItem.Replace(s, "\n- ");
        s = Rule.Replace(s, "\n\n");
        s = Breaks.Replace(s, "\n");
        s = AnyTag.Replace(s, "");
        s = WebUtility.HtmlDecode(s);

        // Tidy: real line breaks, no runs of blank lines, no trailing spaces.
        s = s.Replace(" ", " ").Replace("\r\n", "\n");
        s = ManySpaces.Replace(s, " ");
        s = TrailingSpace.Replace(s, "$1");
        s = ManyBlankLines.Replace(s, "\n\n");

        var lines = s.Split('\n').Select(l => l.Trim());
        return string.Join("\n", lines).Trim() + "\n";
    }
}

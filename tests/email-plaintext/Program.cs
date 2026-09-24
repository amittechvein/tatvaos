using TatvaOS.Api.Shared.Notify;

namespace TatvaOS.Tests.EmailPlaintext;

/// <summary>
/// The plain-text half of every system email (Shared/Notify/HtmlToText.cs).
///
/// Amit, 24 September 2026: TatvaOS mail arriving in Gmail's spam folder.
/// Gmail's headers said dkim=pass, spf=pass, dmarc=pass — so the fault was
/// the message, not the authentication: SystemMailer sent HTML with no
/// text/plain alternative at all.
///
/// The test runs against a REAL template (InviteEmail), not a fixture, so it
/// measures the mail this platform actually sends.
///
/// Usage:   dotnet run --project tests/email-plaintext
///          TEXT_PREVIEW=1 also prints the text part, to read with eyes.
/// Exit:    0 all passed, 1 otherwise.
/// </summary>
internal static class Program
{
    private static int passed, failed;

    private static void Ok(string what, bool ok)
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}"); }
    }

    private static int Main()
    {
        const string link = "https://core.tatvaos.com/welcome#t=TOKEN";
        var html = InviteEmail.Html("Ravi Kumar", "Techvein", "https://core.tatvaos.com",
                                    "ravi@techvein.in", link, 72);
        var text = HtmlToText.Convert(html);

        Console.WriteLine();
        Console.WriteLine("  The text part of a real invitation email");
        Console.WriteLine("  ========================================");
        Console.WriteLine();

        Ok("there IS a text part", text.Trim().Length > 100);
        Ok("no markup survives", !text.Contains('<') && !text.Contains('>'));
        Ok("no CSS leaks in", !text.Contains("font-family", StringComparison.OrdinalIgnoreCase)
                              && !text.Contains("padding:", StringComparison.OrdinalIgnoreCase)
                              && !text.Contains("#ffffff", StringComparison.OrdinalIgnoreCase));
        Ok("the greeting is there, by name", text.Contains("Welcome to TatvaOS, Ravi."));
        Ok("the organisation is named", text.Contains("Techvein"));
        Ok("the address they will sign in as", text.Contains("ravi@techvein.in"));

        // The whole point of this email is one link. A text part without it
        // would be worse than no text part.
        Ok("the one-time LINK is readable", text.Contains(link));
        Ok("the button's words survive with its address",
            text.Contains("Set your password (" + link + ")"));
        Ok("the expiry sentence survives", text.Contains("works once and expires"));
        Ok("the app row reads as words, not a table",
            text.Contains("Mail") && text.Contains("Connect") && text.Contains("Calendar") && text.Contains("Space"));

        Console.WriteLine();
        Console.WriteLine("  Shapes these templates use");
        Ok("entities are decoded (&amp; -> &)", HtmlToText.Convert("<p>Ravi &amp; Co &#8217;26</p>").Contains("Ravi & Co ’26"));
        Ok("<br> becomes a line break", HtmlToText.Convert("a<br>b").Trim() == "a\nb");
        Ok("list items become dashes", HtmlToText.Convert("<ul><li>one</li><li>two</li></ul>").Contains("- one"));
        Ok("a hidden preheader is dropped",
            !HtmlToText.Convert("<div style=\"display:none;max-height:0\">preview line</div><p>Real</p>")
                .Contains("preview"));
        Ok("style and script content never appear",
            !HtmlToText.Convert("<style>.x{color:red}</style><script>alert(1)</script><p>Hi</p>").Contains("color")
            && !HtmlToText.Convert("<style>.x{color:red}</style><script>alert(1)</script><p>Hi</p>").Contains("alert"));
        Ok("a mailto link shows the address, not the scheme",
            HtmlToText.Convert("<a href=\"mailto:help@tatvaos.com\">help@tatvaos.com</a>").Trim() == "help@tatvaos.com");
        Ok("a link whose text IS its address is not printed twice",
            HtmlToText.Convert("<a href=\"https://x.test/a\">https://x.test/a</a>").Trim() == "https://x.test/a");
        Ok("no run of blank lines", !text.Contains("\n\n\n"));
        Ok("no line begins or ends with a space",
            text.Split('\n').All(l => l == l.Trim()));
        Ok("empty html gives empty text, not a crash", HtmlToText.Convert(null) == "" && HtmlToText.Convert("  ") == "");

        Console.WriteLine();
        Console.WriteLine("  The Message-ID (Amit's forwarded mail had NONE; Gmail invented one)");
        var id = MailIdentity.MessageIdFor("no_reply@tatvaos.com");
        Ok("has the angle brackets a header needs", id.StartsWith('<') && id.EndsWith('>'));
        Ok("on the SENDER's domain, never the container's hostname", id.EndsWith("@tatvaos.com>"));
        Ok("two calls never collide", MailIdentity.MessageIdFor("a@b.test") != MailIdentity.MessageIdFor("a@b.test"));
        Ok("a display-name sender reads the right domain",
            MailIdentity.MessageIdFor("TatvaOS <no_reply@tatvaos.com>").EndsWith("@tatvaos.com>"));
        Ok("an address with no domain still gets ours",
            MailIdentity.MessageIdFor("broken").EndsWith("@tatvaos.com>"));
        Ok("null or empty does not throw", MailIdentity.MessageIdFor(null).EndsWith("@tatvaos.com>")
            && MailIdentity.MessageIdFor("").EndsWith("@tatvaos.com>"));
        Ok("no spaces or control characters (a header must not fold here)",
            !id.Contains(' ') && id.All(c => !char.IsControl(c)));

        if (Environment.GetEnvironmentVariable("TEXT_PREVIEW") is { Length: > 0 })
        {
            Console.WriteLine();
            Console.WriteLine("  ---- the text part, as a recipient would see it ----");
            Console.WriteLine(text);
        }

        Console.WriteLine();
        Console.WriteLine("  ========================================");
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed} assertions");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;
    }
}

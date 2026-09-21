using TatvaOS.Api.Shared.Notify;

namespace TatvaOS.Tests.InviteEmail;

/// <summary>
/// The invitation / sign-in link email (Shared/Notify/InviteEmail.cs): what each
/// of its two versions says, and that the four apps sit below the button.
///
/// Amit, 21 Sept 2026, on a real sign-in link in his inbox: a welcome note at the
/// start, and the TatvaOS apps (Mail, Connect, Calendar, Space) below the button.
///
/// Usage:   dotnet run --project tests/invite-email
///          INVITE_PREVIEW_DIR=<dir> dotnet run --project tests/invite-email
///            also writes both emails as .html so a person can LOOK at them.
///            Assertions prove the parts are there; only eyes prove it looks right.
/// Exit:    0 = all assertions passed, 1 = at least one failed.
/// </summary>
internal static class Program
{
    private static int passed, failed;

    private static void Ok(string what, bool ok)
    {
        if (ok) { passed++; Console.WriteLine($"    ok  {what}"); }
        else { failed++; Console.WriteLine($"  FAIL  {what}"); }
    }

    private const string Base = "https://core.tatvaos.com";
    private const string Link = "https://core.tatvaos.com/welcome#t=TOKEN";

    private static int Main()
    {
        var invite = TatvaOS.Api.Shared.Notify.InviteEmail.Html("Ravi Kumar", "Techvein", Base, "ravi@techvein.in", Link, 72);
        var signin = TatvaOS.Api.Shared.Notify.InviteEmail.Html("Amit Dadhich", "Techvein", Base, "amit@techvein.in", Link, 24, signInLink: true);

        Console.WriteLine();
        Console.WriteLine("  InviteEmail — a welcome, the reason, the button, the apps");
        Console.WriteLine("  =============================================================");

        Console.WriteLine();
        Console.WriteLine("  A new person's invitation");
        Ok("headline welcomes them to TatvaOS, by first name", invite.Contains("Welcome to TatvaOS, Ravi."));
        Ok("the welcome sentence comes first", invite.Contains("We are glad to have you."));
        Ok("then the reason: their organisation created the account", invite.Contains("has created your TatvaOS account."));
        Ok("welcome is BEFORE the reason", invite.IndexOf("We are glad to have you.", StringComparison.Ordinal) < invite.IndexOf("has created your TatvaOS account.", StringComparison.Ordinal));

        Console.WriteLine();
        Console.WriteLine("  A sign-in link for somebody who already uses TatvaOS");
        Ok("headline welcomes them BACK, not to TatvaOS", signin.Contains("Welcome back, Amit.") && !signin.Contains("Welcome to TatvaOS,"));
        Ok("it never says their account was created", !signin.Contains("has created your TatvaOS account"));
        Ok("the reason is still there: their administrator sent it", signin.Contains("sent you this link so you can choose a new password"));
        Ok("and the safety line: if you did not expect this, tell your administrator", signin.Contains("If you did not expect this, ignore it and tell your administrator."));
        Ok("and that the current password keeps working", signin.Contains("Your current password keeps working until you use it."));

        foreach (var (label, html) in new[] { ("invitation", invite), ("sign-in link", signin) })
        {
            Console.WriteLine();
            Console.WriteLine($"  The apps, in the {label}");
            var button = html.IndexOf("Set your password\r", StringComparison.Ordinal) is var i1 and >= 0 ? i1
                       : html.IndexOf("Set your password\n", StringComparison.Ordinal);
            var row = html.IndexOf("One sign-in, every app", StringComparison.Ordinal);
            Ok("a heading for the row exists", row > 0);
            Ok("and it sits BELOW the button", button > 0 && row > button);
            foreach (var (slug, name) in new[] { ("mail", "Mail"), ("connect", "Connect"), ("calendar", "Calendar"), ("space", "Space") })
            {
                Ok($"{name}: its logo from {Base}/brand/{slug}-logo.png, with alt text",
                    html.Contains($"src=\"{Base}/brand/{slug}-logo.png\"") && html.Contains($"alt=\"{name}\""));
                Ok($"{name}: its name as TEXT (survives blocked images)",
                    html.Contains($">{name}</div>"));
            }
            Ok("exactly four apps, no more", CountOf(html, "/brand/") - CountOf(html, "/brand/core-logo.png") == 4);
            // Button href, fallback href, fallback visible text.
            Ok("the one-time link is still in the button and the fallback", CountOf(html, Link) == 3);
        }

        Console.WriteLine();
        Console.WriteLine("  Never in either");
        Ok("no password appears", !invite.Contains("password:", StringComparison.OrdinalIgnoreCase) && !signin.Contains("password:", StringComparison.OrdinalIgnoreCase));
        Ok("no unfilled template hole", !invite.Contains("{") && !signin.Contains("{"));

        if (Environment.GetEnvironmentVariable("INVITE_PREVIEW_DIR") is { Length: > 0 } dir)
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "1-invitation-new-person.html"), invite);
            File.WriteAllText(Path.Combine(dir, "2-sign-in-link.html"), signin);
            Console.WriteLine();
            Console.WriteLine($"  preview written to {dir}");
        }

        Console.WriteLine();
        Console.WriteLine("  =============================================================");
        Console.WriteLine(failed == 0 ? $"  PASS  {passed} assertions" : $"  FAIL  {failed} of {passed + failed} assertions");
        Console.WriteLine();
        return failed == 0 ? 0 : 1;
    }

    private static int CountOf(string s, string what)
    {
        var n = 0;
        for (var i = s.IndexOf(what, StringComparison.Ordinal); i >= 0; i = s.IndexOf(what, i + what.Length, StringComparison.Ordinal)) n++;
        return n;
    }
}

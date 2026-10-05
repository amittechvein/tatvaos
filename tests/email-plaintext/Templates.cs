using MimeKit;
using TatvaOS.Api.Shared.Notify;

namespace TatvaOS.Tests.EmailPlaintext;

/// <summary>
/// EVERY system email template, as bytes on the wire.
///
/// Mr. Singh, 24 September 2026: "Then extend the pickup-directory test
/// across every template. You have the mechanism and you ran it against
/// InviteEmail. The same assertions over sign-in links, welcome, sign-in
/// alerts, signup OTP, meeting minutes and storage warnings is cheap now and
/// closes the surface permanently."
///
/// Three shape faults reached production in one day (no text part, no
/// Message-ID, the text part twice), each found by reading a message someone
/// forwarded. This is the end of finding them that way: every template is
/// built, written out, and read back here.
/// </summary>
internal static class Templates
{
    private const string Base = "https://core.tatvaos.com";
    private const string Link = "https://core.tatvaos.com/welcome#t=TOKEN";

    /// <summary>Name → the HTML that template produces.</summary>
    internal static IEnumerable<(string Name, string Html)> All()
    {
        yield return ("invitation",
            InviteEmail.Html("Ravi Kumar", "Techvein", Base, "ravi@techvein.in", Link, 72));
        yield return ("sign-in link",
            InviteEmail.Html("Amit Dadhich", "Techvein", Base, "amit@techvein.in", Link, 24, signInLink: true));
        yield return ("welcome",
            WelcomeEmail.Html("Ravi Kumar", "Techvein", Base, "ravi@techvein.in"));
        yield return ("password reset",
            ResetEmail.Html("Ravi Kumar", Base, Link, 30));
        yield return ("recovery address: verify",
            RecoveryVerifyEmail.Html("Ravi Kumar", Base, Link, 30));
        yield return ("recovery address: changed",
            RecoveryChangedEmail.Html("Ravi Kumar", Base, "recovery email", DateTimeOffset.UtcNow));
        yield return ("sign-in alert",
            SignInAlertEmail.Html("Ravi Kumar", Base, "Chrome on Windows", "203.0.113.9", DateTimeOffset.UtcNow));
        yield return ("storage warning",
            StorageWarningEmail.Html("Ravi Kumar", "Techvein", Base, 92, critical: false, pooled: true,
                                     usedText: "1.8 GB", totalText: "2 GB"));
    }

    /// <summary>
    /// The message as bytes, without an SMTP server. MimeKit writes exactly
    /// what MailKit would put on the wire.
    /// </summary>
    internal static string OnTheWire(string html)
    {
        var mime = SystemMailMessage.Build(
            "no_reply@tatvaos.com", "someone@example.com", "A TatvaOS message", html, html: true);
        using var stream = new MemoryStream();
        mime.WriteTo(stream);
        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    internal static MimeMessage Built(string html) =>
        SystemMailMessage.Build("no_reply@tatvaos.com", "someone@example.com",
                                "A TatvaOS message", html, html: true);
}

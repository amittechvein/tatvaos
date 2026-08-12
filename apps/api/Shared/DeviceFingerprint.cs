using System.Security.Cryptography;
using System.Text;

namespace TatvaOS.Api.Shared;

/// <summary>
/// Turns a user-agent string into (a) a stable key for "is this the same
/// device as last time?" and (b) a phrase a human can recognise, like
/// "Chrome on Windows".
///
/// ─────────────────────────────────────────────────────────────────────────
///  DELIBERATELY CRUDE, AND THAT IS THE POINT.
///
///  Full user-agent parsing is a losing game — the strings are a museum of
///  browser-war lies (every browser claims to be Mozilla; Edge claims to be
///  Chrome; Chrome claims to be Safari) and the libraries that keep up with
///  them need monthly data updates.
///
///  Neither job here needs that precision. The KEY only has to be stable for
///  one person's browser over time and different between browsers — it is
///  compared, never interpreted. The LABEL only has to let someone think
///  "yes, that is my work laptop" — being wrong about Chromium-vs-Brave costs
///  nothing, and both still read as a browser on the right operating system.
///
///  So: match the specific before the generic (Edge before Chrome, Chrome
///  before Safari), and fall back to honest vagueness rather than a wrong
///  guess.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class DeviceFingerprint
{
    /// <summary>
    /// SHA-256 hex over the DESCRIPTION, not the raw user agent.
    ///
    /// Hashing the raw string would make the key change on every browser
    /// point release — Chrome ships one every few weeks — and each of those
    /// would look like a brand-new device and send an alert. Hashing the
    /// description ("Chrome on Windows") means the key survives updates and
    /// changes only when the person genuinely moves to another browser, OS or
    /// machine class, which is the event actually worth an email.
    /// </summary>
    public static string Key(string? userAgent) =>
        Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(Describe(userAgent))))
            .ToLowerInvariant();

    /// <summary>A phrase for the alert email: "Chrome on Windows".</summary>
    public static string Describe(string? userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent)) return "An unrecognised device";

        var ua = userAgent;
        var browser = Browser(ua);
        var os = OperatingSystem(ua);

        return (browser, os) switch
        {
            (null, null) => "An unrecognised device",
            (not null, null) => browser!,
            (null, not null) => $"An unrecognised browser on {os}",
            _ => $"{browser} on {os}",
        };
    }

    // Order matters throughout: every one of these strings appears in agents
    // for OTHER browsers, so the most specific claim has to be tested first.
    private static string? Browser(string ua)
    {
        if (Has(ua, "Edg/") || Has(ua, "Edge/")) return "Microsoft Edge";
        if (Has(ua, "OPR/") || Has(ua, "Opera")) return "Opera";
        if (Has(ua, "Brave")) return "Brave";
        if (Has(ua, "SamsungBrowser")) return "Samsung Internet";
        if (Has(ua, "Firefox/") || Has(ua, "FxiOS")) return "Firefox";
        // Chrome must precede Safari: every Chrome agent also says "Safari".
        if (Has(ua, "Chrome/") || Has(ua, "CriOS") || Has(ua, "Chromium")) return "Chrome";
        if (Has(ua, "Safari/")) return "Safari";

        // Not a browser at all — a mail client fetching over IMAP, or one of
        // our own mobile apps. Saying so is more useful than guessing.
        if (Has(ua, "Thunderbird")) return "Thunderbird";
        if (Has(ua, "Outlook")) return "Outlook";
        if (Has(ua, "TatvaOS")) return "the TatvaOS app";
        return null;
    }

    private static string? OperatingSystem(string ua)
    {
        // Android before Linux: every Android agent also says "Linux".
        if (Has(ua, "Android")) return "Android";
        if (Has(ua, "iPhone")) return "iPhone";
        if (Has(ua, "iPad")) return "iPad";
        if (Has(ua, "Windows")) return "Windows";
        // "Mac OS X" appears in iOS agents too, so it comes after iPhone/iPad.
        if (Has(ua, "Macintosh") || Has(ua, "Mac OS")) return "macOS";
        if (Has(ua, "CrOS")) return "ChromeOS";
        if (Has(ua, "Linux") || Has(ua, "X11")) return "Linux";
        return null;
    }

    private static bool Has(string haystack, string needle) =>
        haystack.Contains(needle, StringComparison.OrdinalIgnoreCase);
}

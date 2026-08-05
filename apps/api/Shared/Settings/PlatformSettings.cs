using Microsoft.EntityFrameworkCore;
using TatvaOS.Api.Shared.Data;

namespace TatvaOS.Api.Shared.Settings;

/// <summary>
/// The registry of every setting the platform knows.
///
/// Defined in code, not discovered from the database, so the settings screen
/// and the services that read them can never disagree about what exists —
/// and a typo in a key is a compile-time member, not a silent default.
/// </summary>
public static class SettingKeys
{
    // SMS — Infobip primary (Techvein already holds an account and a
    // DLT-registered template), MSG91 fields stored for later.
    public const string InfobipBaseUrl = "sms.infobip.base_url";
    public const string InfobipUsername = "sms.infobip.username";
    public const string InfobipPassword = "sms.infobip.password";
    public const string InfobipSenderId = "sms.infobip.sender_id";
    public const string Msg91AuthKey = "sms.msg91.auth_key";
    public const string Msg91SenderId = "sms.msg91.sender_id";
    public const string OtpTemplate = "sms.otp_template";
    public const string CountryPrefix = "sms.country_prefix";
    public const string ShowOtpOnScreen = "sms.show_otp_on_screen";

    // SSO
    public const string GoogleClientId = "sso.google.client_id";
    public const string GoogleClientSecret = "sso.google.client_secret";

    // Billing
    public const string RazorpayKeyId = "billing.razorpay.key_id";
    public const string RazorpayKeySecret = "billing.razorpay.key_secret";

    // Mail identity
    public const string SmtpFrom = "mail.smtp_from";

    public sealed record Def(string Key, string Section, string Label, bool Secret, string Help);

    /// <summary>What the settings screen renders, in order.</summary>
    public static readonly IReadOnlyList<Def> All =
    [
        new(InfobipBaseUrl, "sms", "Infobip base URL", false,
            "Usually https://api.infobip.com, or the regional URL from your Infobip dashboard."),
        new(InfobipUsername, "sms", "Infobip username", false,
            "SMS sends through Infobip once username and password are both set."),
        new(InfobipPassword, "sms", "Infobip password", true, ""),
        new(InfobipSenderId, "sms", "Sender ID", false,
            "The DLT-registered header, e.g. TCVEIN."),
        new(CountryPrefix, "sms", "Country code prefix", false,
            "Prepended to 10-digit numbers. 91 for India."),
        new(OtpTemplate, "sms", "OTP SMS template (DLT)", false,
            "Must match your DLT-registered template exactly — {{otp}} is replaced with the code. A mismatch is silently dropped by the carrier, not bounced."),
        new(Msg91AuthKey, "sms", "MSG91 auth key (alternative)", true,
            "Stored for later. Sending via MSG91 is not implemented yet — Infobip is."),
        new(Msg91SenderId, "sms", "MSG91 sender ID", false, ""),
        new(ShowOtpOnScreen, "sms", "Show OTP on screen (testing mode)", false,
            "ON shows signup codes in the browser so the flow works before SMS is configured. Turn OFF before going live — with it on, the phone check proves nothing."),

        new(GoogleClientId, "sso", "Google OAuth client ID", false,
            "From console.cloud.google.com → Credentials. The sign-in flow itself ships next; the credentials are stored and ready."),
        new(GoogleClientSecret, "sso", "Google OAuth client secret", true, ""),

        new(RazorpayKeyId, "billing", "Razorpay key ID", false,
            "Checkout integration ships with the billing section; keys stored and ready."),
        new(RazorpayKeySecret, "billing", "Razorpay key secret", true, ""),

        new(SmtpFrom, "mail", "System mail from-address", false,
            "OTP codes and invoices are sent as this address, through our own mail server on the tatvaos.com domain."),
    ];

    public static bool IsKnown(string key) => All.Any(d => d.Key == key);
    public static bool IsSecret(string key) => All.FirstOrDefault(d => d.Key == key)?.Secret ?? true;
}

/// <summary>
/// Reads settings. Scoped — one DbContext trip per request that needs them,
/// which at signup volume is nothing, and it means a saved change takes effect
/// on the very next request with no cache to invalidate and no restart.
/// </summary>
public sealed class SettingsReader(AppDbContext db)
{
    public async Task<Dictionary<string, string>> GetAsync(CancellationToken ct = default) =>
        await db.PlatformSettings.AsNoTracking()
            .ToDictionaryAsync(s => s.Key, s => s.Value, ct);

    public async Task<string?> GetAsync(string key, CancellationToken ct = default) =>
        await db.PlatformSettings.AsNoTracking()
            .Where(s => s.Key == key)
            .Select(s => s.Value)
            .FirstOrDefaultAsync(ct);

    public async Task<bool> FlagAsync(string key, bool fallback = false, CancellationToken ct = default)
    {
        var v = await GetAsync(key, ct);
        return v is null ? fallback : string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
    }
}

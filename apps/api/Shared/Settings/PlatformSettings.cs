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
    // SMS — both providers implemented; sms.provider picks the primary.
    public const string SmsProvider = "sms.provider";
    public const string InfobipBaseUrl = "sms.infobip.base_url";
    public const string InfobipUsername = "sms.infobip.username";
    public const string InfobipPassword = "sms.infobip.password";
    public const string InfobipSenderId = "sms.infobip.sender_id";
    public const string Msg91AuthKey = "sms.msg91.auth_key";
    public const string Msg91SenderId = "sms.msg91.sender_id";
    public const string Msg91DltTemplateId = "sms.msg91.dlt_template_id";
    public const string OtpTemplate = "sms.otp_template";
    public const string CountryPrefix = "sms.country_prefix";
    public const string ShowOtpOnScreen = "sms.show_otp_on_screen";

    // SSO
    public const string GoogleClientId = "sso.google.client_id";
    public const string GoogleClientSecret = "sso.google.client_secret";

    // Billing
    public const string RazorpayKeyId = "billing.razorpay.key_id";
    public const string RazorpayKeySecret = "billing.razorpay.key_secret";

    // Techvein as the SELLER on every GST invoice (billing part 1, 26 Sept
    // 2026). No invoice is issued until the legal name, GSTIN, address,
    // state code and SAC are all set: an invoice without them is not a
    // valid tax invoice, and it cannot be edited after it is sent.
    public const string SellerLegalName = "billing.seller.legal_name";
    public const string SellerGstin = "billing.seller.gstin";
    public const string SellerAddress = "billing.seller.address";
    public const string SellerStateCode = "billing.seller.state_code";
    public const string SellerSac = "billing.seller.sac";
    public const string InvoicePrefix = "billing.invoice_prefix";
    public const string PaymentTermsDays = "billing.payment_terms_days";
    // Payment is online only, through Razorpay (Amit, 26 Sept 2026). The
    // webhook secret is the one set on the Razorpay dashboard's webhook for
    // https://core.tatvaos.com/api/billing/razorpay/webhook.
    public const string RazorpayWebhookSecret = "billing.razorpay.webhook_secret";

    // Mail identity
    public const string SmtpFrom = "mail.smtp_from";

    // AI — the operator's controls over spend (MeteredAiGateway). Mr. Singh,
    // 24 Sept 2026: metering first, then limits, and "one lever that stops
    // all spend, not a tour of per-organisation toggles".
    public const string AiPaused = "ai.paused";
    public const string AiPerPersonPerHour = "ai.limit.per_person_per_hour";
    public const string AiOrgMonthlyTokens = "ai.limit.org_monthly_tokens";
    // Which organisations may use TatvaOS AI in Mail at all (AiProductSwitch).
    public const string AiMailOrganisations = "ai.mail.organisations";
    // …and for each other AI product (AiGate, 30 Sept 2026). Same rule:
    // empty = nobody, "all" = everyone, ids = only those.
    public const string AiConnectOrganisations = "ai.connect.organisations";
    public const string AiDocsOrganisations = "ai.docs.organisations";

    // Personal accounts (/join) — build plan personal-plans-build-plan.md §1
    // and §3.4. Closed by default: the switch-on waits for the five launch
    // gates, and a deploy must never open it.
    public const string PersonalSignupOpen = "personal.signup_open";
    public const string PersonalCodesPerHour = "personal.signup_codes_per_hour";
    // Amit, 26 Sept 2026: at a plan limit, warn first. The operator always
    // sees the warnings; this decides whether the organisation's own
    // administrators see them too. OFF until the wording is approved.
    public const string PlansWarnClients = "plans.warn_clients";

    public sealed record Def(string Key, string Section, string Label, bool Secret, string Help);

    /// <summary>What the settings screen renders, in order.</summary>
    public static readonly IReadOnlyList<Def> All =
    [
        new(SmsProvider, "sms", "Primary SMS provider", false,
            "Which provider sends OTPs. Auto prefers Infobip when its credentials are set, "
            + "otherwise MSG91. Choosing one explicitly makes failures loud: if its "
            + "credentials are missing, sends fail instead of quietly using the other."),
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
        new(Msg91AuthKey, "sms", "MSG91 auth key", true,
            "Used when MSG91 is the primary provider, or as the automatic fallback."),
        new(Msg91SenderId, "sms", "MSG91 sender ID", false,
            "The DLT-registered header for MSG91, e.g. TCVEIN. Falls back to the Infobip sender ID if empty."),
        new(Msg91DltTemplateId, "sms", "MSG91 DLT template ID", false,
            "The DLT_TE_ID from your MSG91 dashboard for the OTP template. MSG91 routes "
            + "the message under this registration; without it carriers may drop silently."),
        new(ShowOtpOnScreen, "sms", "Show OTP on screen (testing mode)", false,
            "ON shows signup codes in the browser so the flow works before SMS is configured. Turn OFF before going live — with it on, the phone check proves nothing."),

        new(GoogleClientId, "sso", "Google OAuth client ID", false,
            "From console.cloud.google.com → Credentials. The sign-in flow itself ships next; the credentials are stored and ready."),
        new(GoogleClientSecret, "sso", "Google OAuth client secret", true, ""),

        new(RazorpayKeyId, "billing", "Razorpay key ID", false,
            "Checkout integration ships with the billing section; keys stored and ready."),
        new(RazorpayKeySecret, "billing", "Razorpay key secret", true, ""),
        new(SellerLegalName, "billing", "Seller: legal name", false,
            "Printed on every invoice as the seller, e.g. Techvein IT Solutions Pvt. Ltd."),
        new(SellerGstin, "billing", "Seller: GSTIN", false,
            "Techvein's 15-character GSTIN. No invoice can be issued until this is set."),
        new(SellerAddress, "billing", "Seller: registered address", false,
            "The address on the GST registration."),
        new(SellerStateCode, "billing", "Seller: GST state code", false,
            "Two digits, the first two of the GSTIN (e.g. 10 Bihar, 27 Maharashtra). A customer in the "
            + "same state is charged CGST 9% + SGST 9%; anywhere else IGST 18%."),
        new(SellerSac, "billing", "SAC code for the service", false,
            "The GST service code printed on each invoice line. Confirm with your accountant."),
        new(InvoicePrefix, "billing", "Invoice number prefix", false,
            "1-3 capital letters. Invoices are numbered PREFIX/2026-27/0001, starting again each April. "
            + "GST allows 16 characters in an invoice number, which is why the prefix is short."),
        new(PaymentTermsDays, "billing", "Days to pay", false,
            "Due date = issue date + this many days. Empty means 15."),
        new(RazorpayWebhookSecret, "billing", "Razorpay webhook secret", true,
            "Create a webhook in the Razorpay dashboard for https://core.tatvaos.com/api/billing/razorpay/webhook "
            + "with the event payment_link.paid, and paste the secret you chose there. Without it, payments are "
            + "still recorded when the customer returns to TatvaOS, but not if they close the page first."),

        new(SmtpFrom, "mail", "System mail from-address", false,
            "OTP codes and invoices are sent as this address, through our own mail server on the tatvaos.com domain."),

        new(AiPaused, "ai", "Pause all AI (every organisation)", false,
            "The emergency stop. ON refuses every AI request on the platform at once, with a message "
            + "saying AI is paused. Use it if spend runs away; nothing else changes."),
        new(AiPerPersonPerHour, "ai", "AI requests per person per hour", false,
            "Started at 50: high enough that nobody working normally meets it, low enough to stop a "
            + "runaway loop. 0 allows NONE. Empty means NO LIMIT."),
        new(AiOrgMonthlyTokens, "ai", "AI tokens per organisation per month", false,
            "Started at 2,000,000. Administrators are emailed at 80% and at 100%; at 100% AI stops for "
            + "that organisation until the month turns (India time). 0 allows NONE — AI stopped. "
            + "Empty means NO CEILING."),
        new(AiMailOrganisations, "ai", "Organisations that may use TatvaOS AI in Mail", false,
            "Organisation ids, separated by commas. Only these can switch Mail AI on (Help me write, "
            + "suggested replies, sorting); every other organisation is told it is not available yet. "
            + "EMPTY means NO organisation may (Mr. Singh, 29 Sept 2026). Type all to let every "
            + "organisation. Set to Techvein alone on 25 Sept 2026 until the privacy policy describes "
            + "Mail AI (Mr. Singh) — change it to all once that text is live."),
        new(AiConnectOrganisations, "ai", "Organisations that may use TatvaOS AI in Connect", false,
            "Meeting minutes, and transcription of recordings if a transcription service is ever set up. "
            + "Same rule as Mail: organisation ids separated by commas, all for everyone, EMPTY means NO "
            + "organisation. Started as all on 30 Sept 2026 (Mr. Singh): minutes' disclosure is live, and "
            + "each organisation's own TatvaOS AI switch remains its consent."),
        new(AiDocsOrganisations, "ai", "Organisations that may use TatvaOS AI in Docs", false,
            "Same rule as Mail. Started EMPTY on 30 Sept 2026 (no organisation): Docs is off for everyone "
            + "and its AI has no privacy text yet."),

        new(PersonalSignupOpen, "personal", "Personal signup open (/join)", false,
            "OFF until launch. ON lets anyone create a free personal address at /join. Needs a personal "
            + "house organisation with a verified domain and the phone-hash key as well, or /join stays "
            + "closed whatever this says."),
        new(PersonalCodesPerHour, "personal", "Signup SMS codes per hour (whole platform)", false,
            "A ceiling on SMS codes sent by /join across everyone, so the form cannot run up an SMS bill. "
            + "Empty means 200. Per number (3 an hour) and per address (10 an hour) are fixed in code."),
        new(PlansWarnClients, "plans", "Show plan warnings to organisation administrators", false,
            "true shows each organisation's administrators a notice when they use something their plan "
            + "does not include, or pass a plan limit. Nothing is ever stopped. You always see the "
            + "warnings on the organisation's page, whatever this says."),
    ];

    public static bool IsKnown(string key) => All.Any(d => d.Key == key);
    public static bool IsSecret(string key) => All.FirstOrDefault(d => d.Key == key)?.Secret ?? true;
}

/// <summary>
/// Reads settings. Scoped — one DbContext trip per request that needs them,
/// which at signup volume is nothing, and it means a saved change takes effect
/// on the very next request with no cache to invalidate and no restart.
/// </summary>
/// Secret values are stored encrypted (SettingsCrypto) and decrypted here, so
/// every caller keeps seeing the plain value it always saw. Without a crypto
/// instance (one caller builds the reader by hand for non-secret keys) an
/// encrypted value reads as not set, never as its ciphertext.
public sealed class SettingsReader(AppDbContext db, SettingsCrypto? crypto = null)
{
    private string? Plain(string stored) =>
        crypto is not null ? crypto.Open(stored)
        : stored.StartsWith(SettingsCrypto.Prefix, StringComparison.Ordinal) ? null : stored;

    public async Task<Dictionary<string, string>> GetAsync(CancellationToken ct = default)
    {
        var rows = await db.PlatformSettings.AsNoTracking().ToListAsync(ct);
        var result = new Dictionary<string, string>();
        foreach (var r in rows)
            if (Plain(r.Value) is string v) result[r.Key] = v;
        return result;
    }

    public async Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        var stored = await db.PlatformSettings.AsNoTracking()
            .Where(s => s.Key == key)
            .Select(s => s.Value)
            .FirstOrDefaultAsync(ct);
        return stored is null ? null : Plain(stored);
    }

    public async Task<bool> FlagAsync(string key, bool fallback = false, CancellationToken ct = default)
    {
        var v = await GetAsync(key, ct);
        return v is null ? fallback : string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
    }
}

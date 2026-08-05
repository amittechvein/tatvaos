using System.Net.Http.Headers;
using System.Net.Mail;
using System.Text;
using System.Text.Json;
using TatvaOS.Api.Shared.Settings;

namespace TatvaOS.Api.Shared.Notify;

/// <summary>
/// System email — OTPs, and later invoices and alerts.
///
/// Sends through our own Postfix submission port, which means containment
/// comes free: on testing, Postfix relays everything to Mailpit, so a signup
/// tested on staging shows its code at mail-catcher.staging.tatvaos.com
/// instead of emailing a stranger. In production the same path reaches real
/// inboxes — once Linode lifts the outbound block.
///
/// The from-address comes from platform settings, so changing the sending
/// identity is a console action, not a deploy.
/// </summary>
public sealed class SystemMailer(
    IConfiguration config, SettingsReader settings, ILogger<SystemMailer> log)
{
    public async Task<bool> SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        var host = config["Smtp:Host"] ?? "postfix";
        var port = int.TryParse(config["Smtp:Port"], out var p) ? p : 587;
        var from = await settings.GetAsync(SettingKeys.SmtpFrom, ct)
                   ?? config["Smtp:From"] ?? "no-reply@tatvaos.com";

        try
        {
            using var client = new SmtpClient(host, port);
            using var msg = new MailMessage(from, to, subject, body);
            await client.SendMailAsync(msg, ct);
            return true;
        }
        catch (Exception ex)
        {
            // A failed send must not 500 the signup — the UI offers resend, and
            // in bare local development there is no SMTP server at all.
            log.LogWarning(ex, "System mail to {To} failed", to);
            return false;
        }
    }
}

/// <summary>
/// One method, deliberately OTP-shaped rather than free-text.
///
/// Indian DLT rules mean the message body must match a registered template —
/// a sender that accepted arbitrary text would let any future caller compose
/// an SMS the carrier silently drops. The template lives in settings and the
/// sender applies it; callers supply only the code.
/// </summary>
public interface ISmsSender
{
    Task<SmsResult> SendOtpAsync(string phone, string code, CancellationToken ct = default);
}

public sealed record SmsResult(bool Sent, string Provider, string? Detail = null);

/// <summary>
/// Chooses a provider from platform settings at send time.
///
/// Infobip when username and password are set — Techvein already holds an
/// account and a DLT-registered template. Falls back to logging the code when
/// nothing is configured, so the flow stays testable; the signup endpoint
/// pairs that with the show-OTP-on-screen setting.
/// </summary>
public sealed class SmsSender(
    SettingsReader settings, IHttpClientFactory httpFactory, ILogger<SmsSender> log) : ISmsSender
{
    public async Task<SmsResult> SendOtpAsync(string phone, string code, CancellationToken ct = default)
    {
        var s = await settings.GetAsync(ct);

        var template = s.GetValueOrDefault(SettingKeys.OtpTemplate,
            "Your TatvaOS verification code is {{otp}}. It expires in 10 minutes.");
        var text = template.Replace("{{otp}}", code, StringComparison.OrdinalIgnoreCase);

        var to = Normalise(phone, s.GetValueOrDefault(SettingKeys.CountryPrefix, "91"));

        var user = s.GetValueOrDefault(SettingKeys.InfobipUsername, "");
        var pass = s.GetValueOrDefault(SettingKeys.InfobipPassword, "");

        if (!string.IsNullOrWhiteSpace(user) && !string.IsNullOrWhiteSpace(pass))
            return await SendInfobipAsync(s, user, pass, to, text, ct);

        // No provider configured. Logged, not pretended — the endpoint decides
        // whether to surface the code on screen instead.
        log.LogWarning("SMS not configured; OTP for {Phone} not sent", to);
        return new SmsResult(false, "none", "No SMS provider is configured.");
    }

    private async Task<SmsResult> SendInfobipAsync(
        Dictionary<string, string> s, string user, string pass,
        string to, string text, CancellationToken ct)
    {
        var baseUrl = s.GetValueOrDefault(SettingKeys.InfobipBaseUrl, "https://api.infobip.com")
            .TrimEnd('/');
        var sender = s.GetValueOrDefault(SettingKeys.InfobipSenderId, "TATVAOS");

        try
        {
            var client = httpFactory.CreateClient("infobip");
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/sms/2/text/advanced");
            req.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{user}:{pass}")));
            req.Content = new StringContent(JsonSerializer.Serialize(new
            {
                messages = new[]
                {
                    new { destinations = new[] { new { to } }, from = sender, text },
                },
            }), Encoding.UTF8, "application/json");

            using var res = await client.SendAsync(req, ct);
            var body = await res.Content.ReadAsStringAsync(ct);

            if (res.IsSuccessStatusCode)
                return new SmsResult(true, "infobip");

            // Infobip's error body names the actual problem — wrong sender ID,
            // template mismatch, out of credit. Surfacing it verbatim on the
            // test button is the difference between fixing it in a minute and
            // guessing for an hour.
            log.LogWarning("Infobip rejected send to {To}: {Status} {Body}", to, (int)res.StatusCode, body);
            return new SmsResult(false, "infobip", $"Infobip returned {(int)res.StatusCode}: {Truncate(body)}");
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Infobip send to {To} failed", to);
            return new SmsResult(false, "infobip", ex.Message);
        }
    }

    /// <summary>10-digit numbers get the prefix; anything longer is assumed
    /// already international. Infobip wants no leading plus.</summary>
    private static string Normalise(string phone, string prefix)
    {
        var digits = new string(phone.Where(char.IsDigit).ToArray());
        return digits.Length == 10 ? $"{prefix}{digits}" : digits;
    }

    private static string Truncate(string s) => s.Length <= 300 ? s : s[..300];
}

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
    /// <summary>Plain-text system mail (OTPs and the like).</summary>
    public Task<bool> SendAsync(string to, string subject, string body, CancellationToken ct = default)
        => SendCoreAsync(to, subject, body, html: false, from: null, ct);

    /// <summary>
    /// HTML system mail — the welcome email and future branded notices. A
    /// <paramref name="from"/> override lets a specific message pin its sender
    /// (the welcome is always no_reply@tatvaos.com) without changing the
    /// platform default used by everything else.
    /// </summary>
    /// <param name="unsubscribe">
    /// A mailbox or page where this KIND of message can be turned off, for the
    /// List-Unsubscribe header. Null for mail that cannot be turned off —
    /// a password reset, an invitation, a security alert. Offering to
    /// unsubscribe from those would be a lie, and worse, a way to switch off
    /// the warning that someone signed in.
    /// </param>
    public Task<bool> SendHtmlAsync(
        string to, string subject, string htmlBody, string? from = null,
        CancellationToken ct = default, string? unsubscribe = null)
        => SendCoreAsync(to, subject, htmlBody, html: true, from, ct, unsubscribe);

    private async Task<bool> SendCoreAsync(
        string to, string subject, string body, bool html, string? from, CancellationToken ct,
        string? unsubscribe = null)
    {
        var host = config["Smtp:Host"] ?? "postfix";
        var port = int.TryParse(config["Smtp:Port"], out var p) ? p : 587;
        var sender = from
                     ?? await settings.GetAsync(SettingKeys.SmtpFrom, ct)
                     ?? config["Smtp:From"] ?? "no-reply@tatvaos.com";

        try
        {
            using var client = new SmtpClient(host, port);
            using var msg = new MailMessage(sender, to) { Subject = subject };

            // ── BOTH PARTS, ALWAYS ──────────────────────────────────────────
            //
            //  Until 24 September 2026 this sent `IsBodyHtml = true` and
            //  nothing else. Amit reported TatvaOS mail arriving in Gmail's
            //  spam folder; Gmail's own headers on the message said dkim=pass,
            //  spf=pass, dmarc=pass — the authentication was perfect, and the
            //  MESSAGE was the problem. HTML with no text/plain alternative is
            //  a long-standing spam signal, and it is worse mail besides: a
            //  text-only client, a watch or a screen reader had nothing.
            //
            //  The text is derived from the HTML (HtmlToText), so it cannot
            //  drift out of date the way a hand-written second copy would.
            if (html)
            {
                var text = HtmlToText.Convert(body);
                msg.Body = text;
                msg.IsBodyHtml = false;
                msg.AlternateViews.Add(
                    AlternateView.CreateAlternateViewFromString(text, Encoding.UTF8, "text/plain"));
                msg.AlternateViews.Add(
                    AlternateView.CreateAlternateViewFromString(body, Encoding.UTF8, "text/html"));
            }
            else
            {
                msg.Body = body;
                msg.IsBodyHtml = false;
            }

            // RFC 3834: this is a machine writing, so an out-of-office must not
            // answer it and a mail loop cannot start.
            msg.Headers.Add("Auto-Submitted", "auto-generated");

            // Only when there is somewhere real to go. See the parameter.
            if (!string.IsNullOrWhiteSpace(unsubscribe))
            {
                msg.Headers.Add("List-Unsubscribe", unsubscribe.StartsWith('<') ? unsubscribe : $"<{unsubscribe}>");
                if (unsubscribe.Contains("http", StringComparison.OrdinalIgnoreCase))
                    msg.Headers.Add("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
            }

            await client.SendMailAsync(msg, ct);
            return true;
        }
        catch (Exception ex)
        {
            // A failed send must not 500 the caller — the flows that use this
            // (signup OTP, welcome mail) all treat mail as best-effort, and in
            // bare local development there is no SMTP server at all.
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
        var msg91Key = s.GetValueOrDefault(SettingKeys.Msg91AuthKey, "");

        var hasInfobip = !string.IsNullOrWhiteSpace(user) && !string.IsNullOrWhiteSpace(pass);
        var hasMsg91 = !string.IsNullOrWhiteSpace(msg91Key);

        // An EXPLICIT choice fails loudly when its credentials are missing,
        // rather than quietly using the other provider. An admin who picked
        // MSG91 and sees "sent via infobip" on the test button has been lied
        // to about which account is being billed and which template applies.
        switch (s.GetValueOrDefault(SettingKeys.SmsProvider, "auto").Trim().ToLowerInvariant())
        {
            case "infobip":
                return hasInfobip
                    ? await SendInfobipAsync(s, user, pass, to, text, ct)
                    : new SmsResult(false, "infobip",
                        "Infobip is the primary provider but its username or password is not set.");
            case "msg91":
                return hasMsg91
                    ? await SendMsg91Async(s, msg91Key, to, text, ct)
                    : new SmsResult(false, "msg91",
                        "MSG91 is the primary provider but its auth key is not set.");
        }

        // Auto: Infobip first (the longer-standing account), MSG91 second.
        if (hasInfobip) return await SendInfobipAsync(s, user, pass, to, text, ct);
        if (hasMsg91) return await SendMsg91Async(s, msg91Key, to, text, ct);

        // No provider configured. Logged, not pretended — the endpoint decides
        // whether to surface the code on screen instead.
        // NEVER the number. Until 21 Sept 2026 every failure path in this class
        // logged it in full. The only numbers reaching it then were our own
        // signed-in users'; the guest door (PR 184) would have sent strangers'
        // through it while telling them "the number itself is not kept". Found
        // while writing an evidence pack, not by a test - tests/notify is the
        // test now. Four digits find the event and identify nobody.
        log.LogWarning("SMS not configured; OTP for {Phone} not sent", Mask.PhoneForLog(to));
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
            // The body is kept - it is the whole point - but the provider echoes
            // the recipient in it, so the number is taken out of it first. The
            // same scrubbed text is what goes back to the caller as Detail:
            // callers log it and one shows it on a screen.
            body = Mask.ScrubPhone(body, to);
            log.LogWarning("Infobip rejected send to {To}: {Status} {Body}", Mask.PhoneForLog(to), (int)res.StatusCode, body);
            return new SmsResult(false, "infobip", $"Infobip returned {(int)res.StatusCode}: {Truncate(body)}");
        }
        catch (Exception ex)
        {
            // Not `ex` as the first argument: that prints the exception's own
            // message and inner messages, which we did not write and cannot vouch
            // for. The type and a scrubbed message are enough to act on.
            var why = Mask.ScrubPhone(ex.Message, to);
            log.LogWarning("Infobip send to {To} failed: {Type} {Why}", Mask.PhoneForLog(to), ex.GetType().Name, why);
            return new SmsResult(false, "infobip", why);
        }
    }

    private async Task<SmsResult> SendMsg91Async(
        Dictionary<string, string> s, string authKey,
        string to, string text, CancellationToken ct)
    {
        // Falls back to the Infobip sender: the DLT header (e.g. TCVEIN) is
        // registered to the COMPANY, not to a provider, so reusing it is
        // usually correct and an empty box should not break sending.
        var sender = s.GetValueOrDefault(SettingKeys.Msg91SenderId, "");
        if (string.IsNullOrWhiteSpace(sender))
            sender = s.GetValueOrDefault(SettingKeys.InfobipSenderId, "TATVAOS");
        var dltId = s.GetValueOrDefault(SettingKeys.Msg91DltTemplateId, "");

        try
        {
            var client = httpFactory.CreateClient("msg91");

            // The sendhttp API, with route=4 (transactional — OTPs must not
            // queue behind promotional traffic) and country=0 because the
            // number is already in full international form from Normalise.
            var query = new List<KeyValuePair<string, string>>
            {
                new("authkey", authKey),
                new("mobiles", to),
                new("message", text),
                new("sender", sender),
                new("route", "4"),
                new("country", "0"),
                new("response", "json"),
            };
            if (!string.IsNullOrWhiteSpace(dltId)) query.Add(new("DLT_TE_ID", dltId));

            var url = "https://control.msg91.com/api/sendhttp.php?" +
                string.Join("&", query.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));

            using var res = await client.GetAsync(url, ct);
            var body = await res.Content.ReadAsStringAsync(ct);

            // MSG91 answers 200 even for failures; the JSON "type" field is
            // the real verdict.
            if (res.IsSuccessStatusCode &&
                body.Contains("\"type\":\"success\"", StringComparison.OrdinalIgnoreCase))
                return new SmsResult(true, "msg91");

            body = Mask.ScrubPhone(body, to);
            log.LogWarning("MSG91 rejected send to {To}: {Status} {Body}", Mask.PhoneForLog(to), (int)res.StatusCode, body);
            return new SmsResult(false, "msg91", $"MSG91 returned {(int)res.StatusCode}: {Truncate(body)}");
        }
        catch (Exception ex)
        {
            // As for Infobip, and with more at stake: this request is a GET whose
            // address carries the auth key, the number AND the code. An exception
            // that quotes the address would put all three in the log.
            var why = Mask.ScrubPhone(ex.Message, to);
            if (why.Contains("authkey", StringComparison.OrdinalIgnoreCase)) why = "request failed (address withheld)";
            log.LogWarning("MSG91 send to {To} failed: {Type} {Why}", Mask.PhoneForLog(to), ex.GetType().Name, why);
            return new SmsResult(false, "msg91", why);
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

using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using TatvaOS.Api.Shared.Settings;

namespace TatvaOS.Api.Modules.Billing;

/// <summary>
/// The two Razorpay calls billing needs: create a Payment Link for an
/// invoice, and read one back. Keys come from Settings → Billing (never from
/// the code or a file). The base address is configurable only so a test can
/// stand in for Razorpay; production uses api.razorpay.com.
///
/// Signatures are checked here too, in constant time:
///   * webhook: HMAC-SHA256 of the raw request body with the WEBHOOK secret
///   * return:  HMAC-SHA256 of "link_id|reference_id|status|payment_id" with
///              the KEY secret (Razorpay's Payment Link callback scheme)
/// </summary>
public sealed class RazorpayClient(HttpClient http, SettingsReader settings, IConfiguration config)
{
    /// <param name="PaymentId">The payment that settled the link, when Razorpay lists one.</param>
    public sealed record Link(string Id, string ShortUrl, string Status, long AmountPaid, string? PaymentId = null);

    public sealed class RazorpayException(string message) : Exception(message);

    private async Task<(string KeyId, string KeySecret)> KeysAsync(CancellationToken ct)
    {
        var id = await settings.GetAsync(SettingKeys.RazorpayKeyId, ct);
        var secret = await settings.GetAsync(SettingKeys.RazorpayKeySecret, ct);
        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(secret))
            throw new RazorpayException("Online payment is not set up yet: the Razorpay keys are missing in Settings → Billing.");
        return (id.Trim(), secret.Trim());
    }

    /// <summary>"test" or "live", from the key id — shown to the operator so a test key in production is visible.</summary>
    public async Task<string?> ModeAsync(CancellationToken ct)
    {
        var id = await settings.GetAsync(SettingKeys.RazorpayKeyId, ct);
        return id is null ? null : id.StartsWith("rzp_live_", StringComparison.Ordinal) ? "live"
             : id.StartsWith("rzp_test_", StringComparison.Ordinal) ? "test" : "unknown";
    }

    private string BaseUrl => (config["Razorpay:BaseUrl"] ?? "https://api.razorpay.com").TrimEnd('/');

    private async Task<HttpRequestMessage> RequestAsync(HttpMethod method, string path, CancellationToken ct)
    {
        var (id, secret) = await KeysAsync(ct);
        var req = new HttpRequestMessage(method, BaseUrl + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes($"{id}:{secret}")));
        return req;
    }

    public async Task<Link> CreateLinkAsync(
        long amountPaise, string reference, string description, string customerName, string customerEmail,
        string callbackUrl, Dictionary<string, string> notes, CancellationToken ct)
    {
        using var req = await RequestAsync(HttpMethod.Post, "/v1/payment_links", ct);
        // A fixed-length body, not a streamed one: JsonContent sends it chunked
        // with no Content-Length, which the test stand-in read as empty — and
        // there is no reason to find out whether every proxy in front of
        // Razorpay copes either.
        req.Content = new StringContent(JsonSerializer.Serialize(new
        {
            amount = amountPaise,
            currency = "INR",
            accept_partial = false,
            reference_id = reference,
            description,
            customer = new { name = customerName, email = customerEmail },
            // TatvaOS sends its own invoice email; Razorpay does not also mail
            // or text the customer.
            notify = new { email = false, sms = false },
            reminder_enable = false,
            notes,
            callback_url = callbackUrl,
            callback_method = "get",
        }), Encoding.UTF8, "application/json");
        return await SendAsync(req, ct);
    }

    public async Task<Link> GetLinkAsync(string linkId, CancellationToken ct)
    {
        using var req = await RequestAsync(HttpMethod.Get, $"/v1/payment_links/{Uri.EscapeDataString(linkId)}", ct);
        return await SendAsync(req, ct);
    }

    private async Task<Link> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        using var res = await http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            // Razorpay's error description, never the request (it carries the keys' header).
            string reason;
            try { reason = JsonDocument.Parse(text).RootElement.GetProperty("error").GetProperty("description").GetString() ?? ""; }
            catch { reason = $"HTTP {(int)res.StatusCode}"; }
            throw new RazorpayException($"Razorpay refused the request: {reason}");
        }
        var body = JsonSerializer.Deserialize<LinkBody>(text)
                   ?? throw new RazorpayException("Razorpay answered with nothing readable.");
        var paid = body.Payments?.FirstOrDefault(p => p.Status == "captured") ?? body.Payments?.FirstOrDefault();
        return new Link(body.Id ?? "", body.ShortUrl ?? "", body.Status ?? "", body.AmountPaid, paid?.PaymentId);
    }

    private sealed class LinkBody
    {
        [JsonPropertyName("id")] public string? Id { get; set; }
        [JsonPropertyName("short_url")] public string? ShortUrl { get; set; }
        [JsonPropertyName("status")] public string? Status { get; set; }
        [JsonPropertyName("amount_paid")] public long AmountPaid { get; set; }
        [JsonPropertyName("payments")] public List<LinkPayment>? Payments { get; set; }
    }

    private sealed class LinkPayment
    {
        [JsonPropertyName("payment_id")] public string? PaymentId { get; set; }
        [JsonPropertyName("status")] public string? Status { get; set; }
    }

    // ------------------------------------------------------------------
    public async Task<bool> WebhookSignatureOkAsync(byte[] body, string? signature, CancellationToken ct)
    {
        var secret = await settings.GetAsync(SettingKeys.RazorpayWebhookSecret, ct);
        if (string.IsNullOrWhiteSpace(secret) || string.IsNullOrWhiteSpace(signature)) return false;
        return Matches(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret.Trim()), body), signature);
    }

    public async Task<bool> ReturnSignatureOkAsync(
        string linkId, string referenceId, string status, string paymentId, string? signature, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(signature)) return false;
        var (_, secret) = await KeysAsync(ct);
        var payload = Encoding.UTF8.GetBytes($"{linkId}|{referenceId}|{status}|{paymentId}");
        return Matches(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), payload), signature);
    }

    private static bool Matches(byte[] expected, string givenHex)
    {
        byte[] given;
        try { given = Convert.FromHexString(givenHex.Trim()); }
        catch (FormatException) { return false; }
        return CryptographicOperations.FixedTimeEquals(expected, given);
    }
}

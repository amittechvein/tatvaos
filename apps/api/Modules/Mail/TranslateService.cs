using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TatvaOS.Api.Modules.Mail;

/// <summary>
/// Translates a message body, through a translator we run ourselves.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY SELF-HOSTED. Translating a message means sending its entire contents
///  to whatever does the translating. The tenants here are schools and
///  hospitals; a commercial API would mean a child's medical letter leaving
///  the organisation's infrastructure to be read by a third party, in order
///  to render a button. LibreTranslate in the same compose stack keeps the
///  text on the same machine the mail already lives on. The quality is lower
///  than the commercial services and that is the trade being made knowingly.
///
///  OFF UNTIL Translate:Endpoint IS SET. No endpoint, no feature: the status
///  call reports it plainly so the client can hide the control rather than
///  offer one that fails.
///
///  PLAIN TEXT ONLY, IN AND OUT. A message body is attacker-controlled HTML.
///  Sending it through a translator and rendering whatever comes back would
///  reintroduce every injection risk SafeHtml exists to remove, through a
///  component that has no idea it is handling hostile input. The text half is
///  translated, plain text is returned, and the client renders it as text.
///
///  NOTHING IS STORED. A translation is a view of a message, not a second
///  copy of it: it is computed on request and discarded. That keeps one
///  canonical body, and means a better translator later changes what people
///  see without a migration.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class TranslateService(
    IHttpClientFactory http, IConfiguration config, ILogger<TranslateService> log)
{
    /// <summary>
    /// Bodies are unbounded; a translator's patience is not. Past this, the
    /// text is cut and the caller is TOLD it was cut - a translation that
    /// silently stops halfway reads as the message ending there.
    /// </summary>
    public const int MaxCharacters = 20_000;

    private string Endpoint => (config["Translate:Endpoint"] ?? "").TrimEnd('/');
    private string? ApiKey => config["Translate:ApiKey"];

    public bool Configured => Endpoint.Length > 0;

    public sealed record Language(string Code, string Name);

    public sealed record Result(
        string Text, bool Truncated, string? DetectedLanguage, string? Error);

    private HttpClient Client()
    {
        var client = http.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(20);
        return client;
    }

    /// <summary>
    /// What the translator says it can do. An empty list with Configured true
    /// means it is set up but not answering, which is worth showing
    /// differently from "not set up".
    /// </summary>
    public async Task<IReadOnlyList<Language>> LanguagesAsync(CancellationToken ct)
    {
        if (!Configured) return [];

        try
        {
            using var client = Client();
            var raw = await client.GetFromJsonAsync<List<LanguageDto>>($"{Endpoint}/languages", ct);
            return raw is null
                ? []
                : raw.Where(l => !string.IsNullOrWhiteSpace(l.Code))
                     .Select(l => new Language(l.Code!, l.Name ?? l.Code!))
                     .ToList();
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Translator at {Endpoint} did not return a language list", Endpoint);
            return [];
        }
    }

    public async Task<Result> TranslateAsync(string text, string target, CancellationToken ct)
    {
        if (!Configured)
            return new Result("", false, null, "Translation is not configured.");

        var truncated = text.Length > MaxCharacters;
        var body = truncated ? text[..MaxCharacters] : text;

        if (string.IsNullOrWhiteSpace(body))
            return new Result("", false, null, "There is nothing to translate in this message.");

        try
        {
            using var client = Client();
            var payload = new Dictionary<string, string>
            {
                ["q"] = body,
                // Detected rather than declared: the Content-Language header on
                // real mail is wrong often enough not to trust it, and a
                // mailbox here routinely holds four languages.
                ["source"] = "auto",
                ["target"] = target,
                ["format"] = "text",
            };
            if (!string.IsNullOrWhiteSpace(ApiKey)) payload["api_key"] = ApiKey!;

            using var response = await client.PostAsJsonAsync($"{Endpoint}/translate", payload, ct);
            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("Translator returned {Status} for target {Target}",
                    (int)response.StatusCode, target);
                return new Result("", truncated, null, "The translator could not be reached.");
            }

            var dto = await response.Content.ReadFromJsonAsync<TranslateDto>(cancellationToken: ct);
            if (dto?.TranslatedText is not string translated)
                return new Result("", truncated, null, "The translator returned nothing usable.");

            return new Result(translated, truncated, dto.Detected?.Language, null);
        }
        catch (Exception ex)
        {
            // Unreachable, slow, or shouting: all the same to a reader, and
            // none of them are a translation.
            log.LogWarning(ex, "Translation failed against {Endpoint}", Endpoint);
            return new Result("", truncated, null, "The translator could not be reached.");
        }
    }

    private sealed class LanguageDto
    {
        [JsonPropertyName("code")] public string? Code { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
    }

    private sealed class TranslateDto
    {
        [JsonPropertyName("translatedText")] public string? TranslatedText { get; set; }
        [JsonPropertyName("detectedLanguage")] public DetectedDto? Detected { get; set; }
    }

    private sealed class DetectedDto
    {
        [JsonPropertyName("language")] public string? Language { get; set; }
    }
}

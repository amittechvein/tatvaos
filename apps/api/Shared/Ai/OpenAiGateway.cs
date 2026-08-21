using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// IAiGateway over any OpenAI-compatible chat endpoint.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THE OLD "CHAT COMPLETIONS" SHAPE AND NOT OPENAI'S NEWEST
///
///  Deliberate. Azure OpenAI speaks chat completions, and so do most other
///  providers. Using OpenAI's newest interface would tie this platform to one
///  vendor and undo the reason the gateway exists. When Amit moves to Azure
///  in an India region — the plan the moment a hospital asks where its data
///  goes — the ONLY change is Ai:BaseUrl and Ai:ApiKey.
///
///  ─────────────────────────────────────────────────────────────────────────
///  THE SETTINGS, AND WHERE THEY LIVE
///
///    Ai:BaseUrl   https://api.openai.com/v1        (Azure: the resource URL)
///    Ai:ApiKey    the secret
///    Ai:Model     gpt-5.6-luna                     (Azure: the deployment)
///
///  All three sit in infra/docker/.env on the box. The key was installed
///  there by `read -rsp` so it never appeared on a screen or in shell
///  history — and, like every secret on this platform, IT IS IN EVERY
///  NIGHTLY BACKUP, because backup.sh copies that file verbatim. Said here
///  rather than implied; see ConnectRoomKey for the same admission.
///
///  gpt-5.6-luna is a MOVING name — there is no dated variant of it in the
///  account's model list, so the provider can change what sits behind it.
///  That is acceptable because the model is a setting and quality is watched,
///  but "the model did not change" is never a free assumption.
///
///  ─────────────────────────────────────────────────────────────────────────
///  VERIFIED BEFORE THIS FILE EXISTED, 21 August 2026
///
///  The key, the model name and Hinglish quality were all proven with curl
///  against the real endpoint BEFORE a line of this was written: the account
///  authenticated, the model list came back, and a Hinglish office email got
///  a genuine Hinglish reply that Amit judged himself. Cost about a rupee.
///
///  That order was the point. The entire AI decision rested on "will it write
///  Hinglish", and answering it first meant this file was written knowing the
///  answer rather than hoping for it.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public sealed class OpenAiGateway : IAiGateway
{
    /// <summary>
    /// Beyond this the input is CUT, and AiResult.Truncated says so.
    ///
    /// Two reasons, and the second is the one that bites. A 200-message
    /// thread would be a large bill on a small feature. And a provider that
    /// refuses an over-long request returns an error a user cannot act on,
    /// where a truncated summary labelled truncated is at least honest and
    /// useful. Same reasoning as TranslateService.MaxCharacters, same order
    /// of magnitude deliberately — two caps that drift apart are two
    /// behaviours to explain.
    /// </summary>
    public const int MaxInputCharacters = 24_000;

    /// <summary>
    /// A model that has not answered in this long is not going to. Mail's
    /// composer is waiting on the other end of it.
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(45);

    private readonly IHttpClientFactory _http;
    private readonly ILogger<OpenAiGateway> _log;
    private readonly string _baseUrl;
    private readonly string? _apiKey;

    public string Model { get; }

    public OpenAiGateway(
        IHttpClientFactory http, IConfiguration config, ILogger<OpenAiGateway> log)
    {
        _http = http;
        _log = log;

        _baseUrl = (config["Ai:BaseUrl"] ?? "https://api.openai.com/v1").TrimEnd('/');
        _apiKey = config["Ai:ApiKey"]?.Trim();
        Model = (config["Ai:Model"] ?? "").Trim();

        if (string.IsNullOrWhiteSpace(_apiKey) || Model.Length == 0)
        {
            // INFORMATION, not error. AI is a capability a deployment opts
            // into. Every other unconfigured thing in this platform says so
            // plainly and carries on — refusing to start the API over an
            // unset optional key would take mail and calendar down with it.
            _log.LogInformation(
                "AI is not configured (needs Ai:ApiKey and Ai:Model), so AI features are "
                + "unavailable on this server. Everything else is unaffected.");
            _apiKey = null;
        }
    }

    public bool IsConfigured => _apiKey is not null && Model.Length > 0;

    public async Task<AiResult> CompleteAsync(
        string instruction, string input, CancellationToken ct)
    {
        if (!IsConfigured)
            return AiResult.Failed("AI features are not switched on for this server.");

        var truncated = input.Length > MaxInputCharacters;
        var body = truncated ? input[..MaxInputCharacters] : input;

        var request = new ChatRequest
        {
            Model = Model,
            Messages =
            [
                new ChatMessage { Role = "system", Content = instruction },
                new ChatMessage { Role = "user",   Content = body },
            ],
        };

        var watch = Stopwatch.StartNew();
        try
        {
            using var client = _http.CreateClient();
            client.Timeout = Timeout;
            client.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", _apiKey);

            using var content = new StringContent(
                JsonSerializer.Serialize(request), Encoding.UTF8, "application/json");

            using var response = await client.PostAsync(
                $"{_baseUrl}/chat/completions", content, ct);

            var payload = await response.Content.ReadAsStringAsync(ct);
            watch.Stop();

            if (!response.IsSuccessStatusCode)
            {
                // The STATUS and the model are logged; the payload is not,
                // because a provider's error body can echo the text we sent —
                // which is customer mail, and a log file is at rest.
                _log.LogWarning(
                    "AI request failed: {Status} from {Model} after {Ms}ms",
                    (int)response.StatusCode, Model, watch.ElapsedMilliseconds);

                return AiResult.Failed(Explain((int)response.StatusCode), watch.ElapsedMilliseconds);
            }

            var parsed = JsonSerializer.Deserialize<ChatResponse>(payload);
            var text = parsed?.Choices?.FirstOrDefault()?.Message?.Content;

            if (string.IsNullOrWhiteSpace(text))
                return AiResult.Failed(
                    "The AI service answered, but with nothing usable. Please try again.",
                    watch.ElapsedMilliseconds);

            var inTokens = parsed?.Usage?.PromptTokens ?? 0;
            var outTokens = parsed?.Usage?.CompletionTokens ?? 0;

            // THE COST LINE. Counts only, never content. This is the number
            // that turns "about ₹1,700 a month, we think" into a fact, and
            // the first thing to look at if a bill surprises anybody.
            _log.LogInformation(
                "AI ok: {Model} {TokensIn}in/{TokensOut}out in {Ms}ms{Cut}",
                Model, inTokens, outTokens, watch.ElapsedMilliseconds,
                truncated ? " (input truncated)" : "");

            return new AiResult(text.Trim(), truncated, null,
                inTokens, outTokens, watch.ElapsedMilliseconds);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            watch.Stop();
            _log.LogWarning("AI request timed out after {Ms}ms on {Model}",
                watch.ElapsedMilliseconds, Model);
            return AiResult.Failed(
                "The AI service took too long to answer. Please try again.",
                watch.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            // The USER went away — closed the tab, cancelled the request.
            // Not a failure, and not worth a warning in the log.
            throw;
        }
        catch (Exception ex)
        {
            watch.Stop();
            _log.LogWarning(ex, "AI request threw against {Model} after {Ms}ms",
                Model, watch.ElapsedMilliseconds);
            return AiResult.Failed(
                "The AI service could not be reached. Please try again.",
                watch.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// A status code turned into a sentence someone can act on. The three
    /// that matter are told apart deliberately: "we are out of credit",
    /// "we are going too fast" and "our key is wrong" need three different
    /// people to do three different things, and a single "AI unavailable"
    /// would send all of them to the wrong one.
    /// </summary>
    private static string Explain(int status) => status switch
    {
        401 or 403 => "The AI service rejected our credentials. An administrator needs to check the key.",
        429        => "The AI service is busy or the account's limit has been reached. Please try again shortly.",
        402        => "The AI account has no credit remaining. An administrator needs to top it up.",
        >= 500     => "The AI service is having problems. Please try again shortly.",
        _          => "The AI service could not complete this request.",
    };

    // ── The wire shapes. Kept private: nothing outside this file should ──
    // know what the provider's JSON looks like, which is what makes the
    // provider swappable.

    private sealed class ChatRequest
    {
        [JsonPropertyName("model")]    public string Model { get; set; } = "";
        [JsonPropertyName("messages")] public List<ChatMessage> Messages { get; set; } = [];
    }

    private sealed class ChatMessage
    {
        [JsonPropertyName("role")]    public string Role { get; set; } = "";
        [JsonPropertyName("content")] public string Content { get; set; } = "";
    }

    private sealed class ChatResponse
    {
        [JsonPropertyName("choices")] public List<Choice>? Choices { get; set; }
        [JsonPropertyName("usage")]   public Usage? Usage { get; set; }
    }

    private sealed class Choice
    {
        [JsonPropertyName("message")] public ChatMessage? Message { get; set; }
    }

    private sealed class Usage
    {
        [JsonPropertyName("prompt_tokens")]     public int PromptTokens { get; set; }
        [JsonPropertyName("completion_tokens")] public int CompletionTokens { get; set; }
    }
}

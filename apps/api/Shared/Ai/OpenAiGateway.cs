using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;

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
    public const int MaxInputCharacters = AiInput.MaxCharacters;

    /// <summary>
    /// A model that has not answered in this long is not going to. Mail's
    /// composer is waiting on the other end of it.
    /// </summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(45);

    private readonly IHttpClientFactory _http;
    private readonly ILogger<OpenAiGateway> _log;
    private readonly TatvaOS.Api.Shared.Tenancy.TenantContext _tenant;
    private readonly TatvaOS.Api.Shared.Data.AppDbContext _db;
    private readonly string _baseUrl;
    private readonly string? _apiKey;

    /// <summary>Per-scope cache of the consent — one query per request, not
    /// one per AI call within it. KEYED by tenant AND person (26 Sept 2026):
    /// a background worker can move one scope between organisations, or, in
    /// the personal house, between people; a single cached bool would carry
    /// the first answer to the next. ConnectNotesWorker runs one meeting per
    /// scope today (BatchSize = 1), which is the only reason that was safe.</summary>
    private (Guid Tenant, Guid? User, bool Allowed)? _tenantAllowed;

    public string Model { get; }

    public string? DataLocation { get; }

    public string? Vendor { get; }

    /// <summary>
    /// Hosts whose country is public knowledge. The disclosure on the consent
    /// screen is built from Ai:DataLocation; this table is what stops that
    /// setting from lying about a host it recognises. A vendor move that
    /// keeps the old location string fails closed here, at startup, instead
    /// of on a school's consent screen.
    /// </summary>
    ///
    /// The VENDOR is guarded the same way (Mr. Singh, 30 Sept 2026: name
    /// OpenAI in the admin page's own sentences, "with the vendor guarded like
    /// the location"). A known host names its own vendor, so Ai:Vendor may be
    /// left unset for it - production's .env has no such line, and requiring
    /// one would have turned AI off on the deploy that introduced it - but a
    /// value that contradicts the host is refused. An unknown host must state
    /// its vendor, exactly as it must state its location.
    /// </summary>
    private static readonly (string Host, string Country, string Vendor)[] KnownHosts =
    [
        ("api.openai.com", "United States", "OpenAI"),
    ];

    public OpenAiGateway(
        IHttpClientFactory http, IConfiguration config, ILogger<OpenAiGateway> log,
        TatvaOS.Api.Shared.Tenancy.TenantContext tenant,
        TatvaOS.Api.Shared.Data.AppDbContext db)
    {
        _http = http;
        _log = log;
        _tenant = tenant;
        _db = db;

        _baseUrl = (config["Ai:BaseUrl"] ?? "https://api.openai.com/v1").TrimEnd('/');
        _apiKey = config["Ai:ApiKey"]?.Trim();
        Model = (config["Ai:Model"] ?? "").Trim();

        var location = config["Ai:DataLocation"]?.Trim();

        if (!string.IsNullOrWhiteSpace(_apiKey) && string.IsNullOrWhiteSpace(location))
        {
            // A key without a location is REFUSED, not tolerated. The consent
            // screen prints the location; without one it would print a lie or
            // a blank, and either is worse than no AI.
            _log.LogError(
                "AI is configured with Ai:ApiKey but Ai:DataLocation is not set. Refused: "
                + "AI features are unavailable until the location the data goes to is stated.");
            _apiKey = null;
        }

        var vendor = config["Ai:Vendor"]?.Trim();
        if (string.IsNullOrWhiteSpace(vendor)) vendor = null;

        var host = Uri.TryCreate(_baseUrl, UriKind.Absolute, out var u) ? u.Host : "";
        var known = false;
        foreach (var (knownHost, country, knownVendor) in KnownHosts)
        {
            if (!string.Equals(host, knownHost, StringComparison.OrdinalIgnoreCase)) continue;
            known = true;
            if (location is null || !location.Contains(country, StringComparison.OrdinalIgnoreCase))
            {
                _log.LogError(
                    "Ai:BaseUrl points at {Host}, which is in {Country}, but Ai:DataLocation says "
                    + "'{Location}'. Refused: the consent screen would name the wrong place.",
                    host, country, location ?? "(unset)");
                _apiKey = null;
            }
            if (vendor is not null && !string.Equals(vendor, knownVendor, StringComparison.OrdinalIgnoreCase))
            {
                _log.LogError(
                    "Ai:BaseUrl points at {Host}, which is {KnownVendor}, but Ai:Vendor says '{Vendor}'. "
                    + "Refused: the consent screen would name the wrong company.",
                    host, knownVendor, vendor);
                _apiKey = null;
            }
            vendor ??= knownVendor;
        }
        if (!known && vendor is null && !string.IsNullOrWhiteSpace(_apiKey))
        {
            _log.LogError(
                "Ai:BaseUrl points at {Host}, which this gateway does not know, and Ai:Vendor is not set. "
                + "Refused: AI features are unavailable until the company the data goes to is stated.",
                host);
            _apiKey = null;
        }

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

        DataLocation = _apiKey is not null ? location : null;
        Vendor = _apiKey is not null ? vendor : null;
    }

    public bool IsConfigured => _apiKey is not null && Model.Length > 0;

    /// <summary>
    /// ── THE CONSENT CHECK, AND WHY IT LIVES HERE AND NOWHERE ELSE. ────────
    ///
    /// Mail found the gap: this gateway was deployment-wide, so the moment a
    /// key existed, a hospital's mail could reach OpenAI without that
    /// hospital having agreed. Amit ruled per-organisation, default off
    /// (27 Aug 2026), and the check is enforced INSIDE CompleteAsync rather
    /// than left to callers — a caller who has to remember a consent check
    /// is a caller who will forget it, and a forgotten check here is not a
    /// bug, it is a breach.
    ///
    /// FAIL-CLOSED THROUGHOUT: no tenant scope means NO, a query failure
    /// means NO. The one thing consent enforcement must never do is default
    /// to yes because something went wrong.
    /// </summary>
    public async Task<bool> EnabledForTenantAsync(CancellationToken ct)
    {
        if (!IsConfigured) return false;
        if (_tenantAllowed is { } cached && cached.Tenant == _tenant.TenantId && cached.User == _tenant.UserId)
            return cached.Allowed;

        if (_tenant.TenantId == Guid.Empty)
        {
            // A background job that forgot EnterAnonymousScope, or a platform
            // route with no tenant at all. Refused, loudly — this is the
            // fail-closed branch doing its one job.
            _log.LogWarning("AI call with no tenant scope — refused fail-closed.");
            return false;
        }

        try
        {
            var org = await _db.Tenants.AsNoTracking()
                .Where(t => t.Id == _tenant.TenantId)
                .Select(t => new { t.AllowAi, t.Kind })
                .FirstOrDefaultAsync(ct);

            // THE PERSONAL HOUSE (build plan D3): there is no organisation to
            // consent — its allow_ai can never be on (tenants_house_no_org_ai).
            // Consent is the PERSON's own switch, confirmed by them. No person
            // in scope (a background job that did not say on whose behalf)
            // means no. What their plan allows is MeteredAiGateway's question.
            bool allowed;
            if (org?.Kind == TatvaOS.Api.Modules.Personal.PersonalHouse.KindPersonalHouse)
                allowed = _tenant.UserId is Guid person && await _db.PersonalAi.AsNoTracking()
                    .AnyAsync(a => a.UserId == person && a.Enabled && a.ConfirmedAt != null, ct);
            else
                allowed = org?.AllowAi ?? false;

            _tenantAllowed = (_tenant.TenantId, _tenant.UserId, allowed);
            return allowed;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Could not read AI consent for tenant {Tenant} — refused fail-closed.",
                _tenant.TenantId);
            return false;
        }
    }

    public async Task<AiResult> CompleteAsync(
        string instruction, string input, CancellationToken ct, string feature)
    {
        if (!IsConfigured)
            return AiResult.Failed("AI features are not switched on for this server.");

        if (!await EnabledForTenantAsync(ct))
            return AiResult.Failed(
                "AI is not enabled for this organisation. An administrator can switch it "
                + "on once the organisation has agreed to it.");

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
            // Tenant id in the cost line: with consent now per-organisation,
            // "which org spent this" must be answerable from the same grep
            // that answers "what did we spend".
            _log.LogInformation(
                "AI ok: {Model} {TokensIn}in/{TokensOut}out in {Ms}ms tenant {Tenant}{Cut}",
                Model, inTokens, outTokens, watch.ElapsedMilliseconds, _tenant.TenantId,
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

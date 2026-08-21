namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// The ONE place anything in TatvaOS asks a language model for text.
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY AN INTERFACE, AND WHY IT IS THE ONLY THING MODULES SEE
///
///  Amit's architecture is a central AI service every product talks to,
///  rather than each product wiring itself to OpenAI. That is right, and this
///  is that service — today living IN this process rather than beside it.
///
///  The distinction that matters is not where it runs, it is that nothing
///  outside this folder knows OpenAI exists. Mail asks for a summary; Connect
///  asks for meeting notes; neither has an API key, a model name, or an
///  opinion about a provider. So:
///
///    · switching to Azure OpenAI in an India region is a setting, not a
///      change to any calling code;
///    · running one tenant on Azure India and another on OpenAI direct is a
///      lookup inside this folder;
///    · and when RAG arrives — which genuinely wants Python, a vector store
///      and its own scaling — extracting this into a separate
///      `tatvaos-ai-service` means writing a second implementation of THIS
///      interface and changing one registration line. No calling module
///      moves.
///
///  That last point is the whole reason this is an interface on day one when
///  there is exactly one implementation. It is not abstraction for its own
///  sake; it is the seam along which the service will later be cut, put in
///  before anything is glued across it.
///
///  ─────────────────────────────────────────────────────────────────────────
///  WHAT CALLERS MAY ASSUME
///
///  1. IT NEVER THROWS. A provider that is slow, rate-limited, or down must
///     not take mail with it. Failure arrives as Result.Error — a sentence a
///     person can read — and the caller decides what to show.
///
///  2. UNCONFIGURED IS NOT BROKEN. IsConfigured is false until a key exists,
///     and every feature built on this must degrade to what it did before
///     rather than error. Same contract as LiveKitTokenService.IsConfigured,
///     ConnectRoomKey.IsConfigured and TranslateService.Configured.
///
///  3. IT COUNTS. Every call reports tokens in and out. Not for curiosity:
///     the ₹1,700/month estimate that justified this decision rests on an
///     assumed 20 uses per user per month that NOBODY HAS MEASURED. One
///     month of real counts replaces the guess. A gateway that cannot tell
///     you what it spent is how a small bill becomes a large one unnoticed.
///
///  4. IT NEVER LOGS CONTENT. Counts, model, latency, error codes — yes.
///     The customer's mail, never. A log file is at rest and backed up
///     nightly; see the header of .env.example.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public interface IAiGateway
{
    /// <summary>
    /// Whether this deployment can do AI at all. False until a key is set,
    /// and callers must check it and say so in words rather than failing.
    /// </summary>
    bool IsConfigured { get; }

    /// <summary>The model this deployment is pointed at, for display and logs.</summary>
    string Model { get; }

    /// <summary>
    /// One request, one answer.
    ///
    /// `instruction` is what the model should do and how it should write —
    /// the part the product author controls. `input` is the customer's text,
    /// which is DATA and never instructions: anything in a mail thread that
    /// reads like a command to the model is a person's words being quoted,
    /// not an order to obey. Keeping them in separate arguments is what makes
    /// that distinction real rather than a hope.
    /// </summary>
    Task<AiResult> CompleteAsync(
        string instruction, string input, CancellationToken ct);
}

/// <summary>
/// What came back. Text OR Error — never both meaningful, never an exception.
/// </summary>
/// <param name="Text">The model's answer, empty when Error is set.</param>
/// <param name="Truncated">
/// The input was longer than the cap and was cut. The CALLER MUST SAY SO to
/// the user: a summary of half a thread that claims to be a summary of the
/// thread is worse than no summary, because it is confidently incomplete.
/// </param>
/// <param name="Error">
/// A sentence fit to show a person, or null on success. Never a stack trace,
/// never a provider's raw JSON.
/// </param>
/// <param name="TokensIn">Input tokens the provider billed for. Zero on failure.</param>
/// <param name="TokensOut">Output tokens the provider billed for. Zero on failure.</param>
/// <param name="Milliseconds">Round trip, for noticing the day it gets slow.</param>
public sealed record AiResult(
    string Text,
    bool Truncated,
    string? Error,
    int TokensIn,
    int TokensOut,
    long Milliseconds)
{
    public static AiResult Failed(string error, long ms = 0) =>
        new("", false, error, 0, 0, ms);
}

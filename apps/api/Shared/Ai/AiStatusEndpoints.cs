using System.Diagnostics;

namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// GET /api/admin/ai/status — does the AI actually answer?
///
/// ─────────────────────────────────────────────────────────────────────────
///  WHY THIS EXISTS, IN ONE SENTENCE: "CONFIGURED" AND "WORKING" ARE
///  DIFFERENT WORDS, AND THIS WEEK COST US THE DIFFERENCE THREE TIMES.
///
///  The outbound TLS fix sat correct in git for four days while the running
///  Postfix knew nothing about it. A checker was cited in a document as the
///  definition of correct before it had ever compiled. A key generator
///  produced sixty-four zeroes and every length check passed. In each case
///  something was PRESENT and the question that mattered was whether it
///  RESPONDED.
///
///  So this endpoint does not read settings and report them back. It sends a
///  real request to the real provider and waits for a real answer. It is the
///  smallest possible version of the deploy gate's "prove the new API starts
///  before retiring the old one".
///
///  ─────────────────────────────────────────────────────────────────────────
///  SUPERADMIN ONLY, AND IT COSTS MONEY
///
///  It bills a few tokens per call — trivial, but not free, and a real
///  request to a paid service is not something an ordinary user should be
///  able to trigger in a loop. SuperAdmin matches OrganisationEndpoints,
///  which is the existing bar for platform-wide operational routes.
///
///  It NEVER returns the key, and never echoes the prompt or reply beyond the
///  short fixed probe below — there is no customer data in this path at all.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AiStatusEndpoints
{
    /// <summary>
    /// Deliberately trivial, deliberately CHECKABLE. Asking for one exact
    /// word means the answer proves the model read the instruction and
    /// followed it — not merely that bytes came back. A probe that accepts
    /// any reply would pass against a model answering nonsense, which is the
    /// false-pass shape we keep finding.
    /// </summary>
    private const string ProbeInstruction =
        "Reply with exactly one word: OK. No punctuation, no explanation.";

    private const string ProbeInput = "ping";

    public static void MapAiStatusEndpoints(this WebApplication app)
    {
        app.MapGet("/api/admin/ai/status", async (
            IAiGateway ai, CancellationToken ct) =>
        {
            if (!ai.IsConfigured)
                return Results.Ok(new
                {
                    configured = false,
                    working = false,
                    detail = "No AI key is set on this server, so AI features are off. "
                           + "Everything else is unaffected.",
                });

            var watch = Stopwatch.StartNew();
            var result = await ai.CompleteAsync(ProbeInstruction, ProbeInput, ct);
            watch.Stop();

            if (result.Error is not null)
                return Results.Ok(new
                {
                    configured = true,
                    working = false,
                    model = ai.Model,
                    milliseconds = watch.ElapsedMilliseconds,
                    detail = result.Error,
                });

            // Configured, answering, AND doing as it was told. The third is
            // the one worth having: a reply that ignores a one-word
            // instruction is a sign the model or the settings are not what we
            // think, and it is better to see that here than in a customer's
            // meeting notes.
            var obedient = result.Text.Trim().TrimEnd('.').Equals(
                "OK", StringComparison.OrdinalIgnoreCase);

            return Results.Ok(new
            {
                configured = true,
                working = true,
                followedInstruction = obedient,
                model = ai.Model,
                milliseconds = result.Milliseconds,
                tokensIn = result.TokensIn,
                tokensOut = result.TokensOut,
                detail = obedient
                    ? "The AI service answered correctly."
                    : $"The AI service answered, but not as instructed (said \"{result.Text.Trim()}\" "
                      + "rather than OK). Worth checking the model name.",
            });
        })
        .RequireAuthorization("SuperAdmin")
        .WithName("AiStatus");
    }
}

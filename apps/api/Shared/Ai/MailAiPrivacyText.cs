namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// Whether the Mail AI privacy text is complete - no blank left in it.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Mr. Singh, 30 Sept 2026, approving PR 364: the operator's "Offer Mail AI"
///  button "must refuse to work while the privacy text still has a blank in
///  it, so it can't be pressed too early". A customer used Mail AI on 25 Sept
///  before its privacy text existed; this keeps the second organisation from
///  being offered it before the text is whole.
///
///  The text itself is PR 366 (AiDisclosure.cs), which merges AFTER this one.
///  Until it does there is no text at all, so this answers FALSE and the
///  button refuses: closed by default, not open until someone remembers.
///  PR 366 replaces the body with "no PENDING marker in any AiDisclosure
///  sentence" - the same markers tests/ai/privacy-text-matches.py fails on -
///  so the button opens on the deploy that carries a complete text, and not
///  before. (The API and the privacy page ship in the same deploy, and that
///  test holds them to the same words, so "the running API's text is whole"
///  means "the live privacy page is whole".)
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class MailAiPrivacyText
{
    /// <summary>False until PR 366 supplies the text and its blanks are filled.</summary>
    public static bool Complete => TextComplete || _testOverride;

    private static bool TextComplete => false;

    // ── FOR TESTS, AND ONLY IN DEVELOPMENT ───────────────────────────────
    //  tests/mail-ai-offer must prove the offer itself as well as the
    //  refusal, before the text exists. MailAi__PrivacyTextCompleteForTests=1
    //  says "pretend it is complete" - honoured ONLY when the API runs as
    //  Development (the dev-operator sign-in's rule, PR 281); anywhere else it
    //  is IGNORED and the start-up log says so, loudly. Production runs as
    //  Production, so the variable cannot open the button there.
    private static bool _testOverride;

    public const string TestOverrideKey = "MailAi:PrivacyTextCompleteForTests";

    public static void ConfigureForTests(IHostEnvironment env, IConfiguration config, ILogger log)
    {
        if (config[TestOverrideKey] != "1") return;
        if (!env.IsDevelopment())
        {
            log.LogError("{Key} is set but this is {Env}, not Development - IGNORED. The Mail AI offer "
                + "button stays closed until the privacy text is complete.", TestOverrideKey, env.EnvironmentName);
            return;
        }
        _testOverride = true;
        log.LogWarning("{Key}=1 in Development: the Mail AI privacy text is TREATED AS COMPLETE for tests.",
            TestOverrideKey);
    }

    public const string Incomplete =
        "The Mail AI privacy text still has a blank in it, so Mail AI cannot be offered to another "
        + "organisation yet. It can be offered once the complete text is live.";
}

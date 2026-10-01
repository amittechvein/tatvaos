namespace TatvaOS.Api.Shared.Ai;

/// <summary>
/// Every sentence a customer is shown about what TatvaOS AI sends, ONE copy.
///
/// ─────────────────────────────────────────────────────────────────────────
///  Mr. Singh, 30 Sept 2026, approving the Mail AI privacy text: the admin
///  page, the privacy page and the website must say, "in the same words
///  everywhere", what is sent for each feature, to whom (the vendor named in
///  the privacy policy, only), where, how long the provider keeps it and
///  whether it trains on it, that it is off by default, and that the
///  organisation's administrator decides.
///
///  So the sentences live here as plain constants, and:
///    * OrgAiEndpoints builds the admin page's sentences from them, with the
///      vendor and place from the gateway (IAiGateway.Vendor/DataLocation,
///      both guarded against the provider's host);
///    * apps/web/app/privacy/page.tsx carries the same constants' text, and
///      tests/ai/privacy-text-matches.py fails when any one of them is not on
///      that page word for word, or when a placeholder is left anywhere.
///
///  Every "what is sent" claim was checked against the code on 30 Sept 2026:
///    Help me write   MailAiEndpoints.RewriteAsync - the typed text only
///    Suggestions     MailSuggestions - sender NAME, subject, new part
///                    (quoted history cut), text part only, never HTML;
///                    skips Sent/Drafts/Junk/Trash/Scheduled, own, automated
///    Summarise       MailSummary - per message: sender NAME, date, new part;
///                    junk left out; no subject
///    Sorting         MailTriage/MailTriageWorker - sender NAME, subject,
///                    first 1,000 characters of the new part; inbox only;
///                    own mail and automated senders not sent
///  Change one of those and this file is wrong until it is changed too.
/// ─────────────────────────────────────────────────────────────────────────
/// </summary>
public static class AiDisclosure
{
    // ── What each feature sends ──────────────────────────────────────────
    public const string HelpMeWrite =
        "the draft a person has typed, only when they ask for it to be rewritten";

    public const string SuggestedReplies =
        "the sender's name, the subject and the new text of an email, when a person opens it";

    public const string Summarise =
        "the sender's name, the date and the new text of each email in a conversation, when a person asks for a summary";

    public const string Sorting =
        "the sender's name, the subject and the first 1,000 characters of the new text of every new email that "
        + "arrives, including ones about health, children or money, without anyone clicking anything";

    // ── What is never sent ───────────────────────────────────────────────
    public const string NeverSent =
        "The sender's email address, earlier messages quoted below the new text, attachments and junk mail are "
        + "never sent. Suggested replies and sorting also skip mail your organisation sent and mail from "
        + "automated senders.";

    // ── Who decides ───────────────────────────────────────────────────────
    //  Suggested replies start OFF (Mr. Singh, 30 Sept 2026): they send
    //  someone else's email the moment it is opened, with nobody asking.
    public const string WhoDecides =
        "Mail AI is off by default. Only your organisation's administrator can turn it on, and they can turn "
        + "each feature off again at any time. When Mail AI is turned on, Help me write starts on; suggested "
        + "replies, Summarise and sorting stay off until the administrator turns each one on. Sorting is not "
        + "offered to hospitals and clinics.";

    // ── How long the provider keeps it, and training ──────────────────────
    //  FROM THE OPENAI ACCOUNT'S DATA SETTINGS, read by Amit in his browser -
    //  not assumed. Until he sends them this is a placeholder, and
    //  tests/ai/privacy-text-matches.py FAILS while a PENDING marker is anywhere,
    //  so this cannot merge or ship with the blank in it.
    public const string Retention =
        "[PENDING Amit: OpenAI keeps what we send for ___ and does / does not use it to train its models. "
        + "This is from our OpenAI account's data settings, checked on ___.]";

    // ── Meetings ──────────────────────────────────────────────────────────
    //  Minutes are written from live captions; no meeting audio reaches
    //  OpenAI (checked 30 Sept 2026: the recording-transcription path is not
    //  configured on production).
    public const string MeetingNotes =
        "the text of what was said, taken from live captions (not the audio)";

    //  Live captions themselves: the BROWSER turns speech into text, and the
    //  browser's own speech service hears the audio - Google for Chrome,
    //  Microsoft for Edge, Apple for Safari (lib/useCaptions.ts uses whatever
    //  the browser provides). Mr. Singh writes this sentence once his five
    //  questions are answered (30 Sept 2026); until then it is a blank, and a
    //  blank here keeps the Mail AI offer button closed like any other.
    public const string Captions =
        "[PENDING Mr. Singh: the live-captions sentence - which speech service hears the audio, where, "
        + "who turns it on, what that service keeps, and whether there is a switch.]";

    /// <summary>"OpenAI, in the United States" - the one way every sentence names who and where.</summary>
    public static string ToWhom(string vendor, string location) => $"{vendor}, in {location}";

    /// <summary>
    /// True when no sentence here still has a blank (a PENDING marker) -
    /// the same markers tests/ai/privacy-text-matches.py fails on. Read by
    /// MailAiPrivacyText: the operator's Offer Mail AI button opens on this
    /// (Mr. Singh, 30 Sept 2026). Every public const string is looked at, so a
    /// sentence added later is covered without anyone listing it.
    /// </summary>
    public static bool Complete { get; } = typeof(AiDisclosure)
        .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
        .Where(f => f.IsLiteral && f.FieldType == typeof(string))
        .All(f => !((string)f.GetRawConstantValue()!).Contains(PendingMarker, StringComparison.Ordinal));

    // Built from two pieces so this file's own code is not itself a blank to
    // privacy-text-matches.py; private, so the scan above does not read it.
    private const string PendingMarker = "[" + "PENDING";
}

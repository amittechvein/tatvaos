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
    //  Mr. Singh's sentence, 1 Oct 2026. It describes the PRESENT: the
    //  OpenAI account (organisation "Techvein") had training data-sharing ON
    //  until 1 Oct 2026, when it was switched off on Amit's go and checked
    //  after a reload; the past goes in notices to affected customers, not
    //  in the policy. 30 days is OpenAI's own abuse-monitoring retention for
    //  the API (developers.openai.com/api/docs/guides/your-data). The account
    //  settings this depends on are recorded and checked as part of our
    //  disclosure: docs/runbooks/backup-and-restore.md, "Provider settings".
    public const string Retention =
        "OpenAI does not use what we send to train its models. OpenAI keeps it for up to 30 days to check "
        + "for misuse, unless the law requires it to be kept longer.";

    // ── Meetings ──────────────────────────────────────────────────────────
    //  What the minutes are written from, in the words the privacy page has
    //  used since 21 Sept ("meeting transcripts"). Nothing here about HOW the
    //  transcript is made: live captions are a Connect disclosure, ruled OUT
    //  of the Mail AI text by Mr. Singh on 1 Oct 2026, and the privacy page
    //  says nothing new about them until he writes that sentence. It must NOT
    //  be added here as a PENDING sentence: anything in this class gates the
    //  Mail AI offer button (Complete, below).
    public const string MeetingNotes = "the meeting's transcript";

    // ── DOCS AI (approved wording #384, price final #388; built with its own
    //    switch, #406, 10 Oct 2026). Checked against the code that day:
    //      what is sent   DocsEndpoints.AiAsync sends req.Text ONLY — the
    //                     selection (rewrite, translate), the document's text
    //                     (summarise, and as context for write) — plus, for
    //                     write, the person's own request; never pictures,
    //                     comments, versions or editors' names
    //      24,000         AiInput.MaxCharacters, cut in the gateway for every
    //                     request (OpenAiGateway)
    //      only on click  the editor's AI panel; no Docs AI call runs unasked
    //      off / who      allow_docs_ai, default false, set only by an
    //                     organisation administrator (OrgAiEndpoints), checked
    //                     in the gateway for every docs.* label
    public const string DocsSummarise =
        "the text of the document, when a person asks for a summary";

    public const string DocsRewrite =
        "only the text a person has selected, when they ask for it to be improved, shortened, expanded, "
        + "made formal or made simpler";

    public const string DocsTranslate =
        "only the text a person has selected, and the language they choose, when they ask for a translation";

    public const string DocsWrite =
        "what a person asks to be written, together with the text of the document for context, when they "
        + "ask TatvaOS AI to write something";

    public const string DocsNeverSent =
        "Pictures, comments, earlier versions and the names of the people who edited a document are never "
        + "sent. Only text is sent, and no more than about 24,000 characters of it at a time. Nothing is sent "
        + "unless a person clicks.";

    public const string DocsWhoDecides =
        "Docs AI is off by default. Only your organisation's administrator can turn it on, and they can turn "
        + "it off again at any time.";

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

# Docs AI — what we tell customers (proposal)

**Status: draft, 3 October 2026. Wording only; no code changed.** For Mr. Singh's ruling and Amit's price before Docs AI is offered to anyone, Techvein included.

## Why it's needed

Mr. Singh, 30 Sept 2026: every AI feature ships behind an organisation list that stays **empty (nobody) until its disclosure is live**. The admin page, the privacy page and the website must say, *in the same words everywhere*, five things:
- what is sent for each feature;
- to whom (the vendor named in the privacy policy, only), and where;
- how long the provider keeps it, and whether it trains on it;
- that it is off by default;
- that the organisation's administrator decides.

`ai.docs.organisations` is empty today (the deploy of 1 Oct printed "(no row - nobody)"), so even Techvein can't use Docs AI during its trial.

The Mail AI text is live (PR 366, `apps/api/Shared/Ai/AiDisclosure.cs`). This proposal adds Docs AI **in the same shape**, so the two read as one policy.

**Caution for whoever builds it:** every `public const string` in `AiDisclosure` that still contains a blank marker **closes the Mail AI offer button** (`AiDisclosure.Complete`). So these sentences go into that file only once they are final. Never add them as placeholders.

## What Docs AI actually sends (checked against the code, 3 Oct 2026)

Everything starts with a person clicking. Docs AI sends nothing in the background.

| Feature (as the panel names it) | Sent | Code |
|---|---|---|
| **Summarise** | the document's text | `AiPanel.tsx` (`'document'` = `editor.getText()`), `DocsEndpoints.AiAsync` `summarize` |
| **Improve / Shorten / Expand / Formal / Simpler** | only the text the person selected | `'selection'`, `rewrite` |
| **Translate** | only the text the person selected, and the language they chose | `'selection'`, `translate` |
| **Write with AI** | what the person asked for, and the document's text as context | `'document'`, `generate` |

In every case:
- the text is plain text: no pictures, no formatting;
- it is cut at **24,000 characters** (`AiInput.MaxCharacters`), and the person is told when it was;
- the document's **comments, version history, title, sharing and who edited it** are not sent;
- the text goes to the provider as **data, never as instructions** (only the person's own request in "Write with AI" is an instruction);
- Summarise needs view access; everything else needs edit access, because its result goes *into* the document.

## The proposed sentences

These are for `AiDisclosure.cs` (with the same words on `apps/web/app/privacy/page.tsx`, held together by `tests/ai/privacy-text-matches.py`, and on the organisation's AI page):

```csharp
// ── Docs AI: what each feature sends ─────────────────────────────────
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

// ── Docs AI: what is never sent, and limits ──────────────────────────
public const string DocsNeverSent =
    "Pictures, comments, earlier versions and the names of the people who edited a document are never "
    + "sent. Only text is sent, and no more than about 24,000 characters of it at a time. Nothing is sent "
    + "unless a person clicks.";

// ── Docs AI: who decides ──────────────────────────────────────────────
public const string DocsWhoDecides =
    "Docs AI is off by default. Only your organisation's administrator can turn it on, and they can turn "
    + "it off again at any time.";
```

**To whom, where, and how long:** the same sentences as Mail AI, unchanged.
- `ToWhom` gives "OpenAI, in the United States".
- `Retention`: "OpenAI does not use what we send to train its models. OpenAI keeps it for up to 30 days to check for misuse, unless the law requires it to be kept longer."

Reusing them keeps one statement per fact.

## Before Docs AI can be switched on (in order)

1. **Mr. Singh** rules on the sentences above.
2. **Amit** sets the price per action. Today every Docs AI action costs the default 1 credit, because `AiCredits` has no "docs" line. Mr. Singh suggested 1 / 1 / 1 / 5 (Summarise / Rewrite / Translate / Write). That needs a separate feature name per action, since today all four are metered as "docs".
3. **A build PR (Docs lane):**
   - the sentences go into `AiDisclosure.cs`, the privacy page and the AI page;
   - `privacy-text-matches.py` must pass;
   - the per-action metering is added if (2) asks for it.
4. **Deploy** by the Mail session.
5. **The operator** puts Techvein on `ai.docs.organisations`, and Techvein's administrator turns Docs AI on.

**Not changed by this:** Mail AI's text, Sheets AI (its list stays empty until it has its own sentences), and meeting minutes.

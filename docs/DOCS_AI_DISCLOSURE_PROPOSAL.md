# Docs AI — what we tell customers (proposal)

**Status:**
- **3 Oct 2026:** written. Wording only; no code changed.
- **7 Oct:** the sentences are **cleared to go into `AiDisclosure.cs`** (Mr. Singh), and the price is final, **2 / 3 / 1 / 5** (#388, merged).
- **8 Oct: one thing the sentences depend on does not exist yet: Docs AI has no switch of its own.** See "The switch the sentences assume", below. That needs his ruling before the build.

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

## The switch the sentences assume (found 7 Oct, for Mr. Singh's ruling)

**`DocsWhoDecides` says "Docs AI is off by default. Only your organisation's administrator can turn it on, and they can turn it off again at any time." The code doesn't do that today.**

`DocsEndpoints.AiAsync` checks three things:
- the platform has an AI key;
- `EnabledForTenantAsync`, which is **`core.tenants.allow_ai`**, the same organisation switch that sends meeting transcripts for minutes;
- `ai.docs.organisations`, our list.

There is no Docs switch. So:
- **An organisation that turned AI on for meeting notes would get Docs AI the moment it is put on the list,** without its administrator ever choosing it. Techvein is that organisation today.
- **The administrator can't turn Docs AI off without turning off meeting notes as well.**
- **The organisation AI page's sentence at that switch names only meeting transcripts.** It would understate what is sent, the failure of 25 Sept. A consent sentence that says less than what is sent is worse than none.

**Proposed: a Docs AI switch of its own, built exactly like Mail AI's.**

| Part | Mail AI today | Docs AI, proposed |
|---|---|---|
| Consent column | `core.tenants.allow_mail_ai boolean NOT NULL DEFAULT false` (`20260925-mail-ai-switch.sql`) | **`core.tenants.allow_docs_ai boolean NOT NULL DEFAULT false`**, a new additive migration. Default off, so no organisation has it on after the deploy |
| Our offer | `ai.mail.organisations` | `ai.docs.organisations` (exists, empty) |
| Checked before sending | `allow_ai` + `allow_mail_ai` + the list | **`allow_ai` + `allow_docs_ai` + the list,** in `DocsEndpoints.AiAsync`. Refused with "Docs AI is switched off for your organisation. An administrator can turn it on." |
| Admin page | a Mail AI card: switch + `mailDisclosure` sentences | **a Docs AI card**: the switch, and the sentences built from the `Docs*` constants (`OrgAiEndpoints`, like `mailDisclosure`), shown before it's turned on |
| Turning it on | refused unless offered (on the list); audited | the same: refused unless on `ai.docs.organisations`; an audit line on each change |
| Plan entitlement ("in use") | `"mail.ai"` = switch on, or any `mail.*` usage this month | **`"docs.ai"`** = switch on, or any `docs*` usage this month |

**What it changes for customers:** nothing until both happen: the operator puts an organisation on the list, **and** its administrator turns the switch on. Today the list is empty, so nobody, Techvein included, sees any change at deploy.

**Rule 7:** an additive migration, and a consent change, so it's Mr. Singh's to read before merging.

## Before Docs AI can be switched on (in order)

1. ~~Mr. Singh rules on the sentences above~~: **cleared 7 Oct** (final text only, never a blank marker).
2. ~~Amit sets the price per action~~: **final 7 Oct (#388, merged): Summarise 2, rewrite actions 3, Translate 1, Write with AI 5.** The `"docs" => 1` legacy row stays, so history is priced as it was charged.
3. **Mr. Singh rules on the switch** (above).
4. **One build PR (Docs lane), the sentences and the switch together,** so the text can never be live without the switch it describes:
   - the six `Docs*` sentences into `AiDisclosure.cs`, the privacy page and the organisation AI page;
   - `privacy-text-matches.py` extended to hold the `Docs*` constants, and passing;
   - the switch, as in the table.
5. **Support's answer on the prices**, before switch-on (Mr. Singh, 7 Oct): why a rewrite (3) costs more than a summary (2), and why two rewrites (6) cost more than one draft (5). Amit's reason, written once.
6. **Deploy** by the deploying session.
7. **The operator** puts Techvein on `ai.docs.organisations`. **Then Techvein's administrator turns Docs AI on**, the step that only exists once (4) is built.

**Not changed by this:** Mail AI's text, Sheets AI (its list stays empty until it has its own sentences), and meeting minutes.

# 0011 — What has to happen before Docs or Sheets reaches a customer

**Status:** accepted — conditions set by Mr. Singh, 25 September 2026; approved by him as the single record for both products (the Docs session adds to this one, never a second)
**Date:** 2026-09-25

One place that lists what stands between Docs and Sheets and any customer
other than Techvein. Both products ship switched off (a per-organisation
switch each, turned on only by the platform operator), so merging and
deploying them changes nothing a customer sees. Turning either on for a
customer is the decision this record governs.

## Context

A document and a spreadsheet are Space files whose live content is a Yjs
document. The server stores and relays that content **without reading it**
(`apps/api/Modules/Docs/DocsLiveHub.cs`). The copy Space serves, downloads
and lets Mail attach — the document's `.html`, the spreadsheet's `.xlsx` —
is built **in a browser** and uploaded at each checkpoint.

Two consequences, found in review on 24–25 September:

1. **Hostile content.** A hand-built client with edit access can send any
   HTML or any workbook. For Sheets the server now refuses workbooks that
   would attack whoever opens them (`XlsxGuard.cs`: macros, embedded
   objects, links outside the file, calling-out formulas, non-http(s)/mailto
   HYPERLINK targets). For Docs the equivalent — an allowlist sanitiser on
   the HTML before it is stored, applied to `docs.versions` too — is Mr.
   Singh's condition for merging the Docs PRs (272–274), owned by the Docs
   session.
2. **Divergence.** Even a perfectly clean file can *say something different*
   from what the collaborators edited: a page reading "the fee is ₹5,000"
   while the document says ₹50,000; a workbook with different marks or
   salaries from the live sheet. Sanitising does not touch this. For a
   spreadsheet it is worse than for a document — these are numbers people
   act on — and the file carries the school's name.

## Decision

**Neither product is switched on for any organisation other than Techvein
until each of these is done.**

| # | Condition | Product | Owner |
|---|---|---|---|
| 1 | The file Space serves (`.html` / `.xlsx`) is **built on the server from the Yjs state**, so there is one source of truth and a client cannot make the file differ from the content. | Docs **and** Sheets | not started |
| 2 | Documents sent by email go as **PDF, not HTML**, generated from the same server-side render as condition 1. The `.html` download from Space may stay. | Docs | not started |
| 3 | Server-side allowlist sanitiser on checkpoint HTML and on `docs.versions` — **a merge condition, not only a customer one.** | Docs | **built** (PR 273, `DocsHtml.cs`); approved by Mr. Singh (reached this lane by 28 Sept 2026, given in a separate session — see "A note on the dates") — see "The sanitiser is our own code" below |
| 4 | y-prosemirror's dropping of unknown nodes, if verified, is logged, not silent. | Docs | not started, not yet verified |

**What proves each condition — so no box is ticked by something that only looks like it:**

- **1 (server render).** The served file is produced by the API from the Yjs state it stores. Proof: a checkpoint whose uploaded file *differs* from the Yjs content does not change what Space serves — the test sends a mismatching file and shows the download still matches the content.
- **2 (PDF by email).** The PDF is built **on the server, from the same source as condition 1**. A PDF made in the browser has exactly the divergence problem of HTML made in the browser, and **does not meet this condition**, however it looks. Proof: the same mismatch test, run against the mail attachment — the PDF matches the stored content, not the client's file (Mr. Singh, 25 Sept 2026).
- **3 (sanitiser).** The three malformed cases (unknown elements, content that is not a document, raw hostile HTML) produce only allowlisted, escaped markup, each with its permit twin (`tests/docs-html`). And two proofs that do not rest on cases its author chose: every output is **loaded in a browser**, where nothing may run and nothing may be fetched but a kept picture (`tests/docs-html/browser.mjs`); and it is run against **a corpus of attacks written by other people** (`tests/docs-html/corpus`).
- **4 (logged drops).** A document with an unknown node produces a log line naming the document and the node type, never the content.

Already true, and must stay true (checked by tests every run):

- A file's live type is set only by the server; Space strips the two live
  types from anything a client or an email sender claims (`DocsFormat.ClientType`).
- Switching a product off withdraws its editor, **never the data**: Space
  still lists and downloads the file (`tests/sheets/sheets-live.e2e.ts`).
- Each product answers only to its own switch (`LiveSwitch`).

## A note on the dates in this record

Corrected 28 September 2026, at Mr. Singh's request through Amit. This record
first dated two rulings **30 September 2026**, a date that had not yet come;
every line carrying it was committed on 28 September. The dates below are
now the dates the rulings **reached this lane** — the commit date, so at the
latest. Those rulings were given in a **separate session**, not the one Amit
forwards Mr. Singh's rulings from; Mr. Singh has not disputed what they say.
From 28 September every CTO ruling comes through Amit from that one session,
and a record that says "Mr. Singh ruled" means that session.

## The sanitiser is our own code — a decision, not a default

Mr. Singh, on PR 273 (reached this lane by 28 September 2026, in a separate
session — see "A note on the dates"). Recorded so a later reader knows
it was chosen and why, and what to do the day it is wrong.

**The choice.** `apps/api/Modules/Docs/DocsHtml.cs` is a parser and writer
written here, not a library. Normally that is the wrong choice for a
sanitiser: the maintained ones have been attacked for years.

**Why it is accepted here.** The classic bypass copies something through
that the sanitiser read as safe text and a browser re-reads as markup.
This one never copies through. It reads the input into tags, attributes
and text, and **writes the output fresh**: only elements on the list, each
attribute value passing its own check, every string encoded on the way
out. A disagreement between its parser and a browser's cannot put raw
markup in the output, because the output is not the input with parts
removed. That closes the class of bypass, not only the cases tested.

**It is one layer of three, and is not trusted alone.** The file is served
as a download, not rendered on our origin; it carries a policy forbidding
every script; and under condition 2 a document leaves by email as a PDF.

**The fallback is named.** If the browser test or the corpus test ever
finds an output that runs or fetches, the sanitiser is replaced with
**`HtmlSanitizer`** (Ganss.Xss, which brings AngleSharp) rather than
patched case by case. One bypass means the argument above was wrong
somewhere, and an argument that was wrong once is not repaired by a fix
to the one case that showed it.

**What it cannot do**, whoever wrote it: make the file say what the
document says. That is condition 1.

**Known and allowed:** a picture kept from the web (`http`/`https`) is
asked for when the file is opened, which tells that picture's host the
file was opened. The editor allows pasted web pictures, so the sanitiser
does. Whether stored files should carry only Docs' own pictures is an open
question for Mr. Singh, not decided here.

## Consequences

- Techvein can use both products on its own data, with the divergence
  limitation known and written next to the code (`XlsxGuard.cs`,
  `DocsFormat.cs`).
- Condition 1 is real work: a .NET renderer for the document schema and for
  the workbook, reading Yjs updates on the server — which today it
  deliberately never does. It also removes the reason the browser uploads
  the file at all.
- Until then, the browser-built file is a convenience copy, and the tests
  that prove it is *safe* do not prove it is *accurate*.

## Revisit when

Condition 1 is built for a product — that product's row can then be struck
through here, and this record updated rather than replaced.

A third product needing a per-organisation switch is a separate trigger:
two switch tables is the limit; unify them first (Mr. Singh, 24 Sept 2026).

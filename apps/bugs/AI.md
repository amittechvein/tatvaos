# TatvaOS Bugs — AI proposal (for Mr. Singh)

Amit, 26 Sept 2026: "start with improve my report and possible duplicates".
Both are built. **Possible duplicates uses no AI.** **Improve my report is OFF
and stays off until you agree and Amit switches it on.**

## 1. Possible duplicates — no AI, nothing leaves the server

While a tester types a title, the form lists up to five existing issues that
share its words (title words weigh most; same sub-module ranks higher). A
single word or common words alone never match. Plain text matching in
`src/similar.mjs`, run on the tracker's own database.

## 2. Improve my report — AI, off by default

A tester presses **✨ Improve my report**. The draft comes back rewritten as
*Steps to reproduce / What happened / What was expected / Other notes*, with a
suggested type, priority and sub-module, and up to four questions the report
does not answer. The tester edits it and submits it themselves; the AI never
files anything. The history marks the report "written with AI help".

**What is sent**: the draft's title, details and type, and the list of
module › sub-module names. **What is never sent**: files, anyone's name or
email, other issues, comments.

**Rules copied from the product gateway** (`apps/api/Shared/Ai/OpenAiGateway.cs`,
which you read for Mail AI):

- OpenAI-compatible `/chat/completions`, with the tracker's **own key** (pasted
  in Settings, write-only; never the product's key — the same reasoning as your
  condition 3 for mail).
- A key **without a stated data location is refused**; a known host whose
  country disagrees with the stated location is refused (`api.openai.com` must
  say United States). The location is shown to the tester beside the button.
- The provider's reply body is **never logged** (it can echo the text).
- Input capped at 8,000 characters; 30-second timeout; every answer checked
  before the page sees it (unknown values dropped, the sub-module must be one
  we offered).
- A **daily limit for the whole team** (Settings, default 100). One row per call
  in `ai_usage`: who, when, worked or not, how long — no text.

**Name on screen (Amit, 26 Sept):** people see **"TatvaOS AI"** everywhere — no
vendor name, no vendor address filled in, no model example. The admin types the
address, model and key. The *where the data goes* line (the data location) is
still shown to testers beside the button, so the brand name never hides the
place the text is sent. A test fails if a vendor name reappears on the page.

## What I need from you

1. Is sending report text to the provider acceptable, given that reports can
   mention customers? The help text already tells testers not to upload real
   customers' mail; the button's line says exactly what is sent and where.
2. Which provider and location — the same as the product's AI (the provider's
   retention answers are still owed by Amit for PR 280), or another?
3. The daily limit to start with.

## Evidence

`test/flow.mjs` 160/160, run against a **fake AI server on the laptop** (nothing
sent anywhere). It checks the tracker's own key is used, the tester's words are
sent, and the tester's name, email and other issues are **not**; that no-location
and wrong-location configs are refused; that the provider's error body is not
passed on; the daily limit; developer mode refused; switching off stops it.

Calibrated: removing the no-location refusal, adding the reporter's email to what
is sent, or letting one word match a duplicate each turns the right check red.

Browser (local, fake AI): Settings → ready; tester typed a rough report, saw
TV-000003 as a possible duplicate, pressed Improve, used the suggestion (fields,
priority, module and sub-module filled), submitted; history says "written with
AI help". At 375px nothing scrolls sideways.

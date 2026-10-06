# TatvaOS AI requests were shared with OpenAI for training (until 1 Oct 2026)

**Status: sharing stopped 1 October 2026 08:45 UTC. Customer notices ON HOLD**
until Amit's lawyer advises whether this is reportable under India's Digital
Personal Data Protection Act, 2023, and to whom (Mr. Singh, 1 Oct 2026).
Counts, dates and organisation ids only; no content was read for this record.

## The dates

| | |
|---|---|
| OpenAI's API default | data sharing **off**; it is opted into in the account |
| Sharing switched **on** | **not established.** The OpenAI account has no audit logging, so it cannot say when; it came with an offer of "complimentary daily tokens" |
| Earliest TatvaOS AI request that could have been affected | AI meeting minutes from **22 August 2026** (the first `kind = 'model'` notes) |
| Found | **1 October 2026**, reading the account's Data controls in Amit's browser for the Mail AI privacy text (PR 366), at Mr. Singh's request |
| **Sharing switched off** | **1 October 2026, 08:45:28 UTC**, on Amit's go: all three options (inputs and outputs; evaluation and fine-tuning data; Playground feedback) set to Disabled, saved, and read again after a reload: all Disabled |

What the account said before the change: *Share inputs and outputs with
OpenAI - Enabled for all projects*, described by OpenAI as "to help us develop
and improve our services, including for improving and training our models".

## Who was affected (production read, 1 Oct 2026, on Amit's go)

Everything sent to OpenAI **before 08:45:28 UTC on 1 October**.

| Organisation | What was sent | Count | First (UTC) | Last (UTC) |
|---|---|---|---|---|
| **Organisation 5** `42185a2e-5bcd-490f-a453-f22de49f6e78` (the one outside customer) | Help me write: their own drafts | 4 | 25 Sept 20:03 | 25 Sept 20:04 |
| Organisation 5 | Suggested replies: one email they received | 1 | 25 Sept 20:02 | 25 Sept 20:02 |
| Techvein (own) | Meeting minutes written by AI | **at least 33 meetings** | 22 Aug 09:26 | 24 Sept 09:40 |
| Techvein (own) | Sorting incoming mail | 153 | 25 Sept 18:31 | 1 Oct 05:43 |
| Techvein (own) | Suggested replies | 82 | 25 Sept 18:15 | 1 Oct 08:05 |
| Techvein (own) | Help me write | 4 | 25 Sept 18:16 | 26 Sept 07:36 |
| Techvein (own) | Summarise conversation | 1 | 28 Sept 19:13 | 28 Sept 19:13 |
| Bug tracker (Techvein staff, internal; its key is in the same OpenAI organisation) | Improve my report 2, Summarise issue 1 | 3 | 26 Sept 06:57 | 26 Sept 08:11 |

No other organisation appears in any source. No recording audio was ever
sent for transcription (`connect.transcripts`, status ready: 0 rows). No
Docs AI requests.

## How far back each source reaches, and what it cannot see

| Source | Reaches back to | What it misses |
|---|---|---|
| `core.ai_usage` (metering, PR 280) | 25 Sept 2026 18:15 UTC | nothing after that; nothing before it existed |
| `connect.meeting_notes`, `kind = 'model'` | 19 Aug 2026 (first notes row); meetings table from 17 Aug, when Connect started, so no meetings appear to have been deleted | **an undercount**: each meeting keeps only its LATEST notes, replaced in place, so a meeting whose minutes were rewritten counts once, and the dates are those of the latest version. The figure is "at least 33 meetings" |
| bug tracker `ai_usage` (its own SQLite) | 26 Sept 2026, when its AI was switched on | nothing |

## Not counted here: other applications on the same OpenAI organisation

Sharing was set for the whole organisation, so it covered every key in it.
The API keys page (read 1 Oct, in Amit's browser) lists five; two are
TatvaOS's (production, bug tracker). The other three are not TatvaOS code,
and what they sent is **for Amit to establish** - whether any of it is
customer or student data decides whether they belong in the lawyer's picture:

| Key | Project | Created | Last used |
|---|---|---|---|
| `TatvaOS-School` | TatvaOS AI – Production | 1 Oct 2026 | 1 Oct 2026 |
| `techvein_transport` | Techvein-Transport | 17 Sept 2026 | 17 Sept 2026 |
| `Marketing-tool` | TatvaOS AI – Production | 2 Sept 2026 | 17 Sept 2026 |

## What changed so it cannot recur silently

- The account settings are recorded as part of what customers are told:
  `docs/runbooks/backup-and-restore.md`, "Provider settings" (PR 366). Any
  change to them goes to Mr. Singh first, like a privacy sentence.
- Every AI deploy note states that the sharing settings were checked off,
  and when (`docs/DEPLOY_RUNBOOK.md`, section 4, PR 366).
- The privacy page's retention sentence describes the present (PR 366); the
  past belongs in the notices.
- Key clean-up, ruled by Mr. Singh 1 Oct: one key per application in its own
  project, least permissions, every key expires (renewal dates in the
  runbook), unaccounted keys revoked, TatvaOS's keys rotated.

## Notices

On hold. When the lawyer's answer comes back, the wording must say plainly
that the content was available to OpenAI to improve its models, from when to
when, and that it has now stopped (Mr. Singh). Organisation 5's draft notice
waits with the rest.

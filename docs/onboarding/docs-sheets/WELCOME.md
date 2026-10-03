# Welcome to TatvaOS — you're taking Docs and Sheets

*Drafted 3 October 2026 by the session that built Docs' server rendering and the Sheets editor, for Mr. Singh to read and correct. Everything here was true on that date; check `main` and production before relying on it (house rule 6b).*

*Some paths below live on branches that had not merged on that date. They are marked: **(PR 370)** = `docs/pdf-design`, **(PR 379)** = `sheets/server-render-design`, **(PR 384)** = `docs/ai-privacy-wording`.*

Docs and Sheets are TatvaOS's collaborative documents and spreadsheets. Both are **Space files**: a document or spreadsheet *is* a file in Space, with Space's sharing, trash and stars. Both edit live through Yjs over a WebSocket (`DocsLiveHub`). They share the `docs.*` tables, the API routes (`DocsEndpoints`) and the live hub.

---

## 1. Where things are

| | |
|---|---|
| Docs editor | `apps/web/components/docs/`: `DocEditor.tsx`; the schema in `schema.ts` + `extensions.ts` (React-free, also run on the server) |
| Sheets editor | `apps/web/components/sheets/`, and the engine, model and `.xlsx` I/O in `apps/web/lib/sheets/` (imports only `yjs`) |
| API | `apps/api/Modules/Docs/`: `DocsEndpoints.cs` (both kinds; spreadsheets save through `/api/sheets/{id}/…`), `DocsLiveHub`, `DocsHtml.cs` (our own HTML sanitiser), `XlsxGuard.cs`, `DocsSwitch` / `SheetsSwitch` |
| Render service | `apps/render/`: Node 24, builds every Docs file **on the server** from the stored Yjs. A hardened container (`render` in `infra/docker/docker-compose.base.yml`, network `rendernet`, internal) |
| Schema | `local/postgres/init/20260924-docs-schema.sql`, `20260925-sheets-switch.sql`, `20260930-b-docs-rendered-by-server.sql` |

## 2. Decisions already made — do not re-open these

- **Decision 0011** (`docs/decisions/0011-*.md`), the conditions for customers:
  - **condition 1:** the file Space serves is built on the server from what the server stored, never the browser's copy. **Done for Docs** (PR 367, live 1 Oct).
  - **condition 2:** documents go by email as **PDF**, built on the server. Engine and gate done (`docs/DOCS_PDF_DESIGN.md`, `apps/render/pdf/`, `tests/docs-render/pdf-gate.*`, all **(PR 370)**), email wiring not.
  - **condition 4:** what storage drops is named, from a **closed list** (`apps/render/spike/storage-drops.mjs`). A new entry needs Mr. Singh's ruling.
- **"The same document", strictly** (Mr. Singh, 29–30 Sept). The gate (`apps/render/spike/gate.mjs`) compares the server's file with the editor *reloaded from storage*, and every difference from the first view must be on the closed list.
- **The render container** (Mr. Singh): no internet (red-first proved), no database, no secrets, non-root, read-only, 512 MB / 1 CPU / 64 processes, a 10 s cap that can only be lowered, base image pinned by digest. `tests/docs-render/container-test.sh` proves each, red first.
- **The PDF engine is Typst** (PR 370, ruled 1 Oct), with four conditions:
  - customer text is **data, never markup**;
  - a locked `--root`;
  - Alpine's own signed package (0.14.2 on Alpine 3.24), pinned;
  - inside the container's limits.

  There is **no headless Chromium**.
- **Sheets refuses switch-on** (409) until it builds its own `.xlsx` on the server (Amit, 30 Sept). Design: PR 379. **TODAY()/NOW() use India time** (Amit, 2 Oct).
- **Scripts in PDFs** (Amit, 1 Oct): English and Devanagari first, each checked by a person who reads it (`docs/DOCS_PDF_DESIGN.md` §9 records who). Other scripts are refused (`script_not_checked`) until checked.
- **Copy/search of Indian-script text from a PDF** is imperfect: Devanagari 48 of 49 words intact by `pdftotext`. Accepted for launch (Mr. Singh, 2 Oct), with a **ratchet** in the gate and the footer line *"Text in Indian scripts may not copy or search correctly from this PDF."* Typst 0.15.1 and the serif face don't fix it (measured 3 Oct).
- **Every AI feature is behind an organisation list that stays empty until its disclosure is live** (Mr. Singh, 30 Sept). Docs AI: wording drafted, PR 384. Sheets AI: none yet.
- **Deploys:** only the Mail session deploys (Amit, 2 Oct), through the Deploy production workflow after green CI on `main`.

## 3. What you're inheriting that isn't finished

| What | State | Waiting on |
|---|---|---|
| Docs for Techvein | **live**, switched on 1–2 Oct; first live document proven (built on the server, Space download matched the screen) | a real one-day trial by Techvein staff: none so far |
| PDF by email (PR 370) | gate **91/0** in CI on today's `main` | Mr. Singh's sign-off; a Hindi reader for `devanagari-sample.pdf`; then the email wiring (footer line included) |
| Sheets' server `.xlsx` (PR 379) | design (`docs/SHEETS_SERVER_RENDER_DESIGN.md`) and test workbooks (`tests/sheets-render/`), both **(PR 379)** | Mr. Singh's ruling, then the gate and the build |
| Docs AI (PR 384) | wording only (`docs/DOCS_AI_DISCLOSURE_PROPOSAL.md`, **(PR 384)**) | Mr. Singh; Amit's price per action |
| Other organisations | Docs is on for Techvein only | condition 2, and Amit |

## 4. Traps that have already cost someone a day

- **A planted calibration that doesn't compile tests the OLD binary.** `run-docs-live.sh` refuses a stale Release DLL; plant something that compiles (`if (id == Guid.Empty)`).
- **CI is not the laptop.** Things it found that the laptop hid: missing database roles on a fresh Postgres; `/var/lib/space` not writable; a timing test that measured the machine. Every test makes its own throwaway database (rule 13) and sizes its own load.
- **Docker Desktop shadows the WSL engine.** When it runs, `docker` in WSL silently talks to it. `container-test.sh` and `pdf-gate.sh` refuse it. Don't stop it yourself; it may be someone else's.
- **A green tick is not a result.** Read the log: one CI run was "green" with 0 steps (billing), and `gh run view --log` refuses while a run is in progress (use `gh api --allow-escape-sequences repos/…/actions/jobs/<id>/logs`).
- **A blank marker in `AiDisclosure.cs` closes the Mail AI offer button.**
- **Two copies of yjs don't share types.** Tests import `apps/web/node_modules/yjs/dist/yjs.mjs`.
- **Excel 2019 has no XLOOKUP/XMATCH.** The laptop's Excel is 2019-class; `#NAME?` there is not our file.
- **Git merges can be clean and wrong.** Merging PR 367 into Sheets silently routed spreadsheet *versions* through the Docs renderer. Read both sides of any merge in `DocsEndpoints.cs`.
- **Bash heredocs mangle backslashes.** Write patch scripts to a file.

## 5. How to check your work

| | |
|---|---|
| Render service | `cd apps/render && node --import ./src/register.mjs --test test/*.test.mjs` |
| The "same document" gate | `node --import ./spike/register.mjs spike/gate.mjs` |
| Docs end to end (own DB) | `bash tests/docs/run-docs-live.sh` (after `dotnet build -c Release apps/api`) |
| Docs switch, as production | `Docs__RefuseSwitchOnInDevelopment=true DOCS_TEST=tests/docs/docs-switch-production.test.mjs bash tests/docs/run-docs-live.sh` |
| Render container | `wsl -u root -e bash tests/docs-render/container-test.sh` |
| PDF gate **(PR 370)** | `wsl -u root -e bash tests/docs-render/pdf-gate.sh` (runs in CI too, with sample PDFs as artifacts) |
| Sheets unit / e2e | `node --import ./tests/sheets/register.mjs --test tests/sheets/*.test.ts`; e2e via `DOCS_TEST=tests/sheets/sheets-live.e2e.ts` with `SHEETS_API` and `NODE_OPTIONS=--import …/tests/sheets/register.mjs` |
| XlsxGuard / real Excel | `OURS=<dir> dotnet run --project tests/sheets-xlsx-guard -c Release`; `pwsh tests/sheets-xlsx-guard/excel-check.ps1 <dir>` |
| Production, read-only | the render log (`docker logs tatvaos-render-1`: `doc 200 … ms=`, sizes only); the API log for `Docs save FAILED` |

## 6. How we talk to each other

As every lane: Amit decides product questions; Mr. Singh rules on design, review and the house rules; findings go to them as a list naming who owns each item.

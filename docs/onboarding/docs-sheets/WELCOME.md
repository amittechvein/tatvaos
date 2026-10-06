# Welcome to TatvaOS — you're taking Docs and Sheets

*Drafted 3 October 2026 by the session that built Docs' server rendering and the Sheets editor; **refreshed 6 October 2026** (round two). Everything here was true on that date; check `main` and production before relying on it (house rule 6b).*

*Some paths below live on branches not yet merged on that date. They are marked with their pull request: **(PR 370)** PDF engine `docs/pdf-design`, **(PR 379)** Sheets design `sheets/server-render-design`, **(PR 384)** Docs AI wording `docs/ai-privacy-wording`, **(PR 388)** Docs AI prices `docs/ai-price-per-action`, **(PR 390 / 391 / 393)** the Sheets server build, stacked on 379, **(PR 387)** the older-Excel hint `sheets/older-excel-hint`.*

Docs and Sheets are TatvaOS's collaborative documents and spreadsheets. Both are **Space files**: a document or spreadsheet *is* a file in Space, with Space's sharing, trash and stars. Both edit live through Yjs over a WebSocket (`DocsLiveHub`). They share the `docs.*` tables, the API routes (`DocsEndpoints`) and the live hub.

---

## 1. Where things are

| | |
|---|---|
| Docs editor | `apps/web/components/docs/`: `DocEditor.tsx`; the schema in `schema.ts` + `extensions.ts` (React-free, also run on the server) |
| Sheets editor | `apps/web/components/sheets/`, and the engine, model and `.xlsx` I/O in `apps/web/lib/sheets/` (imports only `yjs`) |
| API | `apps/api/Modules/Docs/`: `DocsEndpoints.cs` (both kinds; spreadsheets save through `/api/sheets/{id}/…`), `DocsLiveHub`, `DocsRenderClient.cs`, `DocsHtml.cs` (our own HTML sanitiser), `XlsxGuard.cs`, `DocsSwitch` / `SheetsSwitch` |
| Render service | `apps/render/`: Node 24, builds every Docs file **on the server** from the stored Yjs (`POST /render/doc`). The spreadsheet route `POST /render/sheet` is **(PR 390)**. A hardened container (`render` in `infra/docker/docker-compose.base.yml`, network `rendernet`, internal) |
| The Docs address | `docs.tatvaos.com`: `infra/docker/caddy/conf.d/docs.caddy` (live since 4 Oct). Only `/docs` comes here; `/sheets` has no door yet |
| Schema | `local/postgres/init/20260924-docs-schema.sql`, `20260925-sheets-switch.sql`, `20260930-b-docs-rendered-by-server.sql` |

## 2. Decisions already made — do not re-open these

- **Decision 0011** (`docs/decisions/0011-*.md`), the conditions for customers:
  - **condition 1:** the file Space serves is built on the server from what the server stored, never the browser's copy. **Done for Docs** (PR 367, live 1 Oct). **Built for Sheets** in PRs 390 → 391 → 393, not yet merged.
  - **condition 2:** documents go by email as **PDF**, built on the server. Engine and gate done (`docs/DOCS_PDF_DESIGN.md`, `apps/render/pdf/`, `tests/docs-render/pdf-gate.*`, all **(PR 370)**), email wiring not.
  - **condition 4:** what storage drops is named, from a **closed list** (`apps/render/spike/storage-drops.mjs`). A new entry needs Mr. Singh's ruling.
- **Who sees Docs:** Techvein only (Amit, 4 Oct). **Nothing in Docs or Sheets goes to another customer without Mr. Singh and Amit.** The one-day staff trial was skipped on Amit's decision (4 Oct): nobody had used it.
- **"The same document", strictly** (Mr. Singh, 29–30 Sept). The gate (`apps/render/spike/gate.mjs`) compares the server's file with the editor *reloaded from storage*, and every difference from the first view must be on the closed list.
- **The render container** (Mr. Singh): no internet (red-first proved), no database, no secrets, non-root, read-only, 512 MB / 1 CPU / 64 processes, a 10 s cap that can only be lowered, base image pinned by digest. `tests/docs-render/container-test.sh` proves each, red first.
- **The PDF engine is Typst** (PR 370, ruled 1 Oct), with four conditions:
  - customer text is **data, never markup**;
  - a locked `--root`;
  - Alpine's own signed package (0.14.2 on Alpine 3.24), pinned;
  - inside the container's limits.

  There is **no headless Chromium**.
- **Sheets refuses switch-on** (409) until it builds its own `.xlsx` on the server (Amit, 30 Sept), and the gate is what keeps it off: **never add an organisation to a list to make a test pass.** Design: PR 379. **TODAY()/NOW() use India time** (Amit, 2 Oct; the render image sets `TZ=Asia/Kolkata`).
- **The older-Excel hint** (XLOOKUP and five other newer functions show `#NAME?` in Excel 2019): **yes** (Amit 3 Oct; Mr. Singh 6 Oct). PR 387.
- **Scripts in PDFs** (Amit, 1 Oct): English and Devanagari first, each checked by a person who reads it (`docs/DOCS_PDF_DESIGN.md` §9 records who). Other scripts are refused (`script_not_checked`) until checked.
- **Copy/search of Indian-script text from a PDF** is imperfect: Devanagari 48 of 49 words intact by `pdftotext`. Accepted for launch (Mr. Singh, 2 Oct), with a **ratchet** in the gate and the footer line *"Text in Indian scripts may not copy or search correctly from this PDF."* Typst 0.15.1 and the serif face don't fix it (measured 3 Oct).
- **Every AI feature is behind an organisation list that stays empty until its disclosure is live** (Mr. Singh, 30 Sept). The gate works: on its first use it caught Sheets AI sending while unlisted. Docs AI: wording in PR 384; one label and price per action in PR 388 (the price is Amit's, still open). Sheets AI: no disclosure yet. **Personal accounts can't use Docs AI at all**: their plan check allows only meeting minutes.
- **Deploys:** one session deploys (the Mail session since 2 Oct), through the Deploy production workflow, after green CI on the exact commit, Amit's go and no live Connect meeting. You don't deploy unless Amit says so for one deploy (this session did once, on 4 Oct, for `docs.tatvaos.com`).

## 3. What you're inheriting that isn't finished

| What | State | Waiting on |
|---|---|---|
| Docs for Techvein | **live**, on `docs.tatvaos.com` since 4 Oct; a typed line saved and built on the server on 5 Oct | nothing; other organisations need Mr. Singh and Amit |
| PDF by email (PR 370) | gate **91/0** in CI on `main` of 6 Oct | Mr. Singh's sign-off; a Hindi reader for `devanagari-sample.pdf`; then the email wiring (footer line included) |
| Docs AI (PRs 384, 388) | wording, and per-action labels at 1 / 1 / 1 / 5 credits | Mr. Singh on the wording; **Amit on the price** (a one-line change either way) |
| Sheets' server `.xlsx` (PRs 379 → 390 → 391 → 393) | design, test workbooks and all three build stages; green, clicked through on a laptop | Mr. Singh's reading. **391 and 393 merge together**: 391 alone makes a spreadsheet created from a template or an imported file arrive empty. Then a deploy, three production checks and a one-line switch PR |
| Older-Excel hint (PR 387) | built, green | Mr. Singh's read of the sentence |

## 4. Traps that have already cost someone a day

- **A planted calibration that doesn't compile tests the OLD binary.** `run-docs-live.sh` refuses a stale Release DLL; plant something that compiles (`if (id == Guid.Empty)`).
- **CI is not the laptop.** Things it found that the laptop hid: missing database roles on a fresh Postgres; `/var/lib/space` not writable; a timing test that measured the machine; a child process inheriting CI's `NODE_OPTIONS` with a path relative to the repository root. Every test makes its own throwaway database (rule 13) and sizes its own load.
- **Every tenant-owned table needs an EF query filter** (`tests/tenant-filters`, in CI since 6 Oct). All seven Docs and Sheets tables have one. If it ever flags a Docs or Sheets table, **don't file it yourself**: bring Mr. Singh the facts (`tenant_id`? RLS? who reads it, and what scopes the read) and a recommendation.
- **Docker Desktop shadows the WSL engine.** When it runs, `docker` in WSL silently talks to it. `container-test.sh` and `pdf-gate.sh` refuse it. Don't stop it yourself; it may be someone else's.
- **A green tick is not a result.** Read the log: one CI run was "green" with 0 steps (billing), and `gh run view --log` refuses while a run is in progress (use `gh api --allow-escape-sequences repos/…/actions/jobs/<id>/logs`). A green from before `main` moved is not green on today's merge.
- **A push can fail quietly in a batch** ("…and the repository exists"). Compare `origin/<branch>` with your local branch after every push.
- **A blank marker in `AiDisclosure.cs` closes the Mail AI offer button.**
- **Two copies of yjs don't share types.** Tests import `apps/web/node_modules/yjs/dist/yjs.mjs`; the render service's loader always takes `yjs` from `apps/render`.
- **Time zones by name lie.** Node's ICU data names India time `Asia/Calcutta`; check the date and the offset (`-330`), not the name.
- **Excel 2019 has no XLOOKUP/XMATCH.** The laptop's Excel is 2019-class; `#NAME?` there is not our file.
- **Git merges can be clean and wrong.** Merging PR 367 into Sheets silently routed spreadsheet *versions* through the Docs renderer. Read both sides of any merge in `DocsEndpoints.cs`, and build after every merge.
- **Bash heredocs mangle backslashes.** Write patch scripts to a file.

## 5. How to check your work

| | |
|---|---|
| Render service | `cd apps/render && node --import ./src/register.mjs --test test/*.test.mjs` |
| The "same document" gate | `node --import ./spike/register.mjs spike/gate.mjs` |
| Docs end to end (own DB) | `bash tests/docs/run-docs-live.sh` (after `dotnet build -c Release apps/api`) |
| Docs switch, as production | `Docs__RefuseSwitchOnInDevelopment=true DOCS_TEST=tests/docs/docs-switch-production.test.mjs bash tests/docs/run-docs-live.sh` |
| Tenant filters | `dotnet run --project tests/tenant-filters -c Release` (last line is the verdict) |
| Render container | `wsl -u root -e bash tests/docs-render/container-test.sh` |
| PDF gate **(PR 370)** | `wsl -u root -e bash tests/docs-render/pdf-gate.sh` (runs in CI too, with sample PDFs as artifacts) |
| Sheets unit / e2e | `node --import ./tests/sheets/register.mjs --test tests/sheets/*.test.ts`; e2e via `DOCS_TEST=tests/sheets/sheets-live.e2e.ts` with `SHEETS_API` and `NODE_OPTIONS=--import …/tests/sheets/register.mjs` (the e2e starts its own render service from **(PR 391)** on) |
| XlsxGuard / real Excel | `OURS=<dir> dotnet run --project tests/sheets-xlsx-guard -c Release`; `pwsh tests/sheets-xlsx-guard/excel-check.ps1 <dir>` |
| Production, read-only | the render log (`docker logs tatvaos-render-1`: `doc 200 … ms=`, sizes only); the API log for `Docs save FAILED`. Database reads need Amit's go each time, counts only |

## 6. How we talk to each other

As every lane: Amit decides product questions; Mr. Singh rules on design, review and the house rules; findings go to them as a list naming who owns each item. Anything touching auth, tenancy, a migration, `deploy.sh`, `verify-live.sh` or CI goes to Mr. Singh small and on its own.

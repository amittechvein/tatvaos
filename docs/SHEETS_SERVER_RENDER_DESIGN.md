# Sheets: the `.xlsx` built on the server — design

**Status: proposal, 2 October 2026. Nothing built.** For Mr. Singh's ruling
before any build, as Docs had (`docs/DOCS_SERVER_RENDER_DESIGN.md`).

## 1. Why

Today a spreadsheet's `.xlsx`, its HTML (version history) and its text
(search) are what the **browser** wrote. The server checks the `.xlsx` with
XlsxGuard and stores it (`DocsEndpoints.SheetCheckpointAsync`). That is the
browser-trusting path decision 0011 condition 1 ended for Docs.

- **Amit, 30 Sept:** Sheets refuses switch-on until its own server-built `.xlsx` exists. This was enforced by `SheetsSwitch.ServerRenderLanded = false` (409 `sheets_before_render`) until the switch-on PR, opened 8 Oct after round two deployed (13148ba) and `/render/sheet` was checked in production's render container.
- **Mr. Singh:** the same rules as Docs, plus XlsxGuard on the server's own `.xlsx`.

## 2. What the server does: what the browser does today, from what the server stored

Measured on `main` (1 Oct): **`apps/web/lib/sheets/` imports nothing but `yjs`.**
- It has its own zip writer, which uses `CompressionStream`, built into Node 24.
- It has its own XML parser, written because Node has no `DOMParser`.
- The Sheets end-to-end test already runs the real model and the real `.xlsx` writer and reader in Node.

So the render service can run the **same code the editor runs**, unchanged, as Docs runs the editor's own schema.

The browser's checkpoint today (`SheetEditor.tsx`) is `snap = model.snapshot()`, then `writeXlsx(snap)`, `workbookHtml(snap, locale)` and `workbookText(snap, locale)`. The server does exactly that, from its own merged state:

```
updates (stored state + every stored update)
  → Y.mergeUpdates → Y.Doc
  → new SheetsModel(doc)           formulas calculate as values are read
  → snap = model.snapshot()
  → writeXlsx(snap), workbookHtml(snap, locale), workbookText(snap, locale)
```

Nothing from the browser is used: not its state, not its `.xlsx`, not its HTML or text.

## 3. The pieces

| Where | Change |
|---|---|
| **Render service** | New route `POST /render/sheet`, same body as `/render/doc`. Same worker pool, same 10 s cap (`504` past it), logs sizes and times only. Returns `{state, xlsx, html, text, schema: 'sheets-1'}`. |
| **Render image** | Copies `apps/web/lib/sheets/` (pure TypeScript, about 200 KB). No new packages: `register.mjs` already resolves its extension-less imports. |
| **API** | `SheetCheckpointAsync` and `SheetVersionAsync` take Docs' shape exactly: snapshot under the room lock, build outside it, write only if built from a later point than the stored file (`RenderedSeq`; an older build never overwrites a newer file). A failed build returns `503 render_failed`, which the editor shows and retries. |
| **XlsxGuard** | Runs on the **server's own** `.xlsx` before it is stored, as Mr. Singh ruled. Our writer never produces what it refuses, so a refusal means a writer bug: logged by reason and refused, never stored. |
| **Browser** | `checkpointSheet` sends `{upToSeq}` only; versions send `{kind, name}`. The fields the browser used to send are accepted and ignored until a dated removal, as with Docs. |
| **Switch** | `SheetsSwitch.ServerRenderLanded` turns true in its own one-line PR, after the deploy and three production checks, as with Docs. The browser-written-files guard applies to spreadsheets too. Production should hold none, because Sheets has never been switchable on; one read-only count confirms it: `docs.browser_written_count(<organisation>)` = 0, run for each organisation just before its Sheets switch goes on (the Sheets switch has no guard of its own). |

## 4. One product decision: the time zone of TODAY() and NOW()

The engine's clock is injectable (`Engine({ now })`), but dates are read in the **process's** time zone, and the render container runs on **UTC**. Built on the server, a sheet saved at 01:00 in India would store **yesterday's date** for TODAY(), until the next save after 05:30. In the browser it uses the viewer's own zone.

**Decided (Amit, 2 Oct 2026): India time.** `TZ=Asia/Kolkata` for the render container. Every customer today is Indian; a per-organisation time zone can come later, if a customer outside India arrives. The gate checks it: a TODAY() fixture built at 00:30 IST must show that day's date, not the day before.

Volatile functions (TODAY, NOW, RAND) are recalculated at each server build, so the stored file shows the time of the **save**, as Excel does on open.

## 4a. Older Excel: a one-line hint on download

**Decided (Amit, 3 Oct 2026, on Mr. Singh's advice): yes.**

Six functions the editor supports are newer than Excel 2019. Our file stores them correctly (`_xlfn.XLOOKUP`). Older Excel still doesn't know them and shows `#NAME?` in those cells. This laptop's Excel is 2019-class, and it did exactly that: the one miss in the real-Excel check (29/1) was XLOOKUP.

| Function | Needs |
|---|---|
| XLOOKUP, XMATCH | Excel 2021 or Microsoft 365 |
| CHOOSECOLS, CHOOSEROWS, REGEXEXTRACT, REGEXREPLACE | Microsoft 365 |

- **What changes:** when someone chooses *Download as Excel (.xlsx)* and the workbook uses any of these, the download shows one line naming the functions it found. The file itself does not change.
- **Wording, ruled by Mr. Singh on 7 Oct 2026 (approved as it stands):** "This workbook uses XLOOKUP. It works in Excel 2021 and Microsoft 365; older Excel shows #NAME? in those cells." When a Microsoft 365-only function is used, the sentence names Microsoft 365 alone.
- **Where the list lives:** next to `XLFN` in `lib/sheets/io/xlsx.ts`. A unit test fails if the engine gains a prefixed function that is in neither the "fine in Excel 2019" list nor this one, so a new function can't skip the hint.
- **Test:** a workbook with XLOOKUP gets the hint naming it; one without gets none. Calibrated: with the list emptied, the first test fails.
- It is a separate small PR from the server build, and can go first.

## 5. The gate, before anything ships (same discipline as Docs)

1. **The same workbook.** For every fixture, the server's `.xlsx` read back with our reader equals what the editor's own path writes for the same state: cell inputs, values, formats, merges, column widths and sheet order.
   - Fixtures: formulas of every family, multiple sheets, merges, number and date formats, Hindi text, a 20,000-cell sheet.
   - Calibrated: one changed cell is caught.
2. **A colleague's edit.** A stored update the saving browser never saw *is* in the server's file. The control: without it, the check fails. This is the core of condition 1.
3. **Real Excel opens it.** `tests/sheets-xlsx-guard/excel-check.ps1` on the laptop: every fixture opens with macros off, and its values match.
4. **XlsxGuard passes the server's own files**, and still refuses the attack corpus (61/0 today).
5. **Inside the container's limits.** The largest fixture builds within 10 s and 512 MB on 1 CPU. The container test's no-internet and read-only checks apply unchanged.

## 6. What it does not change

- The editor, formulas, Excel import and the Sheets AI.
- The `/api/sheets/{id}/…` routes: same addresses, new behaviour behind them.
- Docs.

## 7. Decisions needed

**For Amit:**
- ~~Time zone~~: **decided 2 Oct: India time** (`TZ=Asia/Kolkata`).
- ~~Older Excel hint~~: **decided 3 Oct: yes** (§4a), on Mr. Singh's advice.

**For Mr. Singh:**

2. **Approach:** the render service runs the editor's own Sheets code (proposed), as it runs the Docs schema.
3. **The gate in §5**, especially check 2 (a colleague's unseen edit) as condition 1's proof for Sheets.
4. **XlsxGuard on the server's own `.xlsx`:** refuse and log on a hit (proposed), treated as a writer bug, never stored.
5. ~~**The hint's wording** in §4a~~: **ruled 7 Oct 2026, approved as it stands** (it names what, where it works, and what the person will see, in that order).

## 8. Before switch-on: what PDFs and spreadsheets do to Docs saves in the same container

**Mr. Singh, 6–7 Oct 2026.** No live risk today: Sheets is off and nothing calls `/render/pdf`. It's a **switch-on condition for both Sheets and PDF**, not a blocker on anything merging.

*First written 6 Oct as a worker-pool question. Corrected 7 Oct by Mr. Singh (reading the 370/390 resolution): the PDF path is the constraint, not the pool. Then a third finding from him: one request is enough.*

**The facts, read from the code and compose on 7 Oct:**
- **Render workers:** 2 by default (`RENDER_WORKERS ?? 2`, capped at 4), one FIFO queue, no priority, a 10 s limit per job. The API waits 12 s for any render (`DocsRenderClient.Timeout`).
- **A PDF holds a worker only for its render phase.** The worker goes back to the pool (`server.mjs`, `idle.push(w)`) *before* Typst starts. Typst then runs as a child process of the server, and **nothing limits how many run at once.**
- **Each PDF job writes its document and pictures into a folder under `/tmp`** (`render-pdf.mjs`, `mkdtemp`). In the container `/tmp` is a **16 MB tmpfs**, which counts against memory.
- **The request body limit is 48 MB** (`MAX_BODY`). That's about **36 MB of pictures** once decoded, **more than twice what `/tmp` holds**, in one request the service accepts as valid. The picture cap is **500 pictures of any size**, which bounds nothing that matters.
- **A failed picture write throws a plain `ENOSPC`, not a `PdfFailed`.** So the server answers the generic `500 pdf_failed`, and the person reads only "The PDF could not be built".
- **The container's limits:** 512 MB of memory, **one CPU**, 64 processes and threads (`pids_limit`). The two render workers were never really parallel, and every Typst process competes for the same CPU. The 10 s deadline covers render **and** Typst together.

**The exposure, in order of harm:**
1. **Out of memory:** many Typst processes, fonts in each, pictures in `/tmp`, inside 512 MB. If the container is killed for memory, **it takes Techvein's Docs saves down with it.** One CPU mitigates this: ten Typst processes make slow progress rather than all allocating at once.
2. **The process cap: silent and persistent** (the worst kind). If Typst's threads exhaust the 64, a render worker killed at the 10 s limit may not be replaceable. **The pool shrinks and stays shrunk until a restart**, degrading Techvein's saves long after the burst is gone. Nobody would connect the two. *A hypothesis, to prove or disprove first among the concurrent cases.*
3. **`/tmp` full, from ONE request:** a newsletter with a few dozen photographs fills 16 MB. No burst is needed.
4. **Timeouts:** with one CPU, a PDF built while two renders run has about a third of a CPU and 10 s for render and Typst together. Timeouts will show up long before memory does.
5. **Queueing:** long spreadsheet builds and PDF renders hold both workers, and a document save waits past the API's 12 s.

**Measured, not reasoned, in the hardened container** (`tests/docs-render/container-test.sh`'s compose, its real limits), **in this order:**
0. **ONE PDF request with many pictures.** Real-sized photographs: how many before `/tmp` is full, the peak memory, and what the request is told. *If one request can do it, the concurrent numbers measure the wrong thing first.*
1. **The process-cap hypothesis:** Typst processes running, a render worker killed at the 10 s limit. Does its replacement start, and is the pool still two afterwards?
2. **Concurrent PDF builds, 2, 5 and 10 at once, with pictures:** peak memory, peak `/tmp`, peak process/thread count, and every request's answer, timeouts included.
3. **A Docs save sent during 2:** its time to answer and its result.
4. **Both workers busy with the longest jobs** (a 20,000-cell sheet, a PDF render), then a Docs save, at `RENDER_WORKERS` 2, 3 and 4.

**Then fix the inconsistency, not just measure it:**
- **The limits.** Bring the PDF route's body limit under what `/tmp` holds, give `/tmp` room for the body limit, or cap pictures by **total size** instead of count. Mr. Singh prefers a total-size cap plus a smaller PDF-route body limit; the measured sizes decide.
- **What limits concurrent Typst processes**, and what a request gets at that limit: a clear "busy, try again", never a dead container. Mr. Singh's instinct is a small semaphore and a queue in `buildPdf`. Measure before building it.
- **Fix regardless of the numbers: the refusal a person can act on.** A full `/tmp` (`ENOSPC` while writing pictures) gets **its own reason code and sentence**, e.g. *"This document has too many pictures, or pictures too large, to make a PDF. Remove some and try again."*, instead of the generic `pdf_failed`. A refusal a person can act on is worth more than a correct 500. **Proven in the hardened container**, whose `/tmp` really is 16 MB.

Rulings: Mr. Singh. Anything needing more capacity (cost): Amit. It sits on the switch-on checklist beside the AI-lists line and the personal-table audit.

*(Mr. Singh, on the container itself: non-root, read-only, no capabilities, no-new-privileges, its own network, and CPU, memory and process caps. Every exposure above exists because the boundaries are drawn tightly; a container without limits would have worse problems, found later and by a customer.)*

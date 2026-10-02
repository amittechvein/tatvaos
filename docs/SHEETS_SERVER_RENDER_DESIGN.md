# Sheets: the `.xlsx` built on the server — design

**Status: proposal, 2 October 2026. Nothing built.** For Mr. Singh's ruling
before any build, as Docs had (`docs/DOCS_SERVER_RENDER_DESIGN.md`).

## 1. Why

Today a spreadsheet's `.xlsx`, its HTML (version history) and its text
(search) are what the **browser** wrote. The server checks the `.xlsx` with
XlsxGuard and stores it (`DocsEndpoints.SheetCheckpointAsync`). That is the
browser-trusting path decision 0011 condition 1 ended for Docs.

- **Amit, 30 Sept:** Sheets refuses switch-on until its own server-built `.xlsx` exists. This is enforced by `SheetsSwitch.ServerRenderLanded = false` (live, 409 `sheets_before_render`).
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
| **Switch** | `SheetsSwitch.ServerRenderLanded` turns true in its own one-line PR, after the deploy and three production checks, as with Docs. The browser-written-files guard applies to spreadsheets too. Production should hold none, because Sheets has never been switchable on; one read-only count confirms it. |

## 4. One product decision: the time zone of TODAY() and NOW()

The engine's clock is injectable (`Engine({ now })`), but dates are read in the **process's** time zone, and the render container runs on **UTC**. Built on the server, a sheet saved at 01:00 in India would store **yesterday's date** for TODAY(), until the next save after 05:30. In the browser it uses the viewer's own zone.

**Proposal:** set `TZ=Asia/Kolkata` for the render container. Every customer today is Indian. A per-organisation time zone can come later, if a customer outside India arrives. *Amit's call.*

Volatile functions (TODAY, NOW, RAND) are recalculated at each server build, so the stored file shows the time of the **save**, as Excel does on open.

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
1. **Time zone:** fix TODAY()/NOW() to India time on the server (proposed), or something else?

**For Mr. Singh:**

2. **Approach:** the render service runs the editor's own Sheets code (proposed), as it runs the Docs schema.
3. **The gate in §5**, especially check 2 (a colleague's unseen edit) as condition 1's proof for Sheets.
4. **XlsxGuard on the server's own `.xlsx`:** refuse and log on a hit (proposed), treated as a writer bug, never stored.

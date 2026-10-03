// ============================================================================
//  The file Space serves for a spreadsheet, built from what the server stored
// ============================================================================
//
//  docs/SHEETS_SERVER_RENDER_DESIGN.md (PR 379). The same rule as Docs
//  (decision 0011 condition 1): the input is the spreadsheet's stored Yjs
//  state and every stored update after it. Nothing the browser claims is
//  used: not its .xlsx, not its HTML, not its text, not its state.
//
//  It runs the EDITOR'S OWN code, unchanged: apps/web/lib/sheets imports
//  nothing but yjs (its own zip writer on CompressionStream, its own XML
//  parser), so this is exactly what SheetEditor's checkpoint does, from the
//  server's data instead of the browser's:
//
//    new SheetsModel(doc) → snapshot() → writeXlsx / workbookHtml / workbookText
//
//  TODAY() and NOW() read the process's time zone. The container runs with
//  TZ=Asia/Kolkata (Amit, 2 Oct 2026), so a save at 00:30 in India stores
//  that day's date, not the day before. Volatile functions are worked out
//  afresh at every build: the stored file shows the time of the save.
//
//  Output:
//    state   the merged state (state + updates), to store in its place
//    xlsx    the workbook file
//    html    every sheet as an HTML table (version history)
//    text    the plain text (search, AI), cut at 2,000,000 characters as the
//            editor's checkpoint cut it
//    sheets, cells   counts, for the log line (never content)
// ============================================================================

import * as Y from 'yjs';
import { SheetsModel } from '../../web/lib/sheets/model.ts';
import { writeXlsx } from '../../web/lib/sheets/io/xlsx.ts';
import { workbookHtml, workbookText } from '../../web/lib/sheets/render.ts';

export const SHEETS_SCHEMA_VERSION = 'sheets-1';
const MAX_TEXT = 2_000_000;

/**
 * @param {Uint8Array[]} updates the stored state first, then every stored update after it
 */
export async function renderSheet(updates) {
  if (!Array.isArray(updates) || updates.length === 0) throw new RangeError('no updates');
  const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
  const doc = new Y.Doc();
  let model = null;
  try {
    Y.applyUpdate(doc, merged);
    model = new SheetsModel(doc);
    // A spreadsheet with no sheet is not one the editor wrote: the editor
    // seeds a first sheet before anything is stored (model.ensureSeeded).
    if (model.sheetIds().length === 0) throw new RangeError('no sheets');
    const snap = model.snapshot();
    const locale = model.locale();
    const xlsx = await writeXlsx(snap);
    let cells = 0;
    for (const s of snap.sheets) cells += s.cells.size;
    return {
      state: Y.encodeStateAsUpdate(doc),
      xlsx,
      html: workbookHtml(snap, locale),
      text: workbookText(snap, locale).slice(0, MAX_TEXT),
      sheets: snap.sheets.length,
      cells,
      schema: SHEETS_SCHEMA_VERSION,
    };
  } finally {
    model?.destroy();
    doc.destroy();
  }
}

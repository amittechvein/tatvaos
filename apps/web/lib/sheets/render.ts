// ============================================================================
//  A spreadsheet as HTML and as text — for the checkpoint.
//
//  The HTML is what version history keeps beside each version (it detects
//  "nothing changed"); the text is what search and AI read without a
//  browser in the loop. Neither is ever rendered back inside the app: a
//  version is previewed by rebuilding it from its Yjs state. Everything is
//  escaped anyway, because the server treats what a browser sends as
//  untrusted and so should anything that writes it.
// ============================================================================

import { formatValue } from './engine/format';
import { colName } from './engine/address';
import type { Locale } from './engine/types';
import { parseCellKey, type WorkbookData } from './workbook';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Cap on what one checkpoint describes; a sheet past this is summarised by its first rows. */
const MAX_TEXT_CELLS = 200_000;

export function workbookHtml(wb: WorkbookData, locale: Locale): string {
  const parts: string[] = [];
  let budget = MAX_TEXT_CELLS;
  for (const s of wb.sheets) {
    const grid = new Map<number, Map<number, string>>();
    let lastRow = -1; let lastCol = -1;
    for (const [k, cell] of s.cells) {
      if (cell.input === null) continue;
      const [r, c] = parseCellKey(k);
      const shown = formatValue(cell.value ?? null, cell.format?.nf, locale).text;
      if (!grid.has(r)) grid.set(r, new Map());
      grid.get(r)!.set(c, shown);
      lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c);
    }
    parts.push(`<h2>${esc(s.name)}</h2>`);
    if (lastRow < 0) { parts.push('<p>(empty)</p>'); continue; }
    parts.push('<table>');
    for (let r = 0; r <= lastRow && budget > 0; r += 1) {
      parts.push('<tr>');
      for (let c = 0; c <= lastCol; c += 1) {
        budget -= 1;
        parts.push(`<td>${esc(grid.get(r)?.get(c) ?? '')}</td>`);
      }
      parts.push('</tr>');
    }
    parts.push('</table>');
  }
  return parts.join('');
}

/** Every sheet as tab-separated text, headed by its name. For search and AI. */
export function workbookText(wb: WorkbookData, locale: Locale): string {
  const out: string[] = [];
  for (const s of wb.sheets) {
    out.push(`# ${s.name}`);
    out.push(rangeText(wb, s.name, locale));
  }
  return out.join('\n');
}

function rangeText(wb: WorkbookData, sheetName: string, locale: Locale): string {
  const s = wb.sheets.find((x) => x.name === sheetName);
  if (!s) return '';
  const rows = new Map<number, Map<number, string>>();
  let lastCol = -1;
  for (const [k, cell] of s.cells) {
    if (cell.input === null) continue;
    const [r, c] = parseCellKey(k);
    if (!rows.has(r)) rows.set(r, new Map());
    rows.get(r)!.set(c, formatValue(cell.value ?? null, cell.format?.nf, locale).text.replace(/[\t\n]/g, ' '));
    lastCol = Math.max(lastCol, c);
  }
  const lines: string[] = [];
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const cells: string[] = [];
    for (let c = 0; c <= lastCol; c += 1) cells.push(rows.get(r)!.get(c) ?? '');
    lines.push(cells.join('\t').replace(/\t+$/, ''));
  }
  return lines.join('\n');
}

/**
 * A range for AI: column letters as a heading row, then each row prefixed
 * with its row number, so an answer can say "rows 14 and 22".
 */
export function rangeForAi(
  get: (r: number, c: number) => string, r1: number, c1: number, r2: number, c2: number, maxChars = 190_000,
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push(['', ...Array.from({ length: c2 - c1 + 1 }, (_, j) => colName(c1 + j))].join('\t'));
  let size = lines[0]!.length;
  for (let r = r1; r <= r2; r += 1) {
    const cells = [String(r + 1)];
    for (let c = c1; c <= c2; c += 1) cells.push(get(r, c).replace(/[\t\n]/g, ' '));
    const line = cells.join('\t');
    size += line.length + 1;
    if (size > maxChars) return { text: lines.join('\n'), truncated: true };
    lines.push(line);
  }
  return { text: lines.join('\n'), truncated: false };
}

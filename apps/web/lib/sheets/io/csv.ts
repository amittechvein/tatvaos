// ============================================================================
//  CSV and TSV import and export.
//
//  Reading: RFC 4180 plus what real files do — a UTF-8 byte-order mark at
//  the start, CRLF or LF or CR line ends, quoted fields with "" for a quote
//  and newlines inside, and a delimiter that is guessed when not given
//  (comma, tab or semicolon: whichever splits the first lines most evenly).
//  Each field becomes a cell input exactly as written, so "1,25,000" and
//  "24/09/2026" are read by the app the same way as if typed. Two
//  exceptions, both to keep a field as the text it was:
//    - a field starting with '=' is NOT turned into a formula. A CSV is data,
//      often from someone else; a formula in it could fetch URLs or leak
//      other cells. It comes in as text, marked with a leading apostrophe.
//    - a field starting with an apostrophe gets one more, so it stays literal.
//
//  Writing: one sheet, values not formulas — each cell's calculated value
//  when known, else its input. Fields are quoted only when they must be.
//  Lines end in CRLF, as RFC 4180 and Excel expect.
//
//  The sheet is always named "Sheet1"; the caller renames it.
// ============================================================================

import { MAX_COLS, MAX_ROWS } from '../engine/address';
import { isError } from '../engine/types';
import { numberToText } from '../engine/values';
import { csvSafeText } from './safety';
import { DEFAULT_COLS, DEFAULT_ROWS, cellKey, parseCellKey, type SheetData } from '../workbook';

type Delimiter = ',' | '\t' | ';';

/** Split CSV text into records of fields. Stops after `limit` records when given. */
function parseRecords(text: string, delim: string, limit = Infinity): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let atFieldStart = true;
  // True once the current record has any content, so a final newline does not add an empty record.
  let pending = false;

  while (i < n) {
    const ch = text[i]!;
    if (atFieldStart && ch === '"') {
      // A quoted field: runs to the next lone quote.
      i += 1;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) { field += text.slice(i); i = n; break; }
        field += text.slice(i, q);
        if (text[q + 1] === '"') { field += '"'; i = q + 2; continue; }
        i = q + 1;
        break;
      }
      atFieldStart = false;
      pending = true;
      continue;
    }
    if (ch === delim) {
      record.push(field); field = ''; atFieldStart = true; pending = true; i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      record.push(field); records.push(record);
      record = []; field = ''; atFieldStart = true; pending = false;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (records.length >= limit) return records;
      continue;
    }
    field += ch;
    atFieldStart = false;
    pending = true;
    i += 1;
  }
  if (pending || field !== '') { record.push(field); records.push(record); }
  return records;
}

/** Pick the delimiter that gives the most, and most consistent, columns in the first lines. */
function detectDelimiter(text: string): Delimiter {
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';'] as Delimiter[]) {
    const recs = parseRecords(text, d, 10).filter((r) => r.length > 1 || r[0] !== '');
    const first = recs[0]?.length ?? 0;
    if (first < 2) continue;
    const same = recs.filter((r) => r.length === first).length / recs.length;
    const score = same * 1000 + first;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Read CSV or TSV text into a sheet named "Sheet1". */
export function readCsv(text: string, delimiter?: Delimiter): SheetData {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = delimiter ?? detectDelimiter(src);
  const records = parseRecords(src, delim);
  if (records.length > MAX_ROWS) throw new Error(`The file has ${records.length} rows; the limit is ${MAX_ROWS}.`);

  const sheet: SheetData = {
    name: 'Sheet1', rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: new Map(),
    colWidths: {}, rowHeights: {}, merges: [], frozenRows: 0, frozenCols: 0,
  };
  let maxCol = 0;
  records.forEach((rec, r) => {
    if (rec.length > MAX_COLS) throw new Error(`Row ${r + 1} has ${rec.length} columns; the limit is ${MAX_COLS}.`);
    maxCol = Math.max(maxCol, rec.length);
    rec.forEach((field, c) => {
      if (field === '') return;
      const input = field.startsWith('=') || field.startsWith("'") ? `'${field}` : field;
      sheet.cells.set(cellKey(r, c), { input });
    });
  });
  sheet.rows = Math.max(DEFAULT_ROWS, records.length);
  sheet.cols = Math.max(DEFAULT_COLS, maxCol);
  return sheet;
}

/** The text a cell contributes to a CSV: its value, never its formula. */
function cellText(cell: { input: string | null; value?: unknown }): string {
  const v = cell.value;
  if (v !== undefined) {
    if (v === null) return '';
    if (typeof v === 'number') return numberToText(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (isError(v)) return v.code;
    return csvSafeText(String(v));
  }
  const input = cell.input;
  if (input === null) return '';
  if (input.startsWith('=') && input.length > 1) return ''; // a formula with no known value
  if (input.startsWith("'")) return csvSafeText(input.slice(1));
  return csvSafeText(input);
}

/** Write one sheet as CSV (or TSV with '\t'). */
export function writeCsv(sheet: SheetData, delimiter: ',' | '\t' = ','): string {
  const rows = new Map<number, Map<number, string>>();
  let maxRow = -1;
  let maxCol = -1;
  for (const [k, cell] of sheet.cells) {
    const t = cellText(cell);
    if (t === '') continue;
    const [r, c] = parseCellKey(k);
    let row = rows.get(r);
    if (!row) { row = new Map(); rows.set(r, row); }
    row.set(c, t);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  const quote = (s: string) =>
    s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  const lines: string[] = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const row = rows.get(r);
    const fields: string[] = [];
    for (let c = 0; c <= maxCol; c += 1) fields.push(quote(row?.get(c) ?? ''));
    lines.push(fields.join(delimiter));
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

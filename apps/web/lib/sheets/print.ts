// ============================================================================
//  Print (and "Download as PDF", which is print to PDF).
//
//  The grid is a canvas sized to the window, so printing the page would
//  print one screenful. Instead we build a plain HTML table of the sheet's
//  used area — formatted values, fills, bold, borders, merges — put it in a
//  hidden iframe and print that. Every value is escaped; the page carries a
//  CSP with no scripts at all.
// ============================================================================

import { formatValue } from './engine/format';
import { colName } from './engine/address';
import type { SheetsModel } from './model';
import { ruleStyleAt, withRuleStyle } from './rules';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeColour = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);

export interface PrintOptions {
  orientation: 'portrait' | 'landscape';
  paper: 'A4' | 'A3' | 'Letter' | 'Legal';
  gridlines: boolean;
  headings: boolean;
  /** Print only this rectangle, else the sheet's used area. */
  range?: { r1: number; c1: number; r2: number; c2: number };
}

export function printSheet(model: SheetsModel, sheetId: string, title: string, opts: PrintOptions) {
  const ext = model.extent(sheetId);
  const r = opts.range ?? { r1: 0, c1: 0, r2: Math.max(0, ext.lastRow), c2: Math.max(0, ext.lastCol) };
  const locale = model.locale();
  const merges = model.merges(sheetId);
  const rules = model.colourRules(sheetId);
  const hiddenByFilter = model.filterHiddenRows(sheetId);
  const skip = new Set<string>();
  const span = new Map<string, { rs: number; cs: number }>();
  for (const m of merges) {
    span.set(`${m.r1},${m.c1}`, { rs: m.r2 - m.r1 + 1, cs: m.c2 - m.c1 + 1 });
    for (let i = m.r1; i <= m.r2; i += 1) for (let j = m.c1; j <= m.c2; j += 1) if (i !== m.r1 || j !== m.c1) skip.add(`${i},${j}`);
  }

  const rows: string[] = [];
  if (opts.headings) {
    rows.push(`<tr><th></th>${Array.from({ length: r.c2 - r.c1 + 1 }, (_, j) => `<th>${colName(r.c1 + j)}</th>`).join('')}</tr>`);
  }
  for (let i = r.r1; i <= r.r2; i += 1) {
    if (hiddenByFilter.has(i)) continue; // what is on screen is what prints
    const cells: string[] = [];
    if (opts.headings) cells.push(`<th>${i + 1}</th>`);
    for (let j = r.c1; j <= r.c2; j += 1) {
      if (skip.has(`${i},${j}`)) continue;
      const v = model.value(sheetId, i, j);
      // Colour rules print as they show (rules.ts withRuleStyle, as the grid).
      const f = withRuleStyle(model.format(sheetId, i, j), ruleStyleAt(rules, i, j, () => v, locale));
      const shown = formatValue(v, f?.nf, locale);
      const st: string[] = [];
      if (f?.b) st.push('font-weight:bold');
      if (f?.i) st.push('font-style:italic');
      if (f?.u || f?.s) st.push(`text-decoration:${[f.u ? 'underline' : '', f.s ? 'line-through' : ''].join(' ')}`);
      const col = safeColour(shown.color ?? f?.color); if (col) st.push(`color:${col}`);
      const bg = safeColour(f?.bg); if (bg) st.push(`background:${bg}`);
      if (f?.size) st.push(`font-size:${Math.max(6, Math.min(96, f.size))}pt`);
      st.push(`text-align:${f?.ha ?? (shown.numeric ? 'right' : 'left')}`);
      if (f?.wrap === 'wrap') st.push('white-space:pre-wrap');
      for (const [side, b] of [['top', f?.bt], ['bottom', f?.bb], ['left', f?.bl], ['right', f?.br]] as const) {
        if (b) st.push(`border-${side}:${b.style === 'thick' ? 3 : b.style === 'medium' ? 2 : 1}px ${b.style === 'dashed' ? 'dashed' : b.style === 'dotted' ? 'dotted' : b.style === 'double' ? 'double' : 'solid'} ${safeColour(b.color) ?? '#000'}`);
      }
      const sp = span.get(`${i},${j}`);
      const attrs = sp ? ` rowspan="${sp.rs}" colspan="${sp.cs}"` : '';
      cells.push(`<td${attrs} style="${st.join(';')}">${esc(shown.text)}</td>`);
    }
    rows.push(`<tr>${cells.join('')}</tr>`);
  }

  const grid = opts.gridlines ? '#d0d0d0' : 'transparent';
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
@page { size: ${opts.paper} ${opts.orientation}; margin: 12mm; }
body { font-family: Arial, sans-serif; font-size: 10pt; margin: 0; }
table { border-collapse: collapse; }
td, th { border: 1px solid ${grid}; padding: 2px 4px; white-space: nowrap; vertical-align: bottom; }
th { background: #f1f3f4; color: #5f6368; font-weight: normal; border-color: #c0c0c0; }
tr { break-inside: avoid; }
</style></head><body><table>${rows.join('')}</table></body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.src = url;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
  };
  document.body.appendChild(frame);
}

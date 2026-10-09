// ============================================================================
//  The filter — Sheets' "Data > Create a filter". Amit's Phase 2, 9 Oct 2026.
//
//  ONE PER SHEET, AND SHARED. As Google Sheets' basic filter: a sheet has at
//  most one filter, everyone looking at the sheet sees the same rows hidden,
//  and the filter is saved with the spreadsheet (and in its .xlsx, as an
//  Excel autofilter). The first row of the range is the header row; each
//  header cell gets a filter button.
//
//  BY VALUE, AS SHOWN. A column's criterion is the set of values to HIDE,
//  compared as the cells show them ("₹1,250", "15/08/2026"), ignoring case.
//  Stored as the values to HIDE rather than the ones to show, so a value
//  that first appears after the filter was set ("Late", typed tomorrow) is
//  shown, not silently hidden by a list written before it existed.
//
//  WHEN ROWS HIDE. Rows are worked out whenever the grid lays itself out
//  (the filter changes, a row is inserted, a size changes) — not on every
//  keystroke, so a row someone is typing in does not vanish under them when
//  its value stops matching. Google Sheets behaves the same.
//
//  WHAT A FILTER IS NOT. It hides nothing from anyone: every row is still
//  in the spreadsheet, in search, in exports and to AI. It is a view.
// ============================================================================

import type { Rect } from './engine/address';

/** A filter placed on a sheet, as positions: the range, and per column the values to hide (keys). */
export interface PlacedFilter extends Rect {
  /** Column index → the values hidden in it, as filterKey()s. Columns without a criterion are absent. */
  hidden: Map<number, Set<string>>;
}

/** A filter in a workbook snapshot (workbook.ts): plain data, hidden values as shown text. */
export interface FilterData extends Rect {
  hidden: Record<number, string[]>;
}

export const MAX_HIDDEN_VALUES = 5000;
const MAX_VALUE_LENGTH = 500;

/** How a shown value is compared: trimmed, ignoring case. A blank cell is ''. */
export const filterKey = (text: string | null | undefined) => (text ?? '').trim().toLowerCase();

/** A column's hidden values, cleaned: strings only, bounded, each once. */
export function cleanHiddenValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v.length > MAX_VALUE_LENGTH) continue;
    const k = filterKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= MAX_HIDDEN_VALUES) break;
  }
  return out;
}

/**
 * The rows a filter hides: data rows (below the header) where ANY filtered
 * column's shown value is one of that column's hidden values.
 */
export function hiddenRows(f: PlacedFilter, shown: (r: number, c: number) => string | null): Set<number> {
  const out = new Set<number>();
  if (f.hidden.size === 0) return out;
  for (let r = f.r1 + 1; r <= f.r2; r += 1) {
    for (const [c, keys] of f.hidden) {
      if (keys.has(filterKey(shown(r, c)))) { out.add(r); break; }
    }
  }
  return out;
}

/** A column's distinct shown values in the filter's data rows, with how many rows show each — for the filter menu. */
export function columnValues(f: Rect, c: number, shown: (r: number, c: number) => string | null): { text: string; key: string; count: number }[] {
  const by = new Map<string, { text: string; key: string; count: number }>();
  for (let r = f.r1 + 1; r <= f.r2; r += 1) {
    const text = (shown(r, c) ?? '').trim();
    const key = filterKey(text);
    const hit = by.get(key);
    if (hit) hit.count += 1;
    else by.set(key, { text, key, count: 1 });
  }
  // Numbers in number order, text alphabetically; blanks last, as Sheets lists them.
  return [...by.values()].sort((a, b) => {
    if (a.key === '' || b.key === '') return a.key === '' ? 1 : -1;
    const na = Number(a.text.replace(/[₹,\s%]/g, '')); const nb = Number(b.text.replace(/[₹,\s%]/g, ''));
    if (Number.isFinite(na) && Number.isFinite(nb) && a.text.trim() !== '' && b.text.trim() !== '') return na - nb;
    return a.text.localeCompare(b.text, 'en-IN', { sensitivity: 'base', numeric: true });
  });
}

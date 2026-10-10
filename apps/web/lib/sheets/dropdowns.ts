// ============================================================================
//  Dropdowns — Sheets' "Data > Dropdown": a cell that offers a fixed list.
//
//  Attendance (Present / Absent / Leave), fee status (Paid / Due / Waived),
//  grades. Amit's Phase 2, 9 Oct 2026. Excel calls it data validation (a
//  "list" rule); the .xlsx side is in io/xlsx.ts.
//
//  STRICT OR NOT. A strict dropdown refuses a typed value that is not on the
//  list, and says which values are; a loose one accepts it and marks the
//  cell with a red corner, as Google Sheets' "show a warning" does.
//
//  WHAT IS NOT ENFORCED. Pasting, fill-down and a colleague's edit are not
//  refused, only marked: refusing part of a paste silently would lose data,
//  and a colleague's value has already been typed. The mark (grid, a red
//  corner) is how such a value is found. The server does not check either —
//  a dropdown is help with typing, not a permission.
//
//  OVERLAPS. The dropdown added LAST wins where two cover a cell; adding one
//  over a range replaces any that lay wholly inside it (SheetsModel).
// ============================================================================

import type { Rect } from './engine/address';

export interface Dropdown {
  /** The choices, in the order offered. */
  items: string[];
  /** Refuse a typed value that is not one of the items. */
  strict: boolean;
}

export interface PlacedDropdown extends Dropdown, Rect { id: string }

export const MAX_ITEMS = 500;
export const MAX_ITEM_LENGTH = 100;

/** Choices as the person wrote them in the dialog: one per line (or comma-separated on one line). */
export function parseItems(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const raw = lines.length === 1 ? lines[0]!.split(',') : lines;
  return dedupe(raw.map((s) => s.trim()).filter((s) => s !== ''));
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * A dropdown rebuilt from known fields, or undefined. As with every part of
 * the Y.Doc, a hand-made client's junk is dropped, not half-applied: a list
 * with no usable items is no dropdown at all.
 */
export function cleanDropdown(raw: unknown): Dropdown | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items)) return undefined;
  const items = dedupe((r.items as unknown[])
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s.length <= MAX_ITEM_LENGTH))
    .slice(0, MAX_ITEMS);
  if (items.length === 0) return undefined;
  return { items, strict: r.strict !== false };
}

/** Is this input one of the choices? Empty always is (clearing a cell is never refused). Case does not matter. */
export function isChoice(dd: Dropdown, input: string | null): boolean {
  if (input === null || input.trim() === '') return true;
  const t = input.trim().toLowerCase();
  return dd.items.some((it) => it.toLowerCase() === t);
}

/** The item exactly as listed, for a value typed in another case ("absent" → "Absent"). */
export function asListed(dd: Dropdown, input: string): string {
  const t = input.trim().toLowerCase();
  return dd.items.find((it) => it.toLowerCase() === t) ?? input;
}

/** The dropdown over (r, c): the one added last among those covering it. */
export function dropdownAt(list: readonly PlacedDropdown[], r: number, c: number): PlacedDropdown | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const d = list[i]!;
    if (r >= d.r1 && r <= d.r2 && c >= d.c1 && c <= d.c2) return d;
  }
  return undefined;
}

/** "Present, Absent, Leave" — or the first few and a count, for a notice. */
export function itemsSummary(dd: Dropdown, max = 6): string {
  return dd.items.length <= max ? dd.items.join(', ') : `${dd.items.slice(0, max).join(', ')} and ${dd.items.length - max} more`;
}

import type { Meeting } from './connect';

/**
 * Put several meeting lists together WITHOUT listing a meeting twice.
 *
 * The Connect dashboard asks the server for `range=today` and
 * `range=upcoming` separately, and those two ranges OVERLAP by design: a
 * meeting scheduled for this afternoon is both "today" and "coming up", and
 * one that is running right now is in both as well. The dashboard used to
 * join them with `[...today, ...upcoming]`, so on 17 Sept 2026 Amit's own
 * live meeting showed twice under "Happening now" — same title, same code —
 * and the tile above it counted 2. Nothing was wrong on the server; the page
 * added one list to the other.
 *
 * Keyed on `id`, never on title or code: two genuinely different meetings can
 * share a title, and the code is a capability we do not compare for display.
 * The FIRST occurrence wins, so callers choose which list's copy they trust by
 * the order they pass them in.
 *
 * Pure, type-only import, so scripts/check-meeting-lists.mjs runs it under
 * plain Node.
 */
export function mergeById(...lists: Meeting[][]): Meeting[] {
  const seen = new Set<string>();
  const out: Meeting[] = [];
  for (const list of lists) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

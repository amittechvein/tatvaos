'use client';

// ============================================================================
//  The menu behind a filter button: sort by this column, and choose which of
//  its values show. The filter itself lives in the model (lib/sheets/
//  filter.ts, SheetsModel.filter); this only edits one column of it.
//
//  A filter is shared — everyone sees the same rows hidden — so someone who
//  can only view the spreadsheet can read the menu but not change it.
// ============================================================================

import { useMemo, useState } from 'react';
import { colName } from '@/lib/sheets/engine/address';
import type { SheetsModel } from '@/lib/sheets/model';
import { columnValues } from '@/lib/sheets/filter';

export function FilterMenu({ model, sheetId, col, style, readOnly, onClose }: {
  model: SheetsModel; sheetId: string; col: number; style: React.CSSProperties; readOnly: boolean; onClose: () => void;
}) {
  const f = model.filter(sheetId);
  const values = useMemo(
    () => (f ? columnValues(f, col, (r, c) => model.shownText(sheetId, r, c)) : []),
    // f's range is what matters; the menu is rebuilt each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, sheetId, col],
  );
  const hiddenNow = f?.hidden.get(col) ?? new Set<string>();
  const [shown, setShown] = useState<Set<string>>(() => new Set(values.filter((v) => !hiddenNow.has(v.key)).map((v) => v.key)));
  const [search, setSearch] = useState('');
  if (!f) return null;

  const q = search.trim().toLowerCase();
  const listed = q ? values.filter((v) => v.key.includes(q)) : values;
  const toggle = (key: string) => setShown((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  function apply() {
    model.setFilterHidden(sheetId, col, values.filter((v) => !shown.has(v.key)).map((v) => v.text));
    onClose();
  }

  function sort(desc: boolean) {
    if (!f) return;
    model.sortRange(sheetId, { r1: f.r1 + 1, c1: f.c1, r2: f.r2, c2: f.c2 }, [{ col, desc }]);
    onClose();
  }

  const header = model.shownText(sheetId, f.r1, col).trim() || `Column ${colName(col)}`;
  const BTN = 'block w-full rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-canvas disabled:opacity-40';

  return (
    <>
      {/* A click anywhere else closes the menu without applying it. */}
      <div className="fixed inset-0 z-30" onMouseDown={onClose} aria-hidden="true" />
      <div role="dialog" aria-label={`Filter ${header}`} style={style}
        className="absolute z-40 w-64 rounded-lg border border-line bg-surface p-2 text-sm text-ink shadow-raised">
        <p className="mb-1 truncate px-2 text-xs font-semibold text-ink-muted">{header}</p>
        <button type="button" className={BTN} disabled={readOnly} onClick={() => sort(false)}>Sort A → Z</button>
        <button type="button" className={BTN} disabled={readOnly} onClick={() => sort(true)}>Sort Z → A</button>
        <div className="my-2 h-px bg-line" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search values" aria-label="Search values"
          className="mb-1 w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand-600" />
        <div className="mb-1 flex gap-3 px-1 text-xs">
          <button type="button" disabled={readOnly} className="text-brand-600 hover:underline disabled:opacity-40"
            onClick={() => setShown(new Set(values.map((v) => v.key)))}>Select all</button>
          <button type="button" disabled={readOnly} className="text-brand-600 hover:underline disabled:opacity-40"
            onClick={() => setShown(new Set())}>Clear</button>
        </div>
        <div className="max-h-56 overflow-y-auto">
          {listed.length === 0 && <p className="px-2 py-1 text-xs text-ink-muted">No values match.</p>}
          {listed.map((v) => (
            <label key={v.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-canvas">
              <input type="checkbox" disabled={readOnly} checked={shown.has(v.key)} onChange={() => toggle(v.key)} />
              <span className={`min-w-0 flex-1 truncate ${v.key === '' ? 'italic text-ink-muted' : ''}`}>{v.key === '' ? '(Blanks)' : v.text}</span>
              <span className="text-xs text-ink-faint">{v.count}</span>
            </label>
          ))}
        </div>
        {readOnly
          ? <p className="mt-2 px-1 text-xs text-ink-muted">You can view this spreadsheet but not change its filter.</p>
          : (
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-ink hover:bg-canvas">Cancel</button>
              <button type="button" onClick={apply} disabled={shown.size === 0 && values.length > 0}
                title={shown.size === 0 ? 'Leave at least one value showing' : undefined}
                className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40">OK</button>
            </div>
          )}
      </div>
    </>
  );
}

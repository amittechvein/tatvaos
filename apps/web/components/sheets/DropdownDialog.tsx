'use client';

// ============================================================================
//  Data > Dropdown — put a list of choices on a range, change it, or take it
//  off. The dropdowns live in the model (lib/sheets/dropdowns.ts,
//  SheetsModel.dropdowns); this is only their editor.
// ============================================================================

import { useState } from 'react';
import { parseRect, rectName, type Rect } from '@/lib/sheets/engine/address';
import type { SheetsModel } from '@/lib/sheets/model';
import { MAX_ITEMS, MAX_ITEM_LENGTH, parseItems } from '@/lib/sheets/dropdowns';
import { Modal } from '@/components/ui/Modal';

const INPUT = 'w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand-600';

export function DropdownDialog({ model, sheetId, selection, active, onClose, onNotice }: {
  model: SheetsModel; sheetId: string; selection: Rect; active: { r: number; c: number };
  onClose: () => void; onNotice: (message: string) => void;
}) {
  // Start from the dropdown already on the active cell, if any: its range and choices.
  const existing = model.dropdownAt(sheetId, active.r, active.c);
  const [range, setRange] = useState(rectName(existing && selection.r1 === selection.r2 && selection.c1 === selection.c2 ? existing : selection));
  const [text, setText] = useState(existing ? existing.items.join('\n') : '');
  const [strict, setStrict] = useState(existing ? existing.strict : true);
  const [error, setError] = useState<string | null>(null);

  function target(): Rect | null {
    const rect = parseRect(range.replace(/\$/g, '').toUpperCase());
    const size = model.size(sheetId);
    if (!rect) { setError('Type the range as cells, like C2:C40.'); return null; }
    if (Math.max(rect.r1, rect.r2) >= size.rows || Math.max(rect.c1, rect.c2) >= size.cols) {
      setError('That range runs past the edge of the sheet.'); return null;
    }
    return rect;
  }

  function save() {
    const rect = target();
    if (!rect) return;
    const items = parseItems(text);
    if (items.length === 0) { setError('Type at least one choice.'); return; }
    if (items.length > MAX_ITEMS) { setError(`A dropdown can have up to ${MAX_ITEMS} choices.`); return; }
    const long = items.find((it) => it.length > MAX_ITEM_LENGTH);
    if (long) { setError(`A choice can be up to ${MAX_ITEM_LENGTH} characters: “${long.slice(0, 30)}…” is longer.`); return; }
    if (model.addDropdown(sheetId, rect, { items, strict }) === null) { setError('That dropdown could not be saved.'); return; }
    onClose();
  }

  function remove() {
    const rect = target();
    if (!rect) return;
    const n = model.removeDropdownsIn(sheetId, rect);
    onNotice(n === 0 ? `There is no dropdown in ${rectName(rect)}.`
      : `${n === 1 ? 'Dropdown' : `${n} dropdowns`} removed. The cells keep their values.`);
    onClose();
  }

  const count = parseItems(text).length;

  return (
    <Modal title="Dropdown" onClose={onClose} size="sm">
      <label className="mb-3 block text-xs text-ink-muted">Cells
        <input value={range} onChange={(e) => setRange(e.target.value)} className={`${INPUT} mt-1`} placeholder="C2:C40" />
      </label>
      <label className="mb-1 block text-xs text-ink-muted">Choices, one per line
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} autoFocus
          className={`${INPUT} mt-1 resize-y`} placeholder={'Present\nAbsent\nLeave'} />
      </label>
      <p className="mb-3 text-xs text-ink-faint">{count === 0 ? 'No choices yet.' : `${count} choice${count === 1 ? '' : 's'}.`} Each cell gets an arrow; click it, or press Alt+↓, to pick.</p>
      <label className="mb-1 flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} className="mt-0.5" />
        <span>Refuse anything that is not a choice
          <span className="block text-xs text-ink-muted">
            {strict ? 'Typing something else is refused. A value pasted in is kept and marked with a red corner.'
              : 'Anything can be typed; a value that is not a choice is marked with a red corner.'}
          </span>
        </span>
      </label>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      <div className="mt-4 flex items-center justify-between gap-2">
        <button type="button" onClick={remove} className="text-sm text-danger hover:underline">Remove dropdowns</button>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
          <button type="button" onClick={save} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Save</button>
        </div>
      </div>
    </Modal>
  );
}

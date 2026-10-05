'use client';

import { useState } from 'react';
import { formatDate, formatDateTime } from '@/lib/dates';
import type { DocVersion } from '@/lib/docs';
import { I } from './icons';

const KIND: Record<DocVersion['kind'], string> = {
  auto: 'Saved automatically',
  named: 'Named version',
  restore: 'Before a restore',
};

/**
 * Version history. Selecting a version shows it in place of the editor
 * (DocEditor owns that view); this panel is the list and its actions.
 */
export function HistoryPanel({
  versions, selectedId, canEdit, namedOnly, onNamedOnly, onSelect, onName, onNameCurrent, onClose,
}: {
  versions: DocVersion[] | null;
  selectedId: string | null;
  canEdit: boolean;
  namedOnly: boolean;
  onNamedOnly: (v: boolean) => void;
  onSelect: (v: DocVersion | null) => void;
  onName: (v: DocVersion, name: string) => Promise<void>;
  onNameCurrent: () => void;
  onClose: () => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [name, setName] = useState('');

  const shown = (versions ?? []).filter((v) => !namedOnly || v.kind === 'named');
  // Group by day, newest first — the list reads like Docs' own.
  const groups: { day: string; items: DocVersion[] }[] = [];
  for (const v of shown) {
    const day = formatDate(v.createdAt);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(v);
    else groups.push({ day, items: [v] });
  }

  return (
    <aside className="flex h-full w-full flex-col" aria-label="Version history">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-sm font-semibold text-ink">Version history</h2>
        <button type="button" onClick={onClose} aria-label="Close version history"
          className="rounded p-1 text-ink-faint hover:bg-canvas hover:text-ink"><I.close className="h-4 w-4" /></button>
      </header>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input type="checkbox" checked={namedOnly} onChange={(e) => onNamedOnly(e.target.checked)} />
          Only named versions
        </label>
        {canEdit && (
          <button type="button" onClick={onNameCurrent}
            className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted hover:bg-canvas">
            Name current version
          </button>
        )}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto py-2">
        <button type="button" onClick={() => onSelect(null)}
          className={`block w-full px-4 py-2 text-left text-sm ${selectedId === null ? 'bg-brand-50 font-semibold text-brand-600' : 'text-ink hover:bg-canvas'}`}>
          Current version
        </button>

        {versions === null ? (
          <p className="px-4 py-6 text-sm text-ink-faint">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-faint">
            {namedOnly ? 'No named versions yet.'
              : 'No earlier versions yet. They are saved automatically as the document is edited.'}
          </p>
        ) : groups.map((g) => (
          <div key={g.day}>
            <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-ink-faint">{g.day}</p>
            {g.items.map((v) => (
              <div key={v.id}
                className={`group px-4 py-2 ${selectedId === v.id ? 'bg-brand-50' : 'hover:bg-canvas'}`}>
                {naming === v.id ? (
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    void onName(v, name.trim()).then(() => setNaming(null));
                  }}>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200}
                      aria-label="Version name"
                      onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null); }}
                      className="w-full rounded border border-brand-600 bg-surface px-2 py-1 text-sm text-ink outline-none" />
                  </form>
                ) : (
                  <button type="button" onClick={() => onSelect(v)} className="block w-full text-left">
                    <span className={`block text-sm ${selectedId === v.id ? 'font-semibold text-brand-600' : 'text-ink'}`}>
                      {v.name ?? formatDateTime(v.createdAt)}
                    </span>
                    {v.name && <span className="block text-xs text-ink-muted">{formatDateTime(v.createdAt)}</span>}
                    <span className="block text-xs text-ink-faint">
                      {KIND[v.kind]}{v.createdByName ? ` · ${v.createdByName}` : ''}
                    </span>
                  </button>
                )}
                {canEdit && naming !== v.id && (
                  <button type="button"
                    onClick={() => { setNaming(v.id); setName(v.name ?? ''); }}
                    className="mt-1 hidden text-xs text-brand-600 hover:underline group-hover:inline">
                    {v.name ? 'Rename' : 'Name this version'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

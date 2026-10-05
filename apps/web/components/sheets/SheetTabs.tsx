'use client';

import { useEffect, useRef, useState } from 'react';
import type { SheetMeta } from '@/lib/sheets/model';
import { SI } from './icons';

// ============================================================================
//  The tabs along the bottom: one per sheet. Click to switch, double-click
//  to rename, right-click (or the arrow) for everything else.
// ============================================================================

const TAB_COLOURS = ['#d93025', '#e37400', '#f9ab00', '#188038', '#1a73e8', '#9334e6', '#c5221f', '#5f6368'];

export interface TabActions {
  add(): void;
  rename(id: string, name: string): string | null;
  remove(id: string): void;
  duplicate(id: string): void;
  move(id: string, delta: number): void;
  color(id: string, c: string | null): void;
  hide(id: string, hidden: boolean): void;
}

export function SheetTabs({ sheets, active, canEdit, onSelect, a }: {
  sheets: SheetMeta[];
  active: string;
  canEdit: boolean;
  onSelect: (id: string) => void;
  a: TabActions;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu && !listOpen) return;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) { setMenu(null); setListOpen(false); } };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); setListOpen(false); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [menu, listOpen]);

  function finishRename() {
    if (!renaming) return;
    const err = a.rename(renaming, draft);
    if (err) { setError(err); return; }
    setRenaming(null);
    setError(null);
  }

  const visible = sheets.filter((s) => !s.hidden);
  const hidden = sheets.filter((s) => s.hidden);
  const target = menu ? sheets.find((s) => s.id === menu.id) : null;

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-t border-line bg-canvas px-2 text-sm">
      {canEdit && (
        <button type="button" onClick={a.add} title="Add sheet" aria-label="Add sheet"
          className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-surface"><SI.plus /></button>
      )}
      <button type="button" onClick={() => setListOpen((o) => !o)} title="All sheets" aria-label="All sheets"
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-surface"><SI.list /></button>

      <div role="tablist" aria-label="Sheets" className="scroll-thin flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
        {visible.map((s) => {
          const on = s.id === active;
          return (
            <div key={s.id} role="tab" aria-selected={on} tabIndex={0}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s.id); }}
              onDoubleClick={() => { if (canEdit) { setRenaming(s.id); setDraft(s.name); setError(null); } }}
              onContextMenu={(e) => { e.preventDefault(); onSelect(s.id); setMenu({ id: s.id, x: e.clientX, y: e.clientY }); }}
              className={`group relative flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-t-md px-3 ${
                on ? 'bg-surface font-medium text-[#188038] shadow-sm dark:text-[#81c995]' : 'text-ink-muted hover:bg-surface/60'}`}>
              {renaming === s.id ? (
                <input autoFocus value={draft} aria-label="Sheet name"
                  onChange={(e) => { setDraft(e.target.value); setError(null); }}
                  onBlur={finishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') finishRename();
                    if (e.key === 'Escape') { setRenaming(null); setError(null); }
                  }}
                  className="w-28 rounded border border-brand-600 bg-surface px-1 text-sm text-ink outline-none" />
              ) : (
                <span className="max-w-[12rem] truncate">{s.name}</span>
              )}
              {canEdit && renaming !== s.id && (
                <button type="button" aria-label={`Options for ${s.name}`}
                  onClick={(e) => { e.stopPropagation(); onSelect(s.id); const b = (e.target as HTMLElement).getBoundingClientRect(); setMenu({ id: s.id, x: b.left, y: b.top }); }}
                  className="rounded p-0.5 text-ink-faint opacity-0 hover:bg-canvas group-hover:opacity-100">
                  <svg viewBox="0 0 24 24" className="h-3 w-3"><path d="M7 10l5 5 5-5" fill="currentColor" /></svg>
                </button>
              )}
              {s.tabColor && <span className="absolute inset-x-1 bottom-0 h-[3px] rounded" style={{ background: s.tabColor }} />}
            </div>
          );
        })}
      </div>
      {error && <span role="alert" className="shrink-0 text-xs text-danger">{error}</span>}

      {menu && target && canEdit && (
        <div ref={menuRef} role="menu" className="fixed z-50 min-w-[13rem] rounded-lg border border-line bg-surface py-1 shadow-raised"
          style={{ left: menu.x, bottom: Math.max(8, window.innerHeight - menu.y + 4) }}>
          <MenuButton onClick={() => { setMenu(null); a.remove(target.id); }}>Delete</MenuButton>
          <MenuButton onClick={() => { setMenu(null); a.duplicate(target.id); }}>Duplicate</MenuButton>
          <MenuButton onClick={() => { setMenu(null); setRenaming(target.id); setDraft(target.name); }}>Rename</MenuButton>
          <MenuButton onClick={() => { setMenu(null); a.hide(target.id, true); }}>Hide sheet</MenuButton>
          <div className="my-1 h-px bg-line" />
          <MenuButton onClick={() => { setMenu(null); a.move(target.id, -1); }}>Move left</MenuButton>
          <MenuButton onClick={() => { setMenu(null); a.move(target.id, 1); }}>Move right</MenuButton>
          <div className="my-1 h-px bg-line" />
          <p className="px-4 pb-1 pt-0.5 text-xs text-ink-muted">Tab colour</p>
          <div className="flex flex-wrap gap-1 px-4 pb-2">
            {TAB_COLOURS.map((c) => (
              <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => { setMenu(null); a.color(target.id, c); }}
                className="h-5 w-5 rounded-full border border-line" style={{ background: c }} />
            ))}
            <button type="button" onClick={() => { setMenu(null); a.color(target.id, null); }}
              className="rounded px-1 text-xs text-ink-muted hover:bg-canvas">None</button>
          </div>
        </div>
      )}

      {listOpen && (
        <div ref={menuRef} role="menu" className="fixed bottom-12 left-12 z-50 max-h-80 min-w-[14rem] overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-raised">
          {visible.map((s) => (
            <MenuButton key={s.id} onClick={() => { setListOpen(false); onSelect(s.id); }}>
              <span className={s.id === active ? 'font-semibold text-[#188038]' : ''}>{s.name}</span>
            </MenuButton>
          ))}
          {hidden.length > 0 && <div className="my-1 h-px bg-line" />}
          {hidden.map((s) => (
            <MenuButton key={s.id} disabled={!canEdit} onClick={() => { setListOpen(false); a.hide(s.id, false); onSelect(s.id); }}>
              <span className="text-ink-muted">{s.name} <span className="text-xs">(hidden — click to show)</span></span>
            </MenuButton>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuButton({ onClick, children, disabled }: { onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}
      className="block w-full px-4 py-1.5 text-left text-sm text-ink hover:bg-canvas disabled:text-ink-faint">
      {children}
    </button>
  );
}

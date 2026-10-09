'use client';

// ============================================================================
//  Format > Colour rules — the list of a sheet's colour rules, and the form
//  that adds or edits one. The rules themselves live in the model
//  (lib/sheets/rules.ts, SheetsModel.colourRules); this is only their editor.
// ============================================================================

import { useEffect, useReducer, useState } from 'react';
import { parseRect, rectName, type Rect } from '@/lib/sheets/engine/address';
import type { SheetsModel } from '@/lib/sheets/model';
import {
  DEFAULT_RULE_STYLE, RULE_KINDS, RULE_LABELS, describeRule, operandCount,
  type ColourRule, type PlacedRule, type RuleKind, type RuleStyle,
} from '@/lib/sheets/rules';
import { Modal } from '@/components/ui/Modal';

/** Fill / text pairs that read well together, light fill with dark text. */
const PRESETS: { name: string; style: RuleStyle }[] = [
  { name: 'Red', style: { bg: '#f4c7c3', color: '#a50e0e' } },
  { name: 'Orange', style: { bg: '#fce8b2', color: '#8a4b08' } },
  { name: 'Yellow', style: { bg: '#fff2cc', color: '#7f6000' } },
  { name: 'Green', style: { bg: '#d9ead3', color: '#274e13' } },
  { name: 'Blue', style: { bg: '#cfe2f3', color: '#073763' } },
  { name: 'Purple', style: { bg: '#e2d9f3', color: '#3d1a78' } },
  { name: 'Grey', style: { bg: '#e7e6e6', color: '#3c3c3c' } },
  { name: 'Text only', style: { color: '#c5221f' } },
];

const INPUT = 'w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand-600';

function Swatch({ style, label = 'Aa' }: { style: RuleStyle; label?: string }) {
  return (
    <span className="inline-flex h-7 min-w-[2.25rem] items-center justify-center rounded border border-line px-1.5 text-xs"
      style={{
        background: style.bg ?? 'transparent', color: style.color ?? 'inherit',
        fontWeight: style.b ? 700 : undefined, fontStyle: style.i ? 'italic' : undefined,
        textDecoration: style.s ? 'line-through' : undefined,
      }}>
      {label}
    </span>
  );
}

interface Draft { id: string | null; range: string; kind: RuleKind; a: string; b: string; style: RuleStyle }

export function ColourRulesDialog({ model, sheetId, selection, canEdit, onClose }: {
  model: SheetsModel; sheetId: string; selection: Rect; canEdit: boolean; onClose: () => void;
}) {
  // Re-read the list whenever the spreadsheet changes — a colleague may add
  // or delete a rule while this is open.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => model.subscribe(() => bump()), [model]);
  const rules = model.colourRules(sheetId);

  const fresh = (): Draft => ({ id: null, range: rectName(selection), kind: 'gt', a: '', b: '', style: DEFAULT_RULE_STYLE });
  const [draft, setDraft] = useState<Draft | null>(rules.length === 0 && canEdit ? fresh() : null);
  const [error, setError] = useState<string | null>(null);

  const edit = (r: PlacedRule) => {
    setError(null);
    setDraft({ id: r.id, range: rectName(r), kind: r.kind, a: r.a ?? '', b: r.b ?? '', style: r.style });
  };

  function save() {
    if (!draft) return;
    const rect = parseRect(draft.range.replace(/\$/g, '').toUpperCase());
    const size = model.size(sheetId);
    if (!rect) { setError('Type the range as cells, like B2:B50.'); return; }
    if (Math.max(rect.r1, rect.r2) >= size.rows || Math.max(rect.c1, rect.c2) >= size.cols) {
      setError('That range runs past the edge of the sheet.'); return;
    }
    const need = operandCount(draft.kind);
    if (need >= 1 && draft.a.trim() === '') { setError('Type the value to compare with.'); return; }
    if (need === 2 && draft.b.trim() === '') { setError('Type both values.'); return; }
    if (!draft.style.bg && !draft.style.color && !draft.style.b) { setError('Choose a colour or bold, so the rule shows.'); return; }
    const rule: ColourRule = { kind: draft.kind, style: draft.style };
    if (need >= 1) rule.a = draft.a.trim();
    if (need === 2) rule.b = draft.b.trim();
    const ok = draft.id ? model.updateColourRule(sheetId, draft.id, rect, rule) : model.addColourRule(sheetId, rect, rule) !== null;
    if (!ok) { setError('That rule could not be saved. Check the range and values.'); return; }
    setError(null);
    setDraft(null);
  }

  const need = draft ? operandCount(draft.kind) : 0;

  return (
    <Modal title="Colour rules" onClose={onClose} size="md">
      <p className="mb-3 text-xs text-ink-muted">
        Colour cells by their value. Where more than one rule covers a cell, the first rule in the list that
        matches is used. The cells&rsquo; own formatting comes back when a rule stops matching or is deleted.
      </p>

      {rules.length === 0 && !draft && <p className="mb-3 text-sm text-ink-muted">This sheet has no colour rules yet.</p>}

      {rules.length > 0 && (
        <ul className="mb-3 divide-y divide-line rounded-lg border border-line">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Swatch style={r.style} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{describeRule(r)}</span>
                <span className="block text-xs text-ink-muted">{rectName(r)}</span>
              </span>
              {canEdit && (
                <>
                  <button type="button" onClick={() => edit(r)} className="text-xs text-brand-600 hover:underline">Edit</button>
                  <button type="button" onClick={() => { model.removeColourRule(sheetId, r.id); if (draft?.id === r.id) setDraft(null); }}
                    className="text-xs text-danger hover:underline">Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <div className="rounded-lg border border-line p-3">
          <p className="mb-2 text-sm font-semibold text-ink">{draft.id ? 'Edit rule' : 'New rule'}</p>
          <label className="mb-2 block text-xs text-ink-muted">Apply to range
            <input value={draft.range} onChange={(e) => setDraft({ ...draft, range: e.target.value })} className={`${INPUT} mt-1`} placeholder="B2:B50" />
          </label>
          <label className="mb-2 block text-xs text-ink-muted">Colour cells if
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as RuleKind })} className={`${INPUT} mt-1`}>
              {RULE_KINDS.map((k) => <option key={k} value={k}>{RULE_LABELS[k]}</option>)}
            </select>
          </label>
          {need >= 1 && (
            <div className="mb-2 flex items-center gap-2">
              <input value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} className={INPUT}
                placeholder={need === 2 ? 'From' : 'Value or text'} aria-label={need === 2 ? 'From' : 'Value'} />
              {need === 2 && (
                <>
                  <span className="text-xs text-ink-muted">and</span>
                  <input value={draft.b} onChange={(e) => setDraft({ ...draft, b: e.target.value })} className={INPUT} placeholder="To" aria-label="To" />
                </>
              )}
            </div>
          )}

          <p className="mb-1 mt-3 text-xs text-ink-muted">Look</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const on = p.style.bg === draft.style.bg && p.style.color === draft.style.color;
              return (
                <button key={p.name} type="button" title={p.name} aria-label={p.name} aria-pressed={on}
                  onClick={() => setDraft({ ...draft, style: { ...p.style, ...(draft.style.b ? { b: true } : {}) } })}
                  className={`rounded ${on ? 'ring-2 ring-brand-600 ring-offset-1' : ''}`}>
                  <Swatch style={p.style} />
                </button>
              );
            })}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-muted">
            <label className="flex items-center gap-1.5">Fill
              <input type="color" value={draft.style.bg ?? '#ffffff'} onChange={(e) => setDraft({ ...draft, style: { ...draft.style, bg: e.target.value } })} />
            </label>
            <label className="flex items-center gap-1.5">Text
              <input type="color" value={draft.style.color ?? '#000000'} onChange={(e) => setDraft({ ...draft, style: { ...draft.style, color: e.target.value } })} />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!draft.style.b}
                onChange={(e) => setDraft({ ...draft, style: { ...draft.style, b: e.target.checked || undefined } })} /> Bold
            </label>
            <span className="flex items-center gap-1.5">Preview <Swatch style={draft.style} label="₹1,250" /></span>
          </div>

          {error && <p className="mb-2 text-sm text-danger" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setDraft(null); setError(null); }} className="rounded-full px-4 py-2 text-sm text-ink hover:bg-canvas">Cancel</button>
            <button type="button" onClick={save} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              {draft.id ? 'Save rule' : 'Add rule'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between gap-2">
          {canEdit
            ? <button type="button" onClick={() => { setError(null); setDraft(fresh()); }} className="text-sm text-brand-600 hover:underline">Add a rule</button>
            : <span className="text-xs text-ink-muted">You can see this sheet&rsquo;s rules but not change them.</span>}
          <button type="button" onClick={onClose} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white">Done</button>
        </div>
      )}
    </Modal>
  );
}

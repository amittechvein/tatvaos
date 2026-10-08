'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { sheetsApi, type SheetsAiAction } from '@/lib/sheets/api';
import { I } from '@/components/docs/icons';
import { Spinner } from '@/components/ui/Kit';

// ============================================================================
//  TatvaOS AI for a spreadsheet.
//
//  Nothing the model says is put into the sheet on its own. A formula comes
//  back as text with an "Insert" button beside it; analysis and data checks
//  are read, not applied. The person decides, and the insertion is an
//  ordinary edit anyone can undo.
// ============================================================================

export interface AiContext {
  /** The active cell's address, e.g. "D12". */
  cell: string;
  /** The active cell's input, when it is a formula. */
  formula: string | null;
  /** The sheet described for the model: name, headings, sample rows. */
  describeSheet: () => string;
  /** The selection as a table, with a flag when it was too big and was cut short. */
  selection: () => { text: string; truncated: boolean; cells: number };
}

export function SheetsAiPanel({ fileId, available, reason, canEdit, ctx, onInsert, onClose }: {
  fileId: string;
  available: boolean;
  reason: string | null;
  canEdit: boolean;
  ctx: AiContext;
  onInsert: (formula: string) => void;
  onClose: () => void;
}) {
  const { authedFetch } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<SheetsAiAction | null>(null);
  const [result, setResult] = useState<{ action: SheetsAiAction; text: string; cell: string; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: SheetsAiAction) {
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      let note: string | undefined;
      const body: Parameters<typeof sheetsApi.ai>[2] = { action, cell: ctx.cell };
      if (action === 'formula') {
        body.prompt = prompt.trim();
        body.context = ctx.describeSheet();
      } else if (action === 'explain') {
        body.formula = ctx.formula ?? '';
        body.context = ctx.describeSheet();
      } else {
        const sel = ctx.selection();
        if (sel.cells <= 1) {
          setError('Select the cells to look at first — a table with its heading row works best.');
          setBusy(null);
          return;
        }
        body.context = sel.text;
        if (sel.truncated) note = 'The selection was large, so only its first part was sent.';
      }
      const r = await sheetsApi.ai(authedFetch, fileId, body);
      setResult({ action, text: r.text, cell: ctx.cell, note });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'TatvaOS AI could not answer.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <I.sparkle className="h-5 w-5 text-[#9334e6]" />
        <h2 className="flex-1 text-sm font-semibold text-ink">TatvaOS AI</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-canvas"><I.close className="h-4 w-4" /></button>
      </header>

      {!available ? (
        <p className="p-4 text-sm text-ink-muted">{reason ?? 'AI is not available.'}</p>
      ) : (
        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4">
          <section>
            <label htmlFor="sheets-ai-prompt" className="mb-1 block text-xs font-medium text-ink-muted">
              Describe a calculation for {ctx.cell}
            </label>
            <textarea id="sheets-ai-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
              placeholder="e.g. total fees still due for class 10"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && prompt.trim()) void run('formula'); }}
              className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-600" />
            <button type="button" disabled={!prompt.trim() || busy !== null} onClick={() => void run('formula')}
              className="mt-2 w-full rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Create formula
            </button>
          </section>

          <section className="grid grid-cols-1 gap-2">
            <Action label="Explain this formula" hint={ctx.formula ? ctx.formula.slice(0, 40) : 'Select a cell with a formula'}
              disabled={!ctx.formula || busy !== null} onClick={() => void run('explain')} />
            <Action label="Analyse the selection" hint="Totals, averages, trends"
              disabled={busy !== null} onClick={() => void run('analyze')} />
            <Action label="Check the data" hint="Duplicates, blanks, inconsistent names"
              disabled={busy !== null} onClick={() => void run('clean')} />
          </section>

          {busy && <Spinner className="py-6" />}
          {error && <p role="alert" className="rounded-lg bg-[#fce8e6] px-3 py-2 text-sm text-[#a50e0e]">{error}</p>}

          {result && (
            <section className="rounded-lg border border-line bg-canvas/50 p-3">
              {result.action === 'formula' ? (
                <>
                  <p className="mb-1 text-xs text-ink-muted">Suggested formula for {result.cell}</p>
                  <code className="block break-all rounded bg-surface px-2 py-1.5 font-mono text-sm text-ink">{result.text}</code>
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={!canEdit} onClick={() => onInsert(result.text)}
                      className="rounded-full bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                      Insert in {result.cell}
                    </button>
                    <button type="button" onClick={() => void navigator.clipboard?.writeText(result.text)}
                      className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink">Copy</button>
                  </div>
                  <p className="mt-2 text-xs text-ink-faint">Check it before relying on it — AI can be wrong.</p>
                </>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{result.text}</p>
                  {result.note && <p className="mt-2 text-xs text-ink-faint">{result.note}</p>}
                  <p className="mt-2 text-xs text-ink-faint">Written by AI from the cells you selected. Check important figures.</p>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Action({ label, hint, onClick, disabled }: { label: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="rounded-lg border border-line px-3 py-2 text-left hover:bg-canvas disabled:opacity-50">
      <span className="block text-sm font-medium text-ink">{label}</span>
      <span className="block truncate text-xs text-ink-muted">{hint}</span>
    </button>
  );
}

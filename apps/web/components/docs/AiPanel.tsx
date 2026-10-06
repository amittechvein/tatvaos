'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { docsApi, type AiAction } from '@/lib/docs';
import { I } from './icons';

const LANGUAGES = [
  'Hindi', 'English', 'Bengali', 'Marathi', 'Telugu', 'Tamil', 'Gujarati', 'Kannada',
  'Malayalam', 'Punjabi', 'Odia', 'Urdu', 'Assamese', 'Sanskrit', 'French', 'German', 'Spanish',
];

const REWRITES = [
  { style: 'improve', label: 'Improve writing' },
  { style: 'shorten', label: 'Make shorter' },
  { style: 'expand', label: 'Make longer' },
  { style: 'formal', label: 'More formal' },
  { style: 'simple', label: 'Simpler' },
];

const IDEAS = [
  'A lesson plan for Class 7 on photosynthesis',
  'Ten multiple-choice questions on the water cycle, with answers',
  'A notice to parents about the annual sports day',
  'Minutes template for a staff meeting',
];

/**
 * Plain text from the model → safe HTML for the editor. The model is told
 * to use only blank-line paragraphs, "- " bullets, "1. " numbers and "#"
 * headings; everything is escaped first, so nothing it writes can become
 * markup of its own.
 */
export function aiTextToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (bullet || num) {
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { close(); out.push(`<${want}>`); list = want; }
      out.push(`<li><p>${inline((bullet ?? num)?.[1] ?? '')}</p></li>`);
    } else if (head) {
      close();
      const level = (head[1] ?? '#').length + 1; // "#" → h2: the document keeps its own title
      out.push(`<h${level}>${inline(head[2] ?? '')}</h${level}>`);
    } else if (line.trim() === '') {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('');
}

export function AiPanel({ fileId, available, reason, canEdit, getSelection, getDocument, onInsert, onClose }: {
  fileId: string;
  available: boolean;
  reason: string | null;
  canEdit: boolean;
  getSelection: () => string;
  getDocument: () => string;
  /** replace: swap the current selection. insert: put it at the cursor. */
  onInsert: (html: string, mode: 'replace' | 'insert') => void;
  onClose: () => void;
}) {
  const { authedFetch } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState('Hindi');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; truncated: boolean; replaces: boolean } | null>(null);

  async function run(label: string, action: AiAction, extra: { style?: string; language?: string; prompt?: string },
    source: 'selection' | 'document') {
    const text = source === 'selection' ? getSelection() : getDocument();
    if (source === 'selection' && !text.trim()) {
      setError('Select some text in the document first.');
      return;
    }
    setBusy(label); setError(null); setResult(null);
    try {
      const r = await docsApi.ai(authedFetch, fileId, { action, text, ...extra });
      setResult({ text: r.text, truncated: r.truncated, replaces: source === 'selection' && action !== 'summarize' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'TatvaOS AI could not answer.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className="flex h-full w-full flex-col" aria-label="TatvaOS AI">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <I.sparkle className="h-4 w-4 text-brand-600" />
        <h2 className="flex-1 text-sm font-semibold text-ink">TatvaOS AI</h2>
        <button type="button" onClick={onClose} aria-label="Close TatvaOS AI"
          className="rounded p-1 text-ink-faint hover:bg-canvas hover:text-ink"><I.close className="h-4 w-4" /></button>
      </header>

      {!available ? (
        <p className="p-4 text-sm text-ink-muted">{reason ?? 'TatvaOS AI is not available.'}</p>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">This document</h3>
            <button type="button" disabled={!!busy} onClick={() => void run('summary', 'summarize', {}, 'document')}
              className="docs-ai-btn">{busy === 'summary' ? 'Summarising…' : 'Summarise the document'}</button>
          </section>

          {canEdit && (
            <>
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Selected text</h3>
                <div className="flex flex-wrap gap-2">
                  {REWRITES.map((r) => (
                    <button key={r.style} type="button" disabled={!!busy}
                      onClick={() => void run(r.style, 'rewrite', { style: r.style }, 'selection')}
                      className="docs-ai-chip">{busy === r.style ? '…' : r.label}</button>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Translate into"
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                    {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
                  </select>
                  <button type="button" disabled={!!busy}
                    onClick={() => void run('translate', 'translate', { language }, 'selection')}
                    className="docs-ai-chip">{busy === 'translate' ? '…' : 'Translate'}</button>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Write something new</h3>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={2000}
                  placeholder="Ask anything, e.g. a lesson plan, a notice, questions with answers…"
                  aria-label="What should TatvaOS AI write?"
                  className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-600" />
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {IDEAS.map((i) => (
                    <button key={i} type="button" onClick={() => setPrompt(i)}
                      className="rounded-full bg-canvas px-2.5 py-0.5 text-left text-xs text-ink-muted hover:text-ink">{i}</button>
                  ))}
                </div>
                <button type="button" disabled={!!busy || !prompt.trim()}
                  onClick={() => void run('generate', 'generate', { prompt }, 'document')}
                  className="docs-ai-btn mt-3">{busy === 'generate' ? 'Writing…' : 'Write it'}</button>
              </section>
            </>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          {result && (
            <section className="rounded-xl border border-brand-600/40 bg-brand-50/40 p-3">
              {result.truncated && (
                <p className="mb-2 text-xs text-warn">
                  The document was too long to read in full, so this is based on its first part only.
                </p>
              )}
              {/* Shown as plain text. It becomes formatted content only when
                  inserted, through the editor's own schema (aiTextToHtml). */}
              <div className="max-h-80 overflow-y-auto whitespace-pre-wrap text-sm text-ink">{result.text}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canEdit && result.replaces && (
                  <button type="button" onClick={() => { onInsert(aiTextToHtml(result.text), 'replace'); setResult(null); }}
                    className="rounded-full bg-brand-600 px-4 py-1 text-xs font-semibold text-white">Replace selection</button>
                )}
                {canEdit && (
                  <button type="button" onClick={() => { onInsert(aiTextToHtml(result.text), 'insert'); setResult(null); }}
                    className={`rounded-full px-4 py-1 text-xs font-semibold ${result.replaces
                      ? 'border border-brand-600 text-brand-600' : 'bg-brand-600 text-white'}`}>
                    Insert at cursor
                  </button>
                )}
                <button type="button" onClick={() => void navigator.clipboard.writeText(result.text)}
                  className="rounded-full border border-line px-4 py-1 text-xs text-ink-muted hover:bg-canvas">Copy</button>
                <button type="button" onClick={() => setResult(null)}
                  className="rounded-full px-3 py-1 text-xs text-ink-faint hover:text-ink">Discard</button>
              </div>
              <p className="mt-2 text-[11px] text-ink-faint">AI can make mistakes. Check it before you share.</p>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

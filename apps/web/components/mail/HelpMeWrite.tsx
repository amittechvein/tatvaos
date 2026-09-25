'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { useAuth } from '@/lib/auth';
import { REWRITE_GROUPS, REWRITE_STYLES, mailAiRewrite, mailAiStatus, type MailAiStatus, type RewriteStyle } from '@/lib/mailAi';

// ============================================================================
//  Help me write — TatvaOS AI in the composer. Step 1 of 3 (Amit, 25 Sept).
//
//  The shape, and why:
//   · A button in the toolbar, drawn ONLY when the organisation has Mail AI
//     on. A button that can only ever answer "your administrator has not
//     turned this on" is an advert, not a feature.
//   · Pick a style → the rewrite is SHOWN FIRST, beside nothing replaced.
//     Somebody's email is theirs; the model proposes, the person decides.
//   · Replace goes through the editor's own undo (the composer does it with
//     execCommand), and an Undo button stays until they type again.
//   · Labelled as AI and "check it before you send" every time. A model can
//     change a date while tidying a sentence; the one reader who will notice
//     is the one about to press Send.
// ============================================================================

export interface HelpMeWriteProps {
  /** The person's own words right now — no quote, no signature. */
  readDraft: () => string;
  /** Put the rewrite in place of those words. */
  replace: (text: string) => void;
  /** Take the last replace back. */
  undo: () => void;
  /** True once the person has typed since the last replace; hides Undo. */
  editedSinceReplace: boolean;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'menu' }
  | { kind: 'working'; style: RewriteStyle }
  | { kind: 'result'; style: RewriteStyle; text: string }
  | { kind: 'error'; style: RewriteStyle | null; message: string }
  | { kind: 'replaced' };

/** The whole Mail AI status — `triage` is what the inbox tabs need. Null until known. */
export function useMailAiStatus(): MailAiStatus | null {
  const { authedFetch } = useAuth();
  const [s, setS] = useState<MailAiStatus | null>(null);
  useEffect(() => {
    let live = true;
    void mailAiStatus(authedFetch).then((x) => { if (live) setS(x); });
    return () => { live = false; };
  }, [authedFetch]);
  return s;
}

export function useMailAiAvailable(): boolean {
  const { authedFetch } = useAuth();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    void mailAiStatus(authedFetch).then((s) => { if (live) setOk(s.available); });
    return () => { live = false; };
  }, [authedFetch]);
  return ok;
}

/** The toolbar button. Opens the panel; the panel is drawn by HelpMeWritePanel. */
export function HelpMeWriteButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title="Help me write — rewrite your draft with TatvaOS AI"
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
        open ? 'bg-brand-50 text-brand-700' : 'text-ink-muted hover:bg-canvas hover:text-ink'
      }`}
    >
      <Icon name="sparkle" className="h-4 w-4" />
      <span className="hidden sm:inline">Help me write</span>
    </button>
  );
}

export function HelpMeWritePanel({
  open,
  onClose,
  readDraft,
  replace,
  undo,
  editedSinceReplace,
}: HelpMeWriteProps & { open: boolean; onClose: () => void }) {
  const { authedFetch } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });
  /** Guards against a slow answer landing after the person moved on. */
  const ticket = useRef(0);

  useEffect(() => {
    if (open) setPhase((p) => (p.kind === 'replaced' && !editedSinceReplace ? p : { kind: 'menu' }));
    else ticket.current += 1;
  }, [open, editedSinceReplace]);

  // The Undo line lasts until they type; after that ctrl+Z is the tool.
  useEffect(() => {
    if (editedSinceReplace && phase.kind === 'replaced') onClose();
  }, [editedSinceReplace, phase.kind, onClose]);

  if (!open) return null;

  async function run(style: RewriteStyle) {
    const draft = readDraft();
    if (!draft.trim()) {
      setPhase({ kind: 'error', style: null, message: 'Write something first, then choose how to rewrite it.' });
      return;
    }
    const mine = ++ticket.current;
    setPhase({ kind: 'working', style });
    try {
      const text = await mailAiRewrite(authedFetch, draft, style);
      if (ticket.current === mine) setPhase({ kind: 'result', style, text });
    } catch (e) {
      if (ticket.current === mine) setPhase({ kind: 'error', style, message: (e as Error).message });
    }
  }

  const label = (s: RewriteStyle) => REWRITE_STYLES.find((x) => x.style === s)?.label ?? s;

  return (
    <div className="shrink-0 border-t border-line bg-canvas/60 px-4 py-3 text-sm" role="region" aria-label="Help me write">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="sparkle" className="h-4 w-4 text-brand-600" />
        <span className="font-medium text-ink">Help me write</span>
        <span className="text-[11px] text-ink-faint">TatvaOS AI · sees only what you typed</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Help me write"
          className="ml-auto rounded p-1 text-ink-faint hover:bg-line hover:text-ink"
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      </div>

      {(phase.kind === 'menu' || phase.kind === 'error') && (
        <>
          <div className="space-y-1.5">
            {REWRITE_GROUPS.map((g) => (
              <div key={g.title} className="flex items-start gap-2">
                {/* The chips wrap in their own box, so a second line lines up
                    under the first chip rather than under the row's title. */}
                <span className="w-14 shrink-0 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">{g.title}</span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {g.styles.map(({ style, label: l }) => (
                  <button
                    key={style}
                    type="button"
                    onClick={() => void run(style)}
                    className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink transition hover:border-brand-400"
                  >
                    {l}
                  </button>
                ))}
                </div>
              </div>
            ))}
          </div>
          {phase.kind === 'error' && <p className="mb-0 mt-2 text-xs text-danger">{phase.message}</p>}
        </>
      )}

      {phase.kind === 'working' && (
        <p className="mb-0 text-xs text-ink-muted" aria-live="polite">
          Rewriting — {label(phase.style).toLowerCase()}…
        </p>
      )}

      {phase.kind === 'result' && (
        <>
          <div className="scroll-thin max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface px-3 py-2 text-ink">
            {phase.text}
          </div>
          <p className="mb-2 mt-1.5 text-[11px] text-ink-faint">
            Written by TatvaOS AI ({label(phase.style).toLowerCase()}). Check names, dates and numbers before you send.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { replace(phase.text); setPhase({ kind: 'replaced' }); }}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-600"
            >
              Replace my draft
            </button>
            <button
              type="button"
              onClick={() => void run(phase.style)}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink transition hover:border-brand-400"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: 'menu' })}
              className="rounded-md px-3 py-1.5 text-xs text-ink-muted transition hover:text-ink"
            >
              Another style
            </button>
          </div>
        </>
      )}

      {phase.kind === 'replaced' && (
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <span>Your draft was replaced with the AI version.</span>
          <button
            type="button"
            onClick={() => { undo(); setPhase({ kind: 'menu' }); }}
            className="font-medium text-brand-600 hover:underline"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

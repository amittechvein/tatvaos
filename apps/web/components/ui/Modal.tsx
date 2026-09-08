'use client';

// ============================================================================
//  Dialogs.
//
//  8 Sept 2026: rewritten off YZEN's Bootstrap modal markup onto Tailwind and
//  the tokens in styles/globals.css. THIS FILE IS A LEVER, the same way Kit.tsx
//  was — SIXTEEN files import it, so moving it moves every dialog in the
//  console without touching a single call site.
//
//  THE PUBLIC SHAPE IS UNCHANGED, deliberately: same exports, same props, same
//  defaults. A caller that renders correctly today renders correctly after
//  this, which is what makes it revertible in one commit. Anything that looks
//  wrong afterwards is this file's fault, not the caller's.
//
//  The panel widths below are Bootstrap's own (300 / 500 / 800 / 1140px) rather
//  than Tailwind's max-w scale, because "migrate while it still looks the same"
//  is stage 3's rule and a dialog that silently changed width would break it.
// ============================================================================

import { useEffect, useId, useRef } from 'react';

// ---------------------------------------------------------------------------
//  BODY SCROLL LOCK.
//
//  We ship no Bootstrap JavaScript, and the scroll lock was the one thing in
//  the modal that genuinely needed it: `.modal-open` on <body> was never being
//  added, so the page behind every dialog in this product has always scrolled
//  under it. That is a behaviour fix, not a look change, and it is the reason
//  this counter exists rather than a plain effect — a dialog opened from inside
//  another dialog must not unlock the page when only the inner one closes.
//
//  Hiding the scrollbar makes the page a few pixels wider. Without the padding
//  compensation the whole layout jumps sideways the instant a dialog opens,
//  which reads as a bug even though nothing is broken.
let openCount = 0;

function lockScroll() {
  if (openCount++ > 0) return;
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.dataset.prevOverflow = document.body.style.overflow;
  document.body.dataset.prevPadRight = document.body.style.paddingRight;
  document.body.style.overflow = 'hidden';
  if (gap > 0) document.body.style.paddingRight = `${gap}px`;
}

function unlockScroll() {
  if (--openCount > 0) return;
  openCount = 0;
  document.body.style.overflow = document.body.dataset.prevOverflow ?? '';
  document.body.style.paddingRight = document.body.dataset.prevPadRight ?? '';
  delete document.body.dataset.prevOverflow;
  delete document.body.dataset.prevPadRight;
}

// ---------------------------------------------------------------------------
//  Bootstrap's widths, kept exactly.
const WIDTH = {
  sm: 'max-w-[300px]',
  md: 'max-w-[500px]',
  lg: 'max-w-[800px]',
  xl: 'max-w-[1140px]',
} as const;

/**
 * A dialog, driven by React state.
 *
 * Closing is wired here so every dialog in the console behaves the same way:
 * Escape, the × button, or a press on the backdrop — and none of them while a
 * save is in flight, because a dialog that vanishes mid-write leaves you unsure
 * whether the write happened.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  busy = false,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Blocks every dismissal path while a request is in flight. */
  busy?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    lockScroll();
    return unlockScroll;
  }, []);

  // FOCUS. A dialog that opens while the keyboard focus is still on the button
  // behind it strands anyone not using a mouse: Tab walks the page under the
  // backdrop, which they cannot see. So focus moves into the panel — but only
  // if nothing inside it has claimed focus already, because several dialogs
  // autoFocus their first input and that is the better landing spot. On close
  // focus goes back where it came from, so the list you opened the dialog from
  // is still where you are.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return (
    <>
      <div
        className="fixed inset-0 z-[1050] bg-[rgb(21_20_27_/_0.45)]"
        // The backdrop is decoration; the dialog above it carries the semantics.
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-[1055] flex items-center justify-center overflow-y-auto p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Only a press that both STARTS and lands on the backdrop closes it —
        // otherwise selecting text in the dialog and releasing outside it would.
        onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          className={
            `flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-card `
            + `border border-line bg-surface shadow-raised focus:outline-none ${WIDTH[size]}`
          }
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h6 id={titleId} className="text-[15px] font-semibold text-ink">{title}</h6>
              {subtitle && <div className="mt-1 text-xs text-ink-muted">{subtitle}</div>}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              disabled={busy}
              className={
                'shrink-0 rounded p-1 text-lg leading-none text-ink-muted transition-colors '
                + 'hover:bg-canvas hover:text-ink focus-visible:outline-none '
                + 'focus-visible:ring-2 focus-visible:ring-brand-500/40 '
                + 'disabled:pointer-events-none disabled:opacity-50'
              }
            >
              &times;
            </button>
          </div>

          {/* The body scrolls, the header and footer do not — a long form must
              not push its own Save button off the bottom of the screen. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
/**
 * Label + control + optional hint.
 *
 * NOTE ON THE DUPLICATE. components/ui/Form.tsx also exports a `Field`, and yes,
 * two Fields is how this repo ended up with four of them. They are not merged
 * yet for one concrete reason: this one WRAPS its children in the <label>, so
 * the label is tied to the control by containment and keeps working for the ten
 * pages that pass a plain <input>. Form's Field puts the label beside the
 * control and links it by id, which is better — but only when the caller uses
 * its render-prop form. Delegating this one to that one today would silently
 * unlink the label on every one of those ten pages.
 *
 * The merge is real work, not a rename: convert those call sites to the render
 * form first, then delete this. Until then this exists and is styled the same,
 * so at least the two look identical.
 */
export function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  required?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-4 block w-full">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">
        {label}
        {/* Decoration only — the control itself carries `required`, which is
            what the browser and a screen reader actually act on. */}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {/* The hint SURVIVES the error rather than being replaced by it: the
          instruction is most useful at the moment you got it wrong. */}
      {hint && <span className="mt-1.5 block text-xs text-ink-muted">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1.5 block text-xs font-medium text-danger">{error}</span>
      )}
    </label>
  );
}

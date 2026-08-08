'use client';

import { useEffect } from 'react';

/**
 * A dialog in YZEN's modal markup, driven by React rather than Bootstrap's JS.
 *
 * The bundle ships no Bootstrap JavaScript — `.modal.show.d-block` plus a
 * sibling backdrop needs none. Closing is wired here so every dialog in the
 * console behaves the same way: Escape, the × button, or a press on the
 * backdrop, and none of them while a save is in flight, because a dialog that
 * vanishes mid-write leaves you unsure whether the write happened.
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
  size?: 'sm' | 'md' | 'lg';
  /** Blocks every dismissal path while a request is in flight. */
  busy?: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const width = size === 'lg' ? ' modal-lg' : size === 'sm' ? ' modal-sm' : '';

  return (
    <>
      <div
        className="modal fade show d-block"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        // Only a press that both starts AND lands on the backdrop closes it —
        // otherwise a text selection that drags out of the dialog would.
        onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className={`modal-dialog modal-dialog-centered modal-dialog-scrollable${width}`} role="document">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h6 className="modal-title">{title}</h6>
                {subtitle && <div className="fs-12 text-muted mt-1">{subtitle}</div>}
              </div>
              <button type="button" className="btn-close" aria-label="Close"
                      onClick={onClose} disabled={busy} />
            </div>

            <div className="modal-body">{children}</div>

            {footer && <div className="modal-footer">{footer}</div>}
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" />
    </>
  );
}

/** Label + control + optional hint, in YZEN's form classes. */
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
    <label className="d-block mb-3 w-100">
      <span className="form-label">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {error
        ? <span className="d-block fs-12 text-danger mt-1">{error}</span>
        : hint ? <span className="d-block fs-12 text-muted mt-1">{hint}</span> : null}
    </label>
  );
}

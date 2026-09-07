'use client';

// ============================================================================
//  Form controls — the second half of the component set.
//
//  Kit.tsx has the containers (Card, Table, Stat, Badge, Button). This file
//  has the things a person types into. They did not exist as components: every
//  form in the product hand-wrote a <label> and an <input className="form-
//  control">, which is why no two of them agree about where the hint goes, how
//  an error reads, or whether the label is clickable.
//
//  Built 7 Sept 2026, stage 2 of docs/UI_LANE_BRIEF.md.
//
//  ---------------------------------------------------------------------------
//  THREE THINGS THESE DO THAT HAND-WRITTEN MARKUP KEPT GETTING WRONG.
//
//  1. THE LABEL IS ALWAYS TIED TO THE CONTROL. Field generates an id when it is
//     not given one and passes it down, so clicking the label focuses the
//     input and a screen reader announces the two together. A <label> floating
//     above an <input> looks identical and does neither.
//
//  2. AN ERROR IS ANNOUNCED, NOT JUST COLOURED. aria-invalid and
//     aria-describedby are wired to the message, and the message has
//     role="alert". Red text alone is invisible to anyone who cannot see red —
//     and to everyone using a screen reader.
//
//  3. THE HINT SURVIVES THE ERROR. Showing the error INSTEAD of the hint takes
//     away the instruction at the moment the person most needs it. Both show.
//  ---------------------------------------------------------------------------
// ============================================================================

import { useId } from 'react';

// ---------------------------------------------------------------------------
//  Shared control chrome. One definition, so an input, a select and a textarea
//  cannot drift into three slightly different boxes.
const CONTROL =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink '
  + 'placeholder:text-ink-faint '
  + 'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 '
  + 'disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-muted';

const CONTROL_INVALID = 'border-danger focus:border-danger focus:ring-danger/25';

function controlClass(invalid: boolean, extra = '') {
  return `${CONTROL} ${invalid ? CONTROL_INVALID : ''} ${extra}`.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
export function Field({
  label, hint, error, required, htmlFor, children, className = '',
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Supply when the control has its own id; otherwise Field makes one. */
  htmlFor?: string;
  children: (props: { id: string; invalid: boolean; describedBy?: string }) => React.ReactNode;
  className?: string;
}) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`mb-4 ${className}`.trim()}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-ink">
        {label}
        {/* The asterisk is decoration; the control carries `required`, which is
            what a screen reader and the browser both act on. */}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </label>

      {children({ id, invalid: Boolean(error), describedBy })}

      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-ink-muted">{hint}</p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-danger">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
type NativeInput = React.InputHTMLAttributes<HTMLInputElement>;

export function Input({
  invalid = false, describedBy, className = '', ...rest
}: { invalid?: boolean; describedBy?: string; className?: string } & NativeInput) {
  return (
    <input
      className={controlClass(invalid, className)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );
}

export function Textarea({
  invalid = false, describedBy, className = '', rows = 4, ...rest
}: { invalid?: boolean; describedBy?: string; className?: string }
  & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      className={controlClass(invalid, `resize-y ${className}`)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );
}

export function Select({
  invalid = false, describedBy, className = '', children, ...rest
}: { invalid?: boolean; describedBy?: string; className?: string; children: React.ReactNode }
  & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={controlClass(invalid, `pr-8 ${className}`)}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
/**
 * Checkbox with its label inline, because a tick box with the text beside it
 * is one target: the whole row is clickable, which matters most on a phone.
 */
export function Checkbox({
  label, hint, className = '', id: givenId, ...rest
}: { label: React.ReactNode; hint?: string; className?: string }
  & React.InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId();
  const id = givenId ?? generated;
  return (
    <div className={`mb-3 ${className}`.trim()}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          className={
            'mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border border-line '
            + 'accent-brand-500 focus-visible:outline-none focus-visible:ring-2 '
            + 'focus-visible:ring-brand-500/40 disabled:cursor-not-allowed'
          }
          {...rest}
        />
        <span className="text-sm text-ink">{label}</span>
      </label>
      {hint && <p className="ml-[26px] mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * A row of actions at the foot of a form. Right-aligned on a wide screen,
 * full-width and stacked on a narrow one — a primary button you cannot reach
 * with a thumb is a form nobody finishes.
 */
export function FormActions({ children, className = '' }: {
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end ${className}`.trim()}>
      {children}
    </div>
  );
}

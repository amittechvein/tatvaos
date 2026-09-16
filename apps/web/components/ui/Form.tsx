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
  /**
   * PREFER THE FUNCTION FORM. Given a function, Field hands down the generated
   * id, the invalid flag and the aria-describedby, so the label is tied to the
   * control and the error is announced — the whole point of the component.
   *
   * Plain children are also accepted, and that is a MIGRATION AFFORDANCE, not
   * an equal choice: the label cannot be linked to a control it never sees, so
   * clicking it will not focus the input and a screen reader will read the two
   * as unrelated. It exists because several pages already call a local Field
   * this way, and holding the whole migration hostage to rewriting every call
   * site would keep those pages on Bootstrap for longer — which is worse.
   * Convert to the function form whenever you are in the file anyway.
   */
  children:
    | React.ReactNode
    | ((props: { id: string; invalid: boolean; describedBy?: string }) => React.ReactNode);
  className?: string;
}) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  // Only claim a `for` when something will actually carry that id: the render
  // function receives it, and an explicit htmlFor means the caller wired it.
  // With plain children the label has no control to point at, and a `for`
  // aimed at an id that does not exist is worse than none — a screen reader
  // follows it, finds nothing, and reads the field as unlabelled.
  const linked = typeof children === 'function' || Boolean(htmlFor);

  return (
    <div className={`mb-4 ${className}`.trim()}>
      <label htmlFor={linked ? id : undefined}
             className="mb-1.5 block text-[13px] font-medium text-ink">
        {label}
        {/* The asterisk is decoration; the control carries `required`, which is
            what a screen reader and the browser both act on. */}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </label>

      {typeof children === 'function'
        ? children({ id, invalid: Boolean(error), describedBy })
        : children}

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
 * A field with a fixed unit or domain glued to its right edge — "30 [GB]",
 * "admissions [@school.edu.in]".
 *
 * One control, not a field with a caption beside it: the two share a border
 * and cannot wrap apart. The suffix is static text, never a control.
 */
export function InputSuffix({
  suffix, className = '', invalid = false, ...rest
}: { suffix: React.ReactNode; className?: string; invalid?: boolean } & NativeInput) {
  return (
    <div className={`flex items-stretch ${className}`.trim()}>
      <Input invalid={invalid} className="rounded-r-none" {...rest} />
      <span className="inline-flex shrink-0 items-center rounded-r-lg border border-l-0 border-line bg-canvas px-3 text-sm text-ink-muted">
        {suffix}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * A switch: the same choice as a checkbox, drawn as a track and a knob, for
 * settings that take effect as they are flipped rather than on a Save button.
 *
 * It is a REAL checkbox with role="switch", visually hidden behind the track.
 * Keyboard focus, space to toggle, and what a screen reader announces are the
 * browser's, not ours. YZEN drew its switch with a background image, which is
 * why the one it replaces could not take our colours.
 */
export function Switch({
  label, hint, className = '', id: givenId, ...rest
}: { label: React.ReactNode; hint?: string; className?: string }
  & React.InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId();
  const id = givenId ?? generated;
  return (
    <div className={`mb-3 ${className}`.trim()}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
        <span className="relative mt-0.5 inline-flex shrink-0">
          <input id={id} type="checkbox" role="switch" className="peer sr-only" {...rest} />
          <span aria-hidden="true"
                className={
                  'block h-5 w-9 rounded-full bg-line transition-colors '
                  + 'peer-checked:bg-brand-500 peer-disabled:opacity-50 '
                  + 'peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40'
                } />
          <span aria-hidden="true"
                className={
                  'pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full '
                  + 'bg-surface shadow-card transition-transform peer-checked:translate-x-4'
                } />
        </span>
        <span className="text-sm text-ink">{label}</span>
      </label>
      {hint && <p className="ml-12 mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
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

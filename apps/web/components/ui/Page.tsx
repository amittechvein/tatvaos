'use client';

// ============================================================================
//  Page-level furniture: the header every screen opens with, tabs, and the
//  inline message a screen uses to say something went right or wrong.
//
//  Built 7 Sept 2026, stage 2 of docs/UI_LANE_BRIEF.md.
//
//  These exist because every page currently invents them. The org console has
//  four different page headings, two of which put the action button in a
//  different place; Family and Mail disagree about what a tab looks like; and
//  "saved" messages range from a green Bootstrap alert to a line of small grey
//  text. None of that is a decision anyone made — it is what happens when the
//  shape is retyped each time.
// ============================================================================

import Link from 'next/link';

// ---------------------------------------------------------------------------
/**
 * The top of a screen: what this page is, optionally where it sits, and the
 * one or two things you can do here.
 *
 * The actions sit on the same row as the title on a wide screen and drop below
 * it on a narrow one, rather than being squeezed — a truncated "Add person" is
 * worse than a button on its own line.
 */
export function PageHeader({
  title, subtitle, breadcrumb, actions, className = '',
}: {
  title: string;
  subtitle?: string;
  /** e.g. [{ label: 'Organisation', href: '/org' }, { label: 'People' }] */
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-6 ${className}`.trim()}>
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5">
          <ol className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            {breadcrumb.map((c, i) => (
              <li key={c.label} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true" className="text-ink-faint">/</span>}
                {c.href ? (
                  <Link href={c.href} className="hover:text-ink hover:underline">{c.label}</Link>
                ) : (
                  // The current page is not a link, and is marked as current
                  // rather than just being the last one visually.
                  <span aria-current="page">{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-ink-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * Tabs that are LINKS, not buttons, because each one is a URL you should be
 * able to bookmark, open in a new tab, and land on after a refresh. The
 * current tab is marked with aria-current, so it is not signalled by colour
 * alone — the same rule the sidebar's active item follows.
 */
export function Tabs({ items, current, className = '' }: {
  items: { label: string; href: string; count?: number }[];
  /** The href of the active tab. */
  current: string;
  className?: string;
}) {
  return (
    <div className={`mb-5 border-b border-line ${className}`.trim()}>
      <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Sections">
        {items.map((t) => {
          const active = t.href === current;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={
                'whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors '
                + (active
                  ? 'border-brand-500 text-brand-700'
                  : 'border-transparent text-ink-muted hover:border-line hover:text-ink')
              }
            >
              {t.label}
              {typeof t.count === 'number' && (
                <span className={
                  'ml-2 rounded-full px-1.5 py-0.5 text-[11px] font-semibold '
                  + (active ? 'bg-brand-500/10 text-brand-700' : 'bg-canvas text-ink-muted')
                }>
                  {t.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
type AlertTone = 'info' | 'ok' | 'warn' | 'danger';

const ALERT: Record<AlertTone, string> = {
  info:   'border-info/30 bg-info/5 text-ink',
  ok:     'border-ok/30 bg-ok/5 text-ink',
  warn:   'border-warn/30 bg-warn/5 text-ink',
  danger: 'border-danger/30 bg-danger/5 text-ink',
};

const ALERT_MARK: Record<AlertTone, string> = {
  info: 'bg-info', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger',
};

/**
 * An inline message about something that just happened, or a standing warning.
 *
 * role="status" for the calm tones and role="alert" for danger: alert
 * interrupts a screen reader mid-sentence, which is right for "this failed"
 * and rude for "saved". The coloured bar down the left carries the meaning for
 * anyone who cannot separate the tints.
 */
export function Alert({
  tone = 'info', title, children, action, onDismiss, className = '',
}: {
  tone?: AlertTone;
  title?: string;
  children?: React.ReactNode;
  /**
   * The one thing to do about this message — almost always "Try again" on a
   * load failure. It sits at the end of the row, beside the dismiss button if
   * there is one, and drops below the text when the alert is too narrow to
   * hold both. Put a control here rather than inside `children`: in children
   * it lands under the text as another paragraph.
   */
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`relative mb-4 overflow-hidden rounded-lg border py-3 pl-4 pr-3 text-sm ${ALERT[tone]} ${className}`.trim()}
    >
      <span aria-hidden="true"
            className={`absolute inset-y-0 left-0 w-1 ${ALERT_MARK[tone]}`} />
      <div className="flex flex-wrap items-start justify-between gap-3 pl-2">
        <div className="min-w-0 flex-1">
          {title && <div className="font-semibold text-ink">{title}</div>}
          {children && <div className={title ? 'mt-0.5 text-ink-muted' : 'text-ink'}>{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded p-1 text-ink-faint hover:bg-canvas hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * The strip above a list: a search box on the left, filters and actions on the
 * right, wrapping rather than truncating.
 */
export function Toolbar({ children, className = '' }: {
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-2 ${className}`.trim()}>
      {children}
    </div>
  );
}

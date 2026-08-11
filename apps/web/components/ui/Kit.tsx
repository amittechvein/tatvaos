'use client';

// ============================================================================
//  The primitives every screen is built from — now YZEN Bootstrap markup.
//
//  These were MUI wrappers, which broke the moment YZEN's Bootstrap CSS was
//  loaded globally (two styling systems fighting over the same elements — the
//  empty stat cards and orange buttons were exactly that). Rewritten to emit
//  YZEN's own classes (.card.custom-card, .btn, .avatar, .table, .badge), so
//  their real stylesheet styles them pixel-for-pixel and every page that
//  imports these follows without change.
// ============================================================================

import Link from 'next/link';

// ---------------------------------------------------------------------------
export function Card({
  title, subtitle, actions, children, className = '', padded = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={`card custom-card ${className}`.trim()}>
      {(title || actions) && (
        <div className="card-header justify-content-between align-items-center">
          <div className="card-title">
            {title}
            {subtitle && (
              <span className="d-block fs-12 fw-normal text-muted mt-1">{subtitle}</span>
            )}
          </div>
          {actions && <div className="d-flex gap-2 flex-wrap">{actions}</div>}
        </div>
      )}
      {padded ? <div className="card-body">{children}</div> : children}
    </div>
  );
}

// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BTN: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-outline-light',
  ghost: 'btn-light',
  danger: 'btn-danger',
};

export function Button({
  variant = 'secondary', className = '', href, children, ...rest
}: {
  variant?: Variant;
  className?: string;
  href?: string;
  children?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `btn ${BTN[variant]} ${className}`.trim();
  if (href) {
    // Only onClick is forwarded to link-buttons; spreading button attributes
    // onto a Next Link is a type mismatch and none of the others apply here.
    return (
      <Link href={href} className={cls}
            onClick={rest.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}>
        {children}
      </Link>
    );
  }
  return <button type="button" className={cls} {...rest}>{children}</button>;
}

// ---------------------------------------------------------------------------
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const TONE_BADGE: Record<Tone, string> = {
  ok: 'success', warn: 'warning', danger: 'danger', info: 'info', neutral: 'secondary',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`badge bg-${TONE_BADGE[tone]}-transparent`}>{children}</span>;
}

/** Maps a status string to a tone in one place, so every screen agrees. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'active': return 'ok';
    case 'trial': case 'pending': return 'warn';
    case 'suspended': case 'deleted': case 'past_due': return 'danger';
    default: return 'neutral';
  }
}

// ---------------------------------------------------------------------------
const TONE_BG: Record<string, string> = {
  primary: 'primary', info: 'info', success: 'success', warning: 'warning', error: 'danger',
};

export function Stat({
  label, value, caption, delta, icon, tone = 'primary',
}: {
  label: string;
  value: string;
  caption?: string;
  delta?: { value: string; direction: 'up' | 'down'; good?: boolean };
  icon?: React.ReactNode;
  tone?: 'primary' | 'info' | 'success' | 'warning' | 'error';
}) {
  const positive = delta ? (delta.good ?? delta.direction === 'up') : false;
  // Vertical layout: the label owns the full card width on its own row (with a
  // small tinted icon chip pinned to the right), the value sits large below, and
  // the caption/delta spans the full width underneath. This is what stops the
  // labels and captions from being squeezed against the icon and truncating in
  // the tight 4-up grid — every text line now has the whole card to breathe.
  const c = TONE_BG[tone] ?? 'primary';
  return (
    <div className="card custom-card">
      <div className="card-body">
        <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
          <span className="fw-medium fs-13 text-muted">{label}</span>
          {icon && (
            <span className={`avatar avatar-sm bg-${c}-transparent text-${c} flex-shrink-0`}>
              {icon}
            </span>
          )}
        </div>
        <div className="fs-24 fw-semibold lh-1">{value}</div>
        {delta ? (
          <div className="d-flex align-items-center flex-wrap gap-1 fs-12 mt-2">
            <span className={`fw-semibold ${positive ? 'text-success' : 'text-danger'}`}>
              {positive ? '↑' : '↓'} {delta.value}
            </span>
            {caption && <span className="text-muted">{caption}</span>}
          </div>
        ) : caption ? (
          <div className="fs-12 text-muted mt-2">{caption}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// head takes nodes rather than strings so a table can put a control in its
// own header — a select-all checkbox belongs at the top of the column it
// selects, not floating in the toolbar above the table.
export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="table-responsive">
      <table className="table text-nowrap table-hover">
        <thead>
          <tr>
            {head.map((h, i) => (
              // Keyed by position: a heading may now be an element, and two
              // blank headings are not distinguishable by their content.
              // eslint-disable-next-line react/no-array-index-key
              <th key={i} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={className}>{children}</td>;
}

// ---------------------------------------------------------------------------
/**
 * A progress bar that changes colour as it fills. Thresholds match
 * StorageAllocator: 80% warns, 95% blocks.
 */
export function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const colour = pct >= 95 ? 'danger' : pct >= 80 ? 'warning' : 'primary';
  return (
    <div className="progress progress-sm" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-bar bg-${colour}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="text-center py-5 px-3">
      <div className="fw-semibold fs-15">{title}</div>
      {hint && (
        <div className="text-muted fs-13 mt-1 mx-auto" style={{ maxWidth: 420 }}>{hint}</div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

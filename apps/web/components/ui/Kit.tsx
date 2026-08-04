'use client';

// ============================================================================
//  The primitives every screen is built from.
//
//  In one file on purpose. Six files each holding a fifteen-line component
//  makes the set harder to see whole, and the point of a kit is that someone
//  can read it in one sitting and know what already exists rather than
//  inventing a seventh button.
// ============================================================================

// ---------------------------------------------------------------------------
export function Card({
  title, subtitle, actions, children, className = '', padded = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Off for tables, which manage their own edge-to-edge padding. */
  padded?: boolean;
}) {
  return (
    <section className={`rounded-card border border-line bg-surface shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold uppercase tracking-wide text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
          </div>
          {actions && <div className="ml-auto flex gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON: Record<ButtonVariant, string> = {
  primary:   'bg-brand-600 text-white hover:bg-brand-700 shadow-card',
  secondary: 'bg-surface text-ink border border-line hover:border-ink-faint',
  ghost:     'text-ink-muted hover:bg-canvas hover:text-ink',
  // Destructive actions are red everywhere, and red is not themeable. A
  // customer picking a green accent must not end up with a green Delete.
  danger:    'bg-danger text-white hover:brightness-95',
};

export function Button({
  variant = 'secondary', className = '', children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-card px-4 py-2 text-[13px] font-medium
                  transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const TONE: Record<Tone, string> = {
  ok:      'bg-ok/12 text-ok',
  warn:    'bg-warn/15 text-warn',
  danger:  'bg-danger/12 text-danger',
  info:    'bg-info/12 text-info',
  neutral: 'bg-ink-muted/12 text-ink-muted',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold capitalize ${TONE[tone]}`}>
      {children}
    </span>
  );
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
/**
 * A headline number with its caption and a circular icon — the tile that runs
 * across the top of every dashboard in the reference.
 */
export function Stat({
  label, value, caption, delta, icon,
}: {
  label: string;
  value: string;
  caption?: string;
  delta?: { value: string; direction: 'up' | 'down'; good?: boolean };
  icon?: React.ReactNode;
}) {
  // Up is not automatically good. Storage used rising is not a success, so
  // callers say what they mean rather than the component guessing from an
  // arrow direction.
  const positive = delta ? (delta.good ?? delta.direction === 'up') : false;

  return (
    <div className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-label font-semibold uppercase text-ink-muted">{label}</p>
          {caption && <p className="mt-1 text-[12px] text-ink-faint">{caption}</p>}
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
          {delta && (
            <p className={`mt-1.5 text-[12px] ${positive ? 'text-ok' : 'text-danger'}`}>
              <span className="font-semibold">{delta.value}</span>{' '}
              <span className="text-ink-muted">{delta.direction === 'up' ? 'higher' : 'lower'}</span>
            </p>
          )}
        </div>
        {icon && (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            {icon}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-5 py-3 text-label font-semibold uppercase text-ink-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-5 py-3 align-middle text-ink ${className}`}>{children}</td>;
}

// ---------------------------------------------------------------------------
/**
 * A progress bar that changes colour as it fills.
 *
 * The thresholds are the same ones StorageAllocator enforces on the server:
 * 80% warns, 95% blocks new users. Showing amber at the point the backend
 * starts warning means the screen and the API tell the same story.
 */
export function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const colour = pct >= 95 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-brand-500';

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="progressbar"
         aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-all ${colour}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-muted">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

'use client';

// ============================================================================
//  The primitives every screen is built from — Tailwind and the design tokens.
//
//  HISTORY, because it explains the shape. These were MUI wrappers; they broke
//  when YZEN's Bootstrap CSS was loaded globally (two styling systems fighting
//  over the same elements — the empty stat cards and orange buttons were that
//  fight). They were then rewritten to emit YZEN's OWN classes so their
//  stylesheet styled them pixel-for-pixel.
//
//  7 Sept 2026: rewritten again, onto Tailwind and the tokens in
//  styles/globals.css. This file is the lever for the whole UI lane —
//  THIRTY-ONE files import it, so moving it moves them without touching any of
//  them. That is stage 3 of docs/UI_LANE_BRIEF.md done wholesale rather than
//  file by file.
//
//  THE PUBLIC SHAPE IS UNCHANGED, deliberately: same exports, same props, same
//  defaults. A caller that renders correctly today renders correctly after
//  this. Anything that looks different is this file's fault, not the caller's,
//  which is what makes it revertible in one commit.
//
//  WHAT THIS DOES NOT DO. The pages that import these still sit inside YZEN's
//  grid (`row`, `col-md-*`) and inside its app shell. Those are stage 3's long
//  tail and stage 4. Components first, layout after — migrating both at once
//  means a broken page cannot be told from a deliberate one.
//
//  NOTE ON BORDERS. Tailwind's preflight is off here, so `border` sets a WIDTH
//  against a style of `none` and renders nothing. globals.css supplies
//  `border-style: solid` for that reason. If a border ever vanishes, that rule
//  is the first place to look — not the token.
// ============================================================================

import Link from 'next/link';
import { useId } from 'react';

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
  //  min-w-0 IS LOAD-BEARING, and it is not obvious.
  //
  //  A grid or flex ITEM defaults to min-width:auto, which means "never shrink
  //  below my content's minimum". Put a Card holding a table inside
  //  `grid lg:grid-cols-2` and, at phone width, the table's intrinsic width
  //  pushes the track out: measured on /org/storage at 375px, the grid
  //  container was correctly 351px while its computed grid-template-columns
  //  was 569px. The card grew to 569, the page to 601, and the whole console
  //  scrolled sideways.
  //
  //  The table's own overflow-x-auto never got a chance — a scroll container
  //  only scrolls when it is FORCED to be narrower than its content, and
  //  nothing was forcing it. min-w-0 is what forces it.
  return (
    <div className={`min-w-0 rounded-card border border-line bg-surface shadow-card ${className}`.trim()}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <span className="text-[15px] font-semibold text-ink">{title}</span>}
            {subtitle && (
              <span className="mt-0.5 block text-xs font-normal text-ink-muted">{subtitle}</span>
            )}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {padded ? <div className="px-5 py-4">{children}</div> : children}
    </div>
  );
}

// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

//  One base, four intents. Focus is a visible ring rather than an outline the
//  browser draws differently per platform — a keyboard user has to be able to
//  see where they are, and on a violet primary the default outline is nearly
//  invisible.
const BTN_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg '
  + 'px-4 py-2 text-sm font-semibold transition-colors '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 '
  + 'disabled:pointer-events-none disabled:opacity-50';

const BTN: Record<Variant, string> = {
  primary:   'bg-brand-500 text-white hover:bg-brand-600',
  secondary: 'border border-line bg-surface text-ink hover:bg-canvas',
  ghost:     'text-ink-muted hover:bg-canvas hover:text-ink',
  danger:    'bg-danger text-white hover:brightness-95',
};

export function Button({
  variant = 'secondary', className = '', href, children, ...rest
}: {
  variant?: Variant;
  className?: string;
  href?: string;
  children?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `${BTN_BASE} ${BTN[variant]} ${className}`.trim();
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

//  Tinted pills, not solid blocks. A table of twenty rows with twenty
//  saturated badges reads as an alarm; the tint carries the same meaning and
//  lets the row's actual content stay the loudest thing on the line.
const TONE_BADGE: Record<Tone, string> = {
  ok:      'bg-ok/10 text-ok',
  warn:    'bg-warn/10 text-warn',
  danger:  'bg-danger/10 text-danger',
  info:    'bg-info/10 text-info',
  neutral: 'border border-line bg-canvas text-ink-muted',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_BADGE[tone]}`}>
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
const TONE_CHIP: Record<string, string> = {
  primary: 'bg-brand-500/10 text-brand-700',
  info:    'bg-info/10 text-info',
  success: 'bg-ok/10 text-ok',
  warning: 'bg-warn/10 text-warn',
  error:   'bg-danger/10 text-danger',
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
  // small tinted icon chip pinned to the right), the value sits large below,
  // and the caption/delta spans the full width underneath. That is what stops
  // labels and captions being squeezed against the icon and truncating in the
  // tight 4-up grid — every text line has the whole card to breathe.
  const chip = TONE_CHIP[tone] ?? TONE_CHIP.primary;
  return (
    <div className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink-muted">{label}</span>
        {icon && (
          <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${chip}`}>
            {icon}
          </span>
        )}
      </div>
      <div className="text-2xl font-semibold leading-none text-ink">{value}</div>
      {delta ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <span className={`font-semibold ${positive ? 'text-ok' : 'text-danger'}`}>
            {positive ? '↑' : '↓'} {delta.value}
          </span>
          {caption && <span className="text-ink-muted">{caption}</span>}
        </div>
      ) : caption ? (
        <div className="mt-2 text-xs text-ink-muted">{caption}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// head takes nodes rather than strings so a table can put a control in its own
// header — a select-all checkbox belongs at the top of the column it selects,
// not floating in the toolbar above the table.
//
// Row and cell styling is applied from the <table> with arbitrary variants
// rather than on each <Td>, because callers render their own <tr> (and
// sometimes raw <td>) and those have to look right too.
//
//  ON A PHONE A TABLE IS NOT A TABLE.
//
//  Measured on /admin at 375px on 8 Sept 2026: the table was 660px wide inside
//  a 390px container. 270px of every row sat off-screen, reachable only by
//  scrolling sideways — so "how much storage is this organisation using" meant
//  dragging each row horizontally and losing which row you were on. That is
//  what "the UI is not compatible with mobile" meant, and it came from one
//  word: whitespace-nowrap.
//
//  Below 640px each row becomes a stacked block: label on the left, value on
//  the right, one line per field. The labels come from `head`, so THE CALLERS
//  DO NOT CHANGE — the same trick that made this file a lever in the first
//  place. Rules are nth-child based, which is why they also reach the raw <td>
//  that several pages render instead of <Td>.
//
//  Only STRING headings become labels. A heading that is a node — a select-all
//  checkbox, an empty action column — gets no label rather than a mangled one,
//  and its cell simply spans the row.
//
//  The scroll container stays for the desktop case, where a wide table with a
//  scrollbar is correct and a stacked one would be absurd.
export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const cls = `tv-t${id}`;

  // CSS content strings need their quotes and backslashes escaped, or one
  // heading with an apostrophe silently breaks every rule after it.
  const label = (h: React.ReactNode) =>
    typeof h === 'string' && h.trim()
      ? h.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      : null;

  const cellRules = head.map((h, i) => {
    const l = label(h);
    return l
      ? `.${cls} tbody td:nth-child(${i + 1})::before{content:"${l}";`
        + 'color:rgb(var(--ink-muted));font-size:11px;font-weight:600;'
        + 'text-transform:uppercase;letter-spacing:.04em;padding-right:1rem;flex:0 0 auto}'
      : `.${cls} tbody td:nth-child(${i + 1}){justify-content:flex-start}`;
  }).join('');

  const css =
    `@media (max-width:639px){`
    // The wrapper's -mx-5/px-5 exists to let a wide table bleed to the card's
    // edges and scroll. Stacked rows never scroll, so those negative margins
    // only make the element 40px wider than its parent - which is where the
    // stubborn 7px of page overflow on every table page came from.
    + `.${cls}-w{margin-left:0;margin-right:0;padding-left:0;padding-right:0;overflow-x:visible}`
    + `.${cls}{white-space:normal}`
    // display:none rather than a clipped off-screen thead. Absolutely
    // positioning a <thead> inside a table is asking the layout engine to do
    // something it has no good answer for. Nothing is lost to a screen reader:
    // every cell carries its own label from ::before at this width.
    + `.${cls} thead{display:none}`
    + `.${cls} tbody tr{display:block;padding:.75rem 0}`
    + `.${cls} tbody td{display:flex;align-items:center;justify-content:space-between;`
    + `gap:.75rem;padding:.25rem 0;text-align:right;min-width:0;`
    // overflow-wrap:anywhere is NOT belt-and-braces, it is the difference
    // between stacking working and half-working. `white-space:normal` only
    // lets text wrap AT SPACES — and the values in these tables are email
    // addresses, UUIDs, IP addresses and domain names, which contain none.
    // Measured after the first deploy: /org/audit still rendered a 412px table
    // on a 375px screen because one unbreakable token per row set the floor,
    // while /org/mailboxes (short values) had already dropped to 306px.
    + `overflow-wrap:anywhere;word-break:break-word}`
    + cellRules
    + `}`;

  return (
    <div className={`${cls}-w -mx-5 overflow-x-auto px-5`}>
      {/* A STRING CHILD, not dangerouslySetInnerHTML. React 19 supports style
          tags with their CSS as children, so there is no need to reach for the
          escape hatch — and `react/no-danger` is an error in this repo's lint,
          which caught the first version of this in CI. Disabling that rule to
          keep a habit would have been the wrong trade: the rule is right, the
          code just did not need the API.

          The heading text is ours, from `head`, and escaped above; it is never
          user-supplied, which is what makes generating a stylesheet safe. */}
      <style>{css}</style>
      <table
        className={
          `${cls} w-full border-collapse whitespace-nowrap text-sm text-ink `
          + '[&_th]:border-b [&_th]:border-line [&_th]:px-4 [&_th]:py-3 '
          // ink-MUTED, not ink-faint. Faint measured 2.78 against white on
          // /org/users — below the 4.5 a column heading needs, and a heading
          // is functional text: you cannot read the table without it. Faint is
          // for decoration and disabled states only.
          + '[&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold '
          + '[&_th]:uppercase [&_th]:tracking-wider [&_th]:text-ink-muted '
          + '[&_td]:px-4 [&_td]:py-3 [&_td]:align-middle '
          + '[&_tbody_tr]:border-b [&_tbody_tr]:border-line '
          + '[&_tbody_tr:last-child]:border-0 [&_tbody_tr:hover]:bg-canvas'
        }
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              // Keyed by position: a heading may be an element, and two blank
              // headings are not distinguishable by their content.
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
export function Meter({ used, total, tone }: {
  used: number;
  total: number;
  /**
   * Overrides the computed colour.
   *
   * The 80/95 thresholds below are a convenience for callers that have nothing
   * better. Where the SERVER decides — org storage returns isWarning/isCritical,
   * and the same flags gate whether a user can be added — pass the tone through
   * instead. Two copies of a threshold eventually disagree, and the version that
   * blocks the action is the one that matters.
   */
  tone?: 'ok' | 'warn' | 'danger';
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const computed = pct >= 95 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-brand-500';
  const colour = tone
    ? ({ ok: 'bg-brand-500', warn: 'bg-warn', danger: 'bg-danger' } as const)[tone]
    : computed;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full rounded-full transition-[width] duration-200 ${colour}`}
           style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      {hint && (
        <div className="mx-auto mt-1 max-w-[420px] text-[13px] text-ink-muted">{hint}</div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

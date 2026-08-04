'use client';

// ============================================================================
//  Charts, as plain SVG.
//
//  No charting library. Recharts and friends are 40–120 kB for what amounts to
//  a handful of rectangles and one arc, they bring their own colour system
//  that then has to be taught about our CSS variables, and they render to
//  canvas or a DOM tree we do not control. These are a few dozen lines each,
//  inherit the theme automatically because they use Tailwind colour classes,
//  and stay legible in dark mode without a second configuration.
//
//  When the product needs zoom, brushing or live streaming, revisit. It does
//  not yet.
// ============================================================================

export interface Series {
  label: string;
  value: number;
}

// ---------------------------------------------------------------------------
export function BarChart({
  data, height = 180, format,
}: {
  data: Series[];
  height?: number;
  format?: (n: number) => string;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d) => {
          const pct = (d.value / max) * 100;
          return (
            <div key={d.label} className="group flex flex-1 flex-col items-center justify-end gap-1.5">
              {/* Title rather than a bespoke tooltip: it is keyboard and screen
                  reader accessible, and needs no positioning logic. */}
              <div
                title={`${d.label}: ${format ? format(d.value) : d.value}`}
                className="w-full max-w-[26px] rounded-t bg-brand-500 transition-all group-hover:bg-brand-600"
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
              <span className="text-[10px] text-ink-faint">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * A ring with a figure in the middle.
 *
 * strokeDasharray on a circle rather than an arc path — the maths is one line
 * instead of polar-to-cartesian conversion, and it animates for free.
 */
export function Donut({
  value, total, label, size = 140,
}: {
  value: number;
  total: number;
  label?: string;
  size?: number;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  const r = (size - 18) / 2;
  const circumference = 2 * Math.PI * r;

  // Same thresholds StorageAllocator enforces on the server: 80% warns, 95%
  // blocks. The screen and the API tell the same story.
  const colour = pct >= 95 ? 'text-danger' : pct >= 80 ? 'text-warn' : 'text-brand-500';

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={r}
          className="text-line" stroke="currentColor" strokeWidth="10" fill="none"
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          className={`${colour} transition-all duration-500`}
          stroke="currentColor" strokeWidth="10" fill="none" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (pct / 100) * circumference}
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-xl font-semibold text-ink">{Math.round(pct)}%</div>
        {label && <div className="text-[11px] text-ink-muted">{label}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * A trend line with a soft fill. Deliberately unlabelled — a sparkline shows
 * shape, not values; if the reader needs numbers they need a real chart.
 */
export function Sparkline({
  data, height = 48,
}: {
  data: number[];
  height?: number;
}) {
  if (data.length < 2) return <div style={{ height }} />;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const step = 100 / (data.length - 1);

  const points = data.map((v, i) => `${i * step},${100 - ((v - min) / span) * 100}`);
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L 100,100 L 0,100 Z`;

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="w-full">
      <path d={area} className="fill-brand-500/12" />
      <path
        d={line}
        className="stroke-brand-500"
        fill="none"
        strokeWidth="2"
        // Without this the stroke is scaled by the non-uniform viewBox and
        // ends up thick horizontally and thin vertically.
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
/** Stacked proportions on one row — how a pool is split across products. */
export function SplitBar({ parts }: { parts: { label: string; value: number; colour: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;

  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line">
        {parts.map((p) => (
          <div
            key={p.label}
            title={`${p.label}: ${Math.round((p.value / total) * 100)}%`}
            style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.colour }}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.colour }} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

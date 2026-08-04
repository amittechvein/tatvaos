import { formatBytes, quotaPercent } from '@tatvaos/core';

export function StorageBar({
  used,
  total,
  compact = false,
}: {
  used: number;
  total: number;
  compact?: boolean;
}) {
  const pct = quotaPercent(used, total);
  const tone = pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-brand-500';

  return (
    <div className={compact ? 'w-32' : 'w-full'}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-ink-muted">
        {formatBytes(used)} / {formatBytes(total)} ({pct}%)
      </div>
    </div>
  );
}

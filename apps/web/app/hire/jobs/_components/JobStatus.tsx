import { Badge } from '@/components/ui/Kit';

export type JobStatus = 'draft' | 'open' | 'on_hold' | 'closed';

export const STATUS_LABEL: Record<JobStatus, string> = {
  draft: 'Draft', open: 'Open', on_hold: 'On hold', closed: 'Closed',
};

export function StatusBadge({ status, reason }: { status: JobStatus; reason?: string | null }) {
  const tone = status === 'open' ? 'ok' : status === 'on_hold' ? 'warn' : status === 'draft' ? 'info' : 'neutral';
  return (
    <Badge tone={tone}>
      {STATUS_LABEL[status]}{status === 'closed' && reason ? ` · ${reason}` : ''}
    </Badge>
  );
}

export function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

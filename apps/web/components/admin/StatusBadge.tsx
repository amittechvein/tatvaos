import { Badge, statusTone } from '@/components/ui/Kit';

/**
 * Kept as its own component because pages already import it by name, but the
 * styling now comes from the shared kit.
 *
 * Status colours deliberately do NOT follow the theme accent. A customer who
 * picks a green accent must not end up with "suspended" rendered in green —
 * red means stopped everywhere, whatever the rest of the product looks like.
 */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replace(/_/g, ' ')}</Badge>;
}

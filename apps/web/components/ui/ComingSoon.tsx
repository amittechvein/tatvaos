'use client';

import { AdminShell } from '@/components/admin/AdminShell';
import { Card } from '@/components/ui/Kit';

// A real page instead of a 404 for routes the nav links to but that are not
// built yet. The same shell and card as every other console page, so it looks
// like the rest of the console rather than a dead end.
export function ComingSoon({
  scope, title, blurb,
}: {
  scope: 'platform' | 'organisation';
  title: string;
  blurb: string;
}) {
  return (
    <AdminShell scope={scope} title={title}>
      <Card>
        <div className="text-center py-6">
          <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-brand-500/10 text-brand-700">
            <i className="ri-tools-line text-[1.5rem]" />
          </span>
          <h5 className="font-semibold mb-1">{title} is coming soon</h5>
          <p className="text-ink-muted text-[0.8125rem] mb-0 mx-auto" style={{ maxWidth: 460 }}>{blurb}</p>
        </div>
      </Card>
    </AdminShell>
  );
}

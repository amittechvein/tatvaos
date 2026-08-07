'use client';

import { AdminShell } from '@/components/admin/AdminShell';

// A real page instead of a 404 for routes the nav links to but that are not
// built yet. Uses the YZEN shell + card so it looks like the rest of the
// console rather than a dead end.
export function ComingSoon({
  scope, title, blurb,
}: {
  scope: 'platform' | 'organisation';
  title: string;
  blurb: string;
}) {
  return (
    <AdminShell scope={scope} title={title}>
      <div className="card custom-card">
        <div className="card-body text-center py-6">
          <span
            className="avatar avatar-xl bg-primary-transparent mb-3"
            style={{ display: 'inline-flex' }}
          >
            <i className="ri-tools-line fs-24" />
          </span>
          <h5 className="fw-semibold mb-1">{title} is coming soon</h5>
          <p className="text-muted fs-13 mb-0 mx-auto" style={{ maxWidth: 460 }}>{blurb}</p>
        </div>
      </div>
    </AdminShell>
  );
}

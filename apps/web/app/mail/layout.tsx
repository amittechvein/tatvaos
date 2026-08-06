'use client';

import { RequireAuth } from '@/components/RequireAuth';

/**
 * Mail is real now — everything under /mail talks to the API, so everything
 * under /mail requires a session. No role restriction: any signed-in person
 * may open Mail, and the page itself renders the no-mailbox state for people
 * whose account has no mail product.
 */
export default function MailLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="h-full overflow-hidden">{children}</div>
    </RequireAuth>
  );
}

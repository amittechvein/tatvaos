'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { organisationNav } from '@/lib/nav';

/**
 * Mail is real now — everything under /mail talks to the API, so everything
 * under /mail requires a session. No role restriction: any signed-in person
 * may open Mail, and the page itself renders the no-mailbox state for people
 * whose account has no mail product.
 *
 * Wrapped in the Core shell (top bar + icon rail) so Mail sits inside the same
 * frame as the console — the Mail lockup in the rail, the org nav to jump back
 * to Core, the app launcher to switch products. `bleed` because the mail client
 * is a full-height three-pane app that manages its own scrolling.
 */
export default function MailLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell scope="mail" brand="TatvaOS" sections={organisationNav()} bleed>
        {children}
      </AppShell>
    </RequireAuth>
  );
}

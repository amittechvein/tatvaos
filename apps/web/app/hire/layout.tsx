'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { Spinner } from '@/components/ui/Kit';
import { Alert, PageHeader } from '@/components/ui/Page';
import { hireNav } from '@/lib/nav';
import { HireAccessProvider } from './HireAccess';

/**
 * TatvaOS Hire, inside the same shell as every other product.
 *
 * Open to administrators and to the organisation's hiring team —
 * recruiters and hiring managers (Amit, 24 Sept 2026). Who is on the team is
 * Hire's own data, so the shell asks /api/hire/me rather than reading the
 * TatvaOS role; someone not on it gets a page saying so and who can fix it.
 *
 * The public careers page will NOT live under /hire: it serves people with
 * no session, and this layout would wrap it in RequireAuth — the same reason
 * Connect's guest room sits outside Connect's shell.
 */
export default function HireLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <HireAccessProvider
        loading={<Spinner />}
        denied={
          // No menu: every Hire link would lead back to this same message.
          <AppShell scope="hire" brand="TatvaOS" sections={[]}>
            <PageHeader title="Hire" />
            <Alert tone="info" title="You are not on the hiring team">
              Hire is for your organisation&apos;s administrators, recruiters and hiring managers.
              An administrator can add you under Hire → Team.
            </Alert>
          </AppShell>
        }
      >
        {(me) => (
          <AppShell scope="hire" brand="TatvaOS" sections={hireNav({ showTeam: me.access !== 'hiring_manager', showCareers: me.access === 'admin' })}>
            {children}
          </AppShell>
        )}
      </HireAccessProvider>
    </RequireAuth>
  );
}

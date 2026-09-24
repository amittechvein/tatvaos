'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { hireNav } from '@/lib/nav';

/**
 * TatvaOS Hire, inside the same shell as every other product.
 *
 * Administrators only, matching the API (OrgAdmin). The public careers page
 * will NOT live under /hire: it serves people with no session, and this
 * layout would wrap it in RequireAuth — the same reason Connect's guest room
 * sits outside Connect's shell.
 */
export default function HireLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['super_admin', 'org_owner', 'org_admin']}>
      <AppShell scope="hire" brand="TatvaOS" sections={hireNav()}>
        {children}
      </AppShell>
    </RequireAuth>
  );
}

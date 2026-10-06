'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { sheetsNav } from '@/lib/nav';

/**
 * Sheets' home pages inside the same shell as every other product. The
 * editor itself (/sheets/s/[id]) is deliberately OUTSIDE this group: a
 * spreadsheet gets the whole window.
 */
export default function SheetsHomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell scope="sheets" brand="TatvaOS" sections={sheetsNav()} bleed>
        {children}
      </AppShell>
    </RequireAuth>
  );
}

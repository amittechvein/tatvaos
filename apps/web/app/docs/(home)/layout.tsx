'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { docsNav } from '@/lib/nav';

/**
 * Docs' home pages inside the same shell as every other product. The
 * editor itself (/docs/d/[id]) is deliberately OUTSIDE this group: a
 * document gets the whole window, as it does in every word processor.
 */
export default function DocsHomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell scope="docs" brand="TatvaOS" sections={docsNav()} bleed>
        {children}
      </AppShell>
    </RequireAuth>
  );
}

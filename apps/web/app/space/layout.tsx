'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { RailStorage } from '@/components/shell/RailStorage';
import { spaceNav } from '@/lib/nav';
import { UploadProvider } from '@/components/space/UploadTray';

/**
 * Space inside the same shell as everything else: the icon rail carries the
 * four views, the page manages its own scrolling (`bleed`, like Mail).
 * Any signed-in person may open it; the page itself explains a missing
 * allocation, the same pattern as Mail's no-mailbox state.
 */
export default function SpaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      {/* The provider wraps the shell, so the tray outlives every navigation
          INSIDE Space. An upload that dies when somebody opens another folder
          is an upload people re-start, which is where duplicates come from. */}
      <UploadProvider>
        <AppShell scope="space" brand="TatvaOS" sections={spaceNav()} railFooter={<RailStorage />} bleed>
          {children}
        </AppShell>
      </UploadProvider>
    </RequireAuth>
  );
}

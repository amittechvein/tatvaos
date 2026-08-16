'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { RailStorage } from '@/components/shell/RailStorage';
import { calendarNav } from '@/lib/nav';

/**
 * Calendar inside the same shell as every other product: its own lockup, its
 * own rail, the shared storage meter, and `bleed` because a calendar grid is
 * a full-height app that manages its own scrolling.
 */
export default function CalendarLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell scope="calendar" brand="TatvaOS" sections={calendarNav()}
                railFooter={<RailStorage />} bleed>
        {children}
      </AppShell>
    </RequireAuth>
  );
}

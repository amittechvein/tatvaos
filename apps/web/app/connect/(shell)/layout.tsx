'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { RailStorage } from '@/components/shell/RailStorage';
import { connectNav } from '@/lib/nav';
import { ConnectSkin } from './ConnectSkin';

/**
 * Connect inside the same shell as every other product.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  WHY THIS IS A ROUTE GROUP — (shell) — AND NOT app/connect/layout.tsx.
 *
 *  /connect/room/[code] must render for someone with NO SESSION: a guest
 *  arrives from a link, and the room is the whole product to them. A layout
 *  at app/connect/ would wrap that route in RequireAuth too, and every guest
 *  would be bounced to a sign-in page for a meeting they were invited to.
 *
 *  A route group applies this layout to the pages inside it without appearing
 *  in any URL, so /connect still serves this file's children and the room
 *  route sits outside it, deliberately unwrapped.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * No `bleed`: unlike Mail and Calendar, these are ordinary padded pages that
 * scroll with the document. The room — the one full-height screen — is not in
 * this shell at all.
 *
 * ConnectSkin sits INSIDE AppShell, not around it. It re-dresses Connect's own
 * pages and must not reach the rail, the topbar or any other module — see the
 * note at the top of ConnectSkin.tsx for why that boundary is the point.
 */
export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell scope="connect" brand="TatvaOS" sections={connectNav()} railFooter={<RailStorage />}>
        <ConnectSkin>{children}</ConnectSkin>
      </AppShell>
    </RequireAuth>
  );
}

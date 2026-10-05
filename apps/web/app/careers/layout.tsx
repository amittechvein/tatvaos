import type { Metadata } from 'next';

// ============================================================================
//  NOT INDEXED UNTIL LAUNCH (Mr. Singh, 24 Sept 2026, PR 275).
//
//  A careers page exists to be found by search engines — but not while it is
//  being proved on Techvein's own organisation. Getting a half-finished page
//  OUT of an index is far slower than keeping it out.
//
//  WHY THIS IS IN CODE AND NOT THE PLATFORM SWITCH. The ruling asked for the
//  robots directive to follow 'hire.careers_portal_enabled'. It cannot do its
//  job there: with that switch off the page does not render at all (every
//  request 404s), and proving it on Techvein needs the switch ON — which is
//  exactly the window the directive has to cover. So it is fixed here, in the
//  server-rendered <head>, where even a crawler that runs no JavaScript sees
//  it. Removing these three lines is part of the launch change (with the
//  hire.tatvaos.com routing), reviewed like any other launch step.
// ============================================================================

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function CareersLayout({ children }: { children: React.ReactNode }) {
  return children;
}

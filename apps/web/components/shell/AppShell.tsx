'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

import { PageHeader } from '@/components/ui/Page';
import {
  RAIL_WIDTH, RAIL_WIDTH_ICONS, TOPBAR_HEIGHT, Sidebar, type NavSection, type RailState,
} from './Sidebar';
import { Topbar } from './Topbar';

// ============================================================================
//  Shell — the rail, the header and the page between them
// ============================================================================
//
//  Owns the rail's state and hands each part what it needs (see Sidebar for
//  why that is not a data attribute on <html> any more). The behaviours are
//  the ones the product had under YZEN:
//
//    desktop   rests as a 5rem icon strip; hovering it peeks the full rail
//              OVER the page (nothing reflows); the header toggle PINS it
//              open at 15rem and the page moves over.
//    phone     off-canvas; the header toggle slides it in over the page,
//              and tapping the page, pressing Escape or following a link
//              closes it.
//
//  1024px (Tailwind's lg) is the one breakpoint, in the CSS and in the
//  matchMedia below. YZEN used 992px; the 32px difference is not something a
//  page notices, and one number beats two.
// ============================================================================

const DESKTOP = '(min-width: 1024px)';

export function AppShell({
  scope,
  brand,
  sections,
  title,
  breadcrumb,
  actions,
  children,
  bleed = false,
  railFooter,
  railHeader,
}: {
  scope: 'platform' | 'organisation' | 'mail' | 'family' | 'space' | 'calendar' | 'connect';
  brand: string;
  sections: NavSection[];
  title?: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** App-style screens (Mail) fill the shell body and scroll internally
   *  instead of flowing in the padded container. */
  bleed?: boolean;
  /** Rendered at the bottom of the rail. */
  railFooter?: React.ReactNode;
  /** Rendered at the TOP of the rail, under the brand. */
  railHeader?: React.ReactNode;
}) {
  const pathname = usePathname();
  const [rail, setRail] = useState<RailState>({ pinned: false, peek: false, mobileOpen: false });

  const isDesktop = () => window.matchMedia(DESKTOP).matches;

  const toggle = useCallback(() => {
    setRail((r) => (isDesktop()
      ? { ...r, pinned: !r.pinned, peek: false }
      : { ...r, mobileOpen: !r.mobileOpen }));
  }, []);
  const closeMobile = useCallback(() => setRail((r) => (r.mobileOpen ? { ...r, mobileOpen: false } : r)), []);
  const peek = useCallback((open: boolean) => {
    // Peek only means something while the rail rests as icons on a desktop.
    setRail((r) => (r.pinned || !isDesktop() ? r : { ...r, peek: open }));
  }, []);

  // Crossing the breakpoint clears any half-state so the rail never gets
  // stuck peeked-open after a resize.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = () => setRail((r) => ({ ...r, peek: false, mobileOpen: false }));
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!rail.mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMobile(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rail.mobileOpen, closeMobile]);

  // Navigating closes the phone rail. GUARDED to the phone by closeMobile
  // itself: on a desktop the same event must not touch a pinned rail — a
  // phone fix once pinned the desktop sidebar open on every navigation.
  useEffect(() => { closeMobile(); }, [pathname, closeMobile]);

  const pageLeft = rail.pinned ? RAIL_WIDTH : RAIL_WIDTH_ICONS;

  return (
    <div className="min-h-dvh bg-canvas">
      <Topbar scope={scope} pinned={rail.pinned} onToggle={toggle} />
      <Sidebar sections={sections} brand={brand} scope={scope} footer={railFooter} header={railHeader}
               rail={rail} onPeek={peek} onCloseMobile={closeMobile} />

      {/* The page. Under the fixed header; beside the rail on a desktop. */}
      <style>{`@media (min-width:1024px){#page{margin-left:${pageLeft}}}`}</style>
      <div
        id="page"
        className={bleed
          // App-style screens pin to the viewport and scroll inside; the
          // shell padding would only steal room from their panes.
          ? 'flex h-dvh flex-col overflow-hidden'
          : 'px-4 pb-8 pt-4 lg:px-6'}
        style={{ paddingTop: bleed ? TOPBAR_HEIGHT : `calc(${TOPBAR_HEIGHT} + 1rem)` }}
      >
        {!bleed && (title || breadcrumb || actions) && (
          <PageHeader title={title ?? ''} breadcrumb={breadcrumb} actions={actions} className="mb-4" />
        )}
        {children}
      </div>
    </div>
  );
}

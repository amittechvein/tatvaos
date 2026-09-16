'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AccountMenu } from './AccountMenu';
import { AppLauncher } from './AppLauncher';
import { RAIL_WIDTH, RAIL_WIDTH_ICONS, TOPBAR_HEIGHT } from './Sidebar';
import { useTheme as useAppearance } from '@/lib/theme';
import { useSelfPhoto } from '@/components/ui/UserPhoto';

// ============================================================================
//  Header — a white bar with the rail toggle and search on the left and an
//  icon cluster on the right. Ours since 16 Sept 2026; it was YZEN's
//  .app-header markup before that. The overlays it opens (app launcher,
//  account menu) were always our components.
// ============================================================================

/** The one class every icon button in the header shares. */
export const HEADER_LINK =
  'grid h-10 w-10 place-items-center rounded-lg text-ink-muted transition-colors '
  + 'hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40';

export function Topbar({ scope, pinned, onToggle }: {
  scope: 'platform' | 'organisation' | 'mail' | 'family' | 'space' | 'calendar' | 'connect';
  /** Desktop only: whether the rail is pinned at full width. Sets this bar's left edge. */
  pinned: boolean;
  onToggle: () => void;
}) {
  const { user } = useAuth();
  const { mode, setMode } = useAppearance();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const selfPhoto = useSelfPhoto();

  const initial = (user?.displayName ?? '?').charAt(0).toUpperCase();

  return (
    <>
      <header
        id="header"
        className="fixed inset-x-0 top-0 z-[1030] flex items-center gap-2 border-b border-line bg-surface px-3 lg:px-4"
        style={{ height: TOPBAR_HEIGHT }}
      >
        {/* The bar starts where the rail ends on desktop; the rail's own width
            is the one fact, read from Sidebar. */}
        <style>{`@media (min-width:1024px){#header{left:${pinned ? RAIL_WIDTH : RAIL_WIDTH_ICONS}}}`}</style>

        <button type="button" aria-label="Toggle sidebar" className={HEADER_LINK} onClick={onToggle}>
          <i className="ri-menu-2-line text-[20px]" />
        </button>

        <div className="relative hidden md:block">
          <input
            type="text"
            placeholder="Search"
            spellCheck={false}
            autoComplete="off"
            className="h-9 w-56 rounded-lg border border-line bg-canvas pl-3 pr-9 text-sm text-ink placeholder:text-ink-faint focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
          />
          <i className="ri-search-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted" />
        </div>

        {scope === 'platform' && (
          <span className="ml-2 hidden rounded-full bg-warn/10 px-2.5 py-0.5 text-xs font-semibold text-warn lg:inline-flex">
            Platform admin
          </span>
        )}

        <div className="flex-1" />

        {/* App launcher — its own trigger + popover */}
        <AppLauncher />

        {/* Dark / light */}
        <button type="button" aria-label="Toggle theme" className={HEADER_LINK}
                onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>
          <i className={`${mode === 'dark' ? 'ri-sun-line' : 'ri-moon-line'} text-[20px]`} />
        </button>

        {/* Profile */}
        <button type="button" aria-label="Account" className={HEADER_LINK}
                onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
          {selfPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selfPhoto} alt="" width={34} height={34}
                 className="h-[34px] w-[34px] rounded-full object-cover" />
          ) : (
            <span className="grid h-[34px] w-[34px] place-items-center rounded-full bg-brand-500 text-sm font-bold text-white">
              {initial}
            </span>
          )}
        </button>
      </header>

      <AccountMenu anchorEl={anchor} onClose={() => setAnchor(null)} />
    </>
  );
}

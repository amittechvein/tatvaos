'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AccountMenu } from './AccountMenu';
import { AppLauncher } from './AppLauncher';
import { RAIL_WIDTH, RAIL_WIDTH_ICONS, TOPBAR_HEIGHT } from './Sidebar';
import { useTheme as useAppearance } from '@/lib/theme';
import { useSelfPhoto } from '@/components/ui/UserPhoto';
import { useMailSearch } from '@/components/mail/MailSearchContext';
import { SearchBox } from '@/components/mail/SearchBox';

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

/**
 * The header's search — present only while a page is listening for the
 * query. See MailSearchContext for why that condition exists.
 */
function MailSearchSlot() {
  const { query, setQuery, folders, hosted, inputRef } = useMailSearch();
  if (!hosted) return null;
  // It takes the width between the rail toggle and the icon cluster, as
  // Gmail's does. Until 24 September 2026 it sat at 176px with an empty
  // spacer filling the rest of the bar (Amit's screenshot, outlined).
  return (
    <div className="min-w-0 flex-1">
      <SearchBox value={query} onChange={setQuery} folders={folders} inputRef={inputRef} />
    </div>
  );
}

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
  const { hosted: searchHosted } = useMailSearch();

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

        {/* ── THE SEARCH, AND WHY IT IS SOMETIMES ABSENT ──────────────────
            What stood here until 23 September 2026 was a bare <input> with
            no value, no handler and nothing anywhere listening to it --
            shipped in 594824d, whose message calls it a "ghost search". It
            came with the purchased template. Typing in it did nothing, on
            every page, while the Inbox carried a real search box of its
            own two rows below. Amit saw the two together and asked for the
            lower one to move up here.

            So this is the real mail search now -- chips, suggestions, the
            advanced form -- and it is rendered ONLY when a page has
            claimed it (MailSearchContext). No host, no box: a header that
            draws nothing is honest, and a header that draws an input which
            swallows typing is the bug being fixed. ─────────────────────── */}
        <MailSearchSlot />

        {scope === 'platform' && (
          <span className="ml-2 hidden rounded-full bg-warn/10 px-2.5 py-0.5 text-xs font-semibold text-warn lg:inline-flex">
            Platform admin
          </span>
        )}

        {/* The search grows to fill the bar when present; this spacer only
            pushes the icons right when it is not. Two flex-1s would split
            the bar in half. */}
        {!searchHosted && <div className="flex-1" />}

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

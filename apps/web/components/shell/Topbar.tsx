'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AccountMenu } from './AccountMenu';
import { AppLauncher } from './AppLauncher';
import { useTheme as useAppearance } from '@/lib/theme';
import { useSelfPhoto } from '@/components/ui/UserPhoto';

// ============================================================================
//  Header — YZEN's .app-header markup
// ============================================================================
//
//  Their solid white header with the search on the left and an icon cluster on
//  the right. The overlays it opens (app launcher, account menu) are still our
//  React/MUI components — only the bar itself is YZEN's. The old appearance
//  panel is gone with the accent switcher; dark/light is the one appearance
//  control, and it lives right here.
// ============================================================================

export function Topbar({ scope }: { scope: 'platform' | 'organisation' | 'mail' | 'family' | 'space' | 'calendar' | 'connect' }) {
  const { user } = useAuth();
  const { mode, setMode } = useAppearance();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const selfPhoto = useSelfPhoto();

  // The rail resting state is viewport-aware. On desktop it sits collapsed to
  // icons ("icon-overlay-close", expanding on hover); the toggle PINS it fully
  // open ("close") and back. On mobile it is off-canvas ("close"); the toggle
  // slides it in ("open") and back. The Sidebar keeps the resting default in
  // sync with the breakpoint.
  function toggleSidebar() {
    const el = document.documentElement;
    const desktop = window.matchMedia('(min-width: 992px)').matches;
    if (desktop) {
      el.dataset.toggled = el.dataset.toggled === 'close' ? 'icon-overlay-close' : 'close';
      delete el.dataset.iconOverlay;
    } else {
      el.dataset.toggled = el.dataset.toggled === 'open' ? 'close' : 'open';
    }
  }

  const initial = (user?.displayName ?? '?').charAt(0).toUpperCase();

  return (
    <>
      <header className="app-header sticky" id="header">
        <div className="main-header-container container-fluid">
          <div className="header-content-left">
            <div className="header-element mx-lg-0 mx-2">
              <a aria-label="Toggle sidebar" className="sidemenu-toggle header-link"
                 href="javascript:void(0);" onClick={toggleSidebar}>
                <i className="ri-menu-2-line fs-20" />
              </a>
            </div>

            <div className="header-element header-search d-md-block d-none my-auto">
              <input type="text" className="header-search-bar form-control"
                     placeholder="Search" spellCheck={false} autoComplete="off" />
              <a href="javascript:void(0);" className="header-search-icon border-0">
                <i className="ri-search-line" />
              </a>
            </div>

            {scope === 'platform' && (
              <div className="header-element d-none d-lg-block ms-2 my-auto">
                <span className="badge bg-warning-transparent">Platform admin</span>
              </div>
            )}
          </div>

          <div className="header-content-right">
            {/* App launcher — its own trigger + popover */}
            <div className="header-element d-flex align-items-center">
              <AppLauncher />
            </div>

            {/* Dark / light */}
            <div className="header-element">
              <a href="javascript:void(0);" className="header-link"
                 aria-label="Toggle theme"
                 onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>
                <i className={`${mode === 'dark' ? 'ri-sun-line' : 'ri-moon-line'} header-link-icon`} />
              </a>
            </div>

            {/* Profile */}
            <div className="header-element">
              <a href="javascript:void(0);" className="header-link d-flex align-items-center"
                 onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} aria-label="Account">
                {selfPhoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selfPhoto} alt="" width={34} height={34}
                       style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <span
                    style={{
                      width: 34, height: 34, borderRadius: '50%', display: 'grid',
                      placeItems: 'center', fontWeight: 700, fontSize: 14, color: '#fff',
                      background: 'var(--primary-color)',
                    }}
                  >
                    {initial}
                  </span>
                )}
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Overlays — still our components, triggered from the YZEN header */}
      <AccountMenu anchorEl={anchor} onClose={() => setAnchor(null)} />
    </>
  );
}

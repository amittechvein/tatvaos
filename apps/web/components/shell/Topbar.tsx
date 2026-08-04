'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { Switcher } from './Switcher';

/**
 * The white bar across the top: collapse control, search, and the right-hand
 * icon cluster.
 *
 * The reference carries ten icons here — cart, language, fullscreen, apps and
 * so on. Most belong to the demo rather than to a mail and identity platform,
 * and every one of them is a thing a user has to visually skip past to reach
 * the one they want. What is kept is what does something.
 */
export function Topbar({ scope }: { scope: 'platform' | 'organisation' | 'mail' }) {
  const { user, signOut } = useAuth();
  const { mode, setMode, toggleRail } = useTheme();
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-topbar items-center gap-3 border-b border-line bg-surface px-4">
        <button
          onClick={toggleRail}
          aria-label="Toggle sidebar"
          className="rounded p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h10M4 17h16" />
          </svg>
        </button>

        <div className="relative hidden max-w-md flex-1 md:block">
          <input
            type="search"
            placeholder="Search…"
            className="w-full rounded-card border border-line bg-canvas py-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand-400 focus:bg-surface focus:outline-none"
          />
          <svg className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-faint" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l4 4" strokeLinecap="round" />
          </svg>
        </div>

        {/*
          Platform admin acts across every customer's data. The badge is the
          only always-visible reminder of which console this is — the cost of
          confusing them is suspending the wrong organisation.
        */}
        {scope === 'platform' && (
          <span className="ml-auto rounded bg-warn/15 px-2 py-1 text-label font-bold uppercase text-warn">
            Platform admin
          </span>
        )}

        <div className={`flex items-center gap-1 ${scope === 'platform' ? '' : 'ml-auto'}`}>
          <IconButton
            label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
          >
            {mode === 'dark' ? (
              <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.5-6.5l-1.4 1.4M7.9 16.1l-1.4 1.4m11.6 0l-1.4-1.4M7.9 7.9L6.5 6.5M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            ) : (
              <path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z" />
            )}
          </IconButton>

          <IconButton label="Appearance" onClick={() => setSwitcher(true)}>
            <path d="M10.3 3h3.4l.5 2.3 1.9 1.1 2.2-.8 1.7 3-1.7 1.6v2.2l1.7 1.6-1.7 3-2.2-.8-1.9 1.1-.5 2.3h-3.4l-.5-2.3-1.9-1.1-2.2.8-1.7-3 1.7-1.6v-2.2L4 8.6l1.7-3 2.2.8 1.9-1.1.5-2.3z" />
            <circle cx="12" cy="12" r="2.6" />
          </IconButton>

          <div className="relative">
            <button
              onClick={() => setMenu((v) => !v)}
              aria-expanded={menu}
              className="flex items-center gap-2 rounded-card px-2 py-1.5 transition hover:bg-canvas"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-[13px] font-semibold text-white">
                {(user?.displayName ?? '?').charAt(0).toUpperCase()}
              </span>
              <span className="hidden text-left sm:block">
                <span className="block max-w-[140px] truncate text-[13px] font-medium leading-tight text-ink">
                  {user?.displayName ?? 'Signed out'}
                </span>
                <span className="block text-[11px] capitalize leading-tight text-ink-muted">
                  {user?.role.replace(/_/g, ' ')}
                </span>
              </span>
            </button>

            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} aria-hidden />
                <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-card border border-line bg-surface py-1 shadow-raised">
                  <p className="truncate px-4 py-2 text-xs text-ink-muted">{user?.email}</p>
                  <a href="/change-password" className="block px-4 py-2 text-[13px] text-ink transition hover:bg-canvas">
                    Change password
                  </a>
                  <button
                    onClick={() => { setMenu(false); void signOut(); }}
                    className="block w-full px-4 py-2 text-left text-[13px] text-danger transition hover:bg-canvas"
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <Switcher open={switcher} onClose={() => setSwitcher(false)} />
    </>
  );
}

function IconButton({
  label, onClick, children,
}: {
  label: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-full p-2 text-ink-muted transition hover:bg-canvas hover:text-ink"
    >
      <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

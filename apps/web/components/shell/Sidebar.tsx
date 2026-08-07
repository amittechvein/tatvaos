'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

// ============================================================================
//  Sidebar — YZEN's exact markup (.app-sidebar / .main-menu / .slide)
// ============================================================================
//
//  This renders the DOM structure YZEN's styles.css expects, so their real
//  stylesheet styles it pixel-for-pixel: the dark rail, the green icons, the
//  category labels, the active-item wash. Our navigation data drives it and
//  React handles the submenu open/close; none of YZEN's jQuery is involved.
// ============================================================================

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  children?: { href: string; label: string }[];
  disabled?: boolean;
  badge?: string;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

// Kept for the AppShell import; YZEN positions the rail via CSS, so these are
// no longer used to offset the content column by hand.
export const PANEL_WIDTH = 262;
export const PANEL_WIDTH_ICONS = 72;

export function Sidebar({ sections, brand, scope }: {
  sections: NavSection[];
  brand: string;
  scope: 'platform' | 'organisation' | 'mail';
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);

  // Mail carries its own lockup; the console (platform/organisation) uses Core.
  const logo = scope === 'mail' ? 'mail' : 'core';

  // Longest match wins so "/org" does not light every page under it.
  const activeHref = sections
    .flatMap((sec) => sec.items)
    .flatMap((i) => [i.href, ...(i.children?.map((c) => c.href) ?? [])])
    .filter((h) => h && (pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];

  // Keep the rail's resting state matched to the viewport: icons-only overlay on
  // desktop (it peeks open on hover, below), off-canvas on mobile. Runs on mount
  // and whenever the breakpoint is crossed, clearing any hover-peek so the rail
  // never gets stuck half-open after a resize.
  useEffect(() => {
    const root = document.documentElement;
    const desktop = window.matchMedia('(min-width: 992px)');
    const sync = () => {
      delete root.dataset.iconOverlay;
      // Don't fight a rail the user has explicitly pinned/opened via the header
      // toggle; only (re)assert the resting default for the current breakpoint.
      root.dataset.toggled = desktop.matches ? 'icon-overlay-close' : 'close';
    };
    sync();
    desktop.addEventListener('change', sync);
    return () => desktop.removeEventListener('change', sync);
  }, []);

  // Hover-to-peek: while the rail is resting as icons, entering it expands it as
  // an overlay (YZEN's data-icon-overlay=open → 15rem, floating over content, no
  // reflow); leaving collapses it back. A pinned-open rail (data-toggled=close)
  // ignores this, since the icon-overlay CSS only applies in the collapsed state.
  const peekOpen = () => {
    const root = document.documentElement;
    if (root.dataset.toggled === 'icon-overlay-close') root.dataset.iconOverlay = 'open';
  };
  const peekClose = () => { delete document.documentElement.dataset.iconOverlay; };

  return (
    <aside className="app-sidebar sticky" id="sidebar" onMouseEnter={peekOpen} onMouseLeave={peekClose}>
      {/* Brand — the product logo lockup. The mark is a self-contained badge;
          the wordmark is dark artwork, so the header sits on white (overrides.css)
          and lines up with the white topbar. The collapsed icon rail shows only
          the mark. */}
      <div className="main-sidebar-header">
        <Link href="/" className="header-logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src={`/brand/${logo}-logo.png`} alt={brand} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-name" src={`/brand/${logo}-name.png`} alt={brand} />
        </Link>
      </div>

      <div className="main-sidebar" id="sidebar-scroll">
        <nav className="main-menu-container nav nav-pills flex-column sub-open">
          <ul className="main-menu">
            {sections.map((section) => (
              <li key={section.heading} style={{ listStyle: 'none' }}>
                <ul className="main-menu" style={{ padding: 0 }}>
                  <li className="slide__category">
                    <span className="category-name">{section.heading}</span>
                  </li>

                  {section.items.map((item) => {
                    const active =
                      item.href === activeHref ||
                      item.children?.some((c) => c.href === activeHref);
                    const expanded = open === item.href || (active && open === null);

                    if (item.children) {
                      return (
                        <li key={item.href} className={`slide has-sub${expanded ? ' open' : ''}`}>
                          <a
                            href="javascript:void(0);"
                            className={`side-menu__item${active ? ' active' : ''}`}
                            onClick={() => setOpen(expanded ? '' : item.href)}
                          >
                            <span className="side-menu__icon">{item.icon}</span>
                            <span className="side-menu__label">{item.label}</span>
                            <i className="ri-arrow-right-s-line side-menu__angle" />
                          </a>
                          <ul className="slide-menu child1" style={{ display: expanded ? 'block' : 'none' }}>
                            {item.children.map((c) => (
                              <li key={c.href} className="slide">
                                <Link
                                  href={c.href}
                                  className={`side-menu__item${pathname === c.href ? ' active' : ''}`}
                                >
                                  {c.label}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </li>
                      );
                    }

                    return (
                      <li key={item.href} className={`slide${active ? ' active' : ''}`}>
                        <Link
                          href={item.disabled ? '#' : item.href}
                          className={`side-menu__item${active ? ' active' : ''}`}
                          aria-disabled={item.disabled}
                        >
                          <span className="side-menu__icon">{item.icon}</span>
                          <span className="side-menu__label">{item.label}</span>
                          {item.badge && <span className="badge bg-primary-transparent ms-auto">{item.badge}</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}

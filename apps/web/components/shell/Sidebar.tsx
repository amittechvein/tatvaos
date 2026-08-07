'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

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

export function Sidebar({ sections, brand }: { sections: NavSection[]; brand: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);

  // Longest match wins so "/org" does not light every page under it.
  const activeHref = sections
    .flatMap((sec) => sec.items)
    .flatMap((i) => [i.href, ...(i.children?.map((c) => c.href) ?? [])])
    .filter((h) => h && (pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <aside className="app-sidebar sticky" id="sidebar">
      {/* Brand */}
      <div className="main-sidebar-header">
        <Link href="/" className="header-logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 16,
              color: '#fff', background: 'var(--primary-color)',
            }}
          >
            T
          </span>
          <span style={{ fontWeight: 800, fontSize: 19, letterSpacing: '-0.01em', color: '#fff' }}>
            {brand}
          </span>
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

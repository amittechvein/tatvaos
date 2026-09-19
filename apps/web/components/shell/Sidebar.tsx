'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { BrandMark, BrandName } from '@/components/ui/Brand';

// ============================================================================
//  Sidebar — the rail, in Tailwind and the tokens
// ============================================================================
//
//  Until 16 Sept 2026 this emitted YZEN's exact DOM (.app-sidebar / .main-menu
//  / .slide) so their 27,000-line stylesheet could lay it out. YZEN is gone
//  (stage 4 of docs/UI_LANE_BRIEF.md), so the rail draws itself.
//
//  The SHAPE is unchanged, because pages and people were laid out around it:
//    - 15rem wide when expanded, 5rem when collapsed to icons;
//    - a 4.25rem brand header that lines up with the topbar;
//    - fixed to the viewport, scrolling its own contents.
//
//  The STATE lives in AppShell, not in data attributes on <html>. YZEN drove
//  everything from data-toggled / data-icon-overlay, which meant the header
//  toggle, the hover-peek and the phone close-on-navigate all had to reach
//  into the document and agree on a string. Three components reading one
//  attribute is how the desktop rail once got pinned open by a fix meant for
//  phones. Now AppShell owns one object and hands each part what it needs.
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

/** The rail's two widths, as the one fact every part of the shell reads. */
export const RAIL_WIDTH = '15rem';
export const RAIL_WIDTH_ICONS = '5rem';
export const TOPBAR_HEIGHT = '4.25rem';

export interface RailState {
  /** Desktop: pinned open at full width. Otherwise it rests as icons. */
  pinned: boolean;
  /** Desktop, resting as icons: expanded as an overlay while hovered. */
  peek: boolean;
  /** Phone: slid in over the page. */
  mobileOpen: boolean;
}

export function Sidebar({ sections, brand, scope, footer, header, rail, onPeek, onCloseMobile }: {
  sections: NavSection[];
  brand: string;
  scope: 'platform' | 'organisation' | 'mail' | 'family' | 'space' | 'calendar' | 'connect';
  /** Pinned to the bottom of the rail (Mail puts the storage meter here).
   *  Hidden while the rail is collapsed to icons. */
  footer?: React.ReactNode;
  /** Rendered directly under the brand, ABOVE the nav — for context that
   *  changes what the nav beneath it means (Mail's mailbox switcher). */
  header?: React.ReactNode;
  rail: RailState;
  onPeek: (open: boolean) => void;
  onCloseMobile: () => void;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);

  // Each product with its own front door carries its own lockup; the console
  // (platform/organisation) falls back to Core. Files live in public/brand as
  // <scope>-logo.png and <scope>-name.png.
  const logo = scope === 'mail' || scope === 'family' || scope === 'space'
    || scope === 'calendar' || scope === 'connect'
    ? scope : 'core';

  // Longest match wins so "/org" does not light every page under it.
  const activeHref = sections
    .flatMap((sec) => sec.items)
    .flatMap((i) => [i.href, ...(i.children?.map((c) => c.href) ?? [])])
    .filter((h) => h && (pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];

  // Labels show whenever the rail is at full width for any reason. On a phone
  // it is always full width; the icon strip is a desktop shape only.
  const wide = rail.pinned || rail.peek;
  const labels = 'lg:' + (wide ? 'block' : 'hidden');

  return (
    <>
      {/* PHONE: the page behind the open rail is a close button. Until this
          existed the only way to dismiss the rail was the header toggle, which
          the open rail covered — the app looked frozen behind a menu. */}
      {rail.mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onCloseMobile}
          className="fixed inset-0 z-[1035] bg-[rgb(21_20_27_/_0.45)] lg:hidden"
        />
      )}

      <aside
        id="sidebar"
        onMouseEnter={() => onPeek(true)}
        onMouseLeave={() => onPeek(false)}
        className={
          'fixed inset-y-0 left-0 z-[1040] flex flex-col border-r border-line bg-rail '
          + 'transition-[width,transform] duration-150 ease-out '
          // Phone: off-canvas unless open, always full width.
          + (rail.mobileOpen ? 'translate-x-0 ' : '-translate-x-full ')
          + 'lg:translate-x-0'
        }
        data-wide={wide || undefined}
      >
        {/* EVERY width lives in this one style tag, phone included — never in a
            style={{ width }} on the aside.

            It used to be split: the phone width inline, the desktop widths
            here. An inline style attribute beats any stylesheet rule that is not
            !important, so the desktop rule never applied. On every signed-in
            page on a desktop the rail sat at the full 15rem with its labels
            hidden, covering the left of the page, which only allowed for the
            5rem icon strip. Found 16 Sept 2026 in a local run of e23ccd5 before
            it was deployed; tsc, eslint and next build were all green on it,
            because none of them draws a page. Measured, not read: 240px with
            the attribute, 80px without — with the width transition switched
            off, since reading mid-transition returns the old width. */}
        <style>{`#sidebar{width:${RAIL_WIDTH}}@media (min-width:1024px){#sidebar{width:${RAIL_WIDTH_ICONS}}#sidebar[data-wide]{width:${RAIL_WIDTH}}}`}</style>

        {/* Brand — the product logo lockup. The collapsed icon rail shows only
            the mark.

            This comment used to say "the wordmark is dark artwork and needs a
            light ground, which the rail is". In dark mode the rail is not, and
            both images were white boxes on it (Amit, 19 Sept 2026). They now
            come from /brand/ui through components/ui/Brand, which says why the
            originals are still there. The wordmark's two images sit in ONE
            wrapper that carries `labels`: `lg:block` on the images themselves
            would have un-hidden the theme's hidden half. */}
        <div className="flex shrink-0 items-center justify-center border-b border-line px-4"
             style={{ height: TOPBAR_HEIGHT }}>
          <Link href="/" className="flex items-center gap-2 no-underline" aria-label={brand}>
            <BrandMark product={logo} className="h-8 w-auto" />
            <span className={labels}>
              <BrandName product={logo} className="h-[30px] w-auto" />
            </span>
          </Link>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-6 pt-2">
          {header && <div className={`px-4 pt-3 text-rail-text ${labels}`}>{header}</div>}

          <nav aria-label="Sections">
            {sections.map((section) => (
              <div key={section.heading} className="px-3 pt-3">
                {/* The heading, or a hairline when there is no room for words. */}
                <div className={`mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-rail-heading ${labels}`}>
                  {section.heading}
                </div>
                <div className={`mx-2 mb-2 h-px bg-line ${wide ? 'lg:hidden' : 'hidden lg:block'}`} aria-hidden="true" />

                <ul className="m-0 list-none p-0">
                  {section.items.map((item) => {
                    const active =
                      item.href === activeHref ||
                      item.children?.some((c) => c.href === activeHref);
                    const expanded = open === item.href || (active && open === null);

                    const rowCls =
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm no-underline transition-colors '
                      + (active
                        ? 'bg-brand-500 text-white'
                        : 'text-rail-text hover:bg-rail-soft hover:text-ink');

                    if (item.children) {
                      return (
                        <li key={item.href} className="mb-0.5">
                          <button
                            type="button"
                            className={rowCls}
                            aria-expanded={expanded}
                            onClick={() => setOpen(expanded ? '' : item.href)}
                          >
                            <span className="grid h-5 w-5 shrink-0 place-items-center text-[18px]">{item.icon}</span>
                            <span className={`min-w-0 flex-1 truncate text-left ${labels}`}>{item.label}</span>
                            <i className={`ri-arrow-right-s-line shrink-0 transition-transform ${expanded ? 'rotate-90' : ''} ${labels}`} />
                          </button>
                          {expanded && (
                            <ul className={`m-0 list-none p-0 pl-6 ${labels}`}>
                              {item.children.map((c) => (
                                <li key={c.href}>
                                  <Link
                                    href={c.href}
                                    onClick={onCloseMobile}
                                    className={
                                      'block truncate rounded-lg px-3 py-1.5 text-[13px] no-underline transition-colors '
                                      + (pathname === c.href
                                        ? 'font-semibold text-brand-700'
                                        : 'text-rail-text hover:bg-rail-soft hover:text-ink')
                                    }
                                  >
                                    {c.label}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    }

                    return (
                      <li key={item.href} className="mb-0.5">
                        <Link
                          href={item.disabled ? '#' : item.href}
                          className={rowCls + (item.disabled ? ' opacity-50' : '')}
                          aria-disabled={item.disabled}
                          aria-current={active ? 'page' : undefined}
                          title={wide ? undefined : item.label}
                          // Following a link must dismiss the phone rail. Otherwise
                          // you tap "People", the page loads underneath, and the
                          // menu is still covering it — which reads as the tap not
                          // having worked, so people tap it again.
                          onClick={onCloseMobile}
                        >
                          <span className="grid h-5 w-5 shrink-0 place-items-center text-[18px]">{item.icon}</span>
                          <span className={`min-w-0 flex-1 truncate ${labels}`}>{item.label}</span>
                          {item.badge && (
                            <span className={`rounded-full bg-brand-500/10 px-2 py-0.5 text-[11px] font-semibold text-brand-700 ${labels}`}>
                              {item.badge}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {footer && (
            <div className={`mt-4 border-t border-line px-5 pt-3 text-rail-text ${labels}`}>{footer}</div>
          )}
        </div>
      </aside>
    </>
  );
}

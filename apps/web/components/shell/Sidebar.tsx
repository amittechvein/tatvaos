'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useTheme } from '@/lib/theme';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  children?: { href: string; label: string }[];
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

/**
 * The rail.
 *
 * The active row is the piece worth understanding. It is filled with the PAGE
 * colour, not a highlight colour, and joined to the content area by two
 * concave corners — so it reads as a tab pulled out of the rail rather than a
 * band painted onto it. The curve itself is in globals.css (.rail-active),
 * because CSS has no outward border-radius and it takes two pseudo-elements
 * with an inverted box-shadow to fake one.
 */
export function Sidebar({
  sections,
  brand,
}: {
  sections: NavSection[];
  brand: string;
}) {
  const pathname = usePathname();
  const { railMode } = useTheme();
  const [open, setOpen] = useState<string | null>(null);

  const icons = railMode === 'icons';

  if (railMode === 'hidden') return null;

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex flex-col bg-rail shadow-rail transition-rail duration-200
                  ${icons ? 'w-rail-sm' : 'w-rail'}`}
    >
      {/* Brand */}
      <div className={`flex h-topbar shrink-0 items-center gap-2.5 border-b border-white/5 ${icons ? 'justify-center px-0' : 'px-5'}`}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">
          T
        </div>
        {!icons && (
          <span className="truncate text-[15px] font-semibold tracking-wide text-white">
            {brand}
          </span>
        )}
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto py-4">
        {sections.map((section) => (
          <div key={section.heading} className="mb-2">
            {!icons && (
              <p className="px-5 pb-1 pt-3 text-label font-semibold uppercase text-rail-heading">
                {section.heading}
              </p>
            )}

            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                pathname.startsWith(`${item.href}/`) ||
                item.children?.some((c) => pathname === c.href);

              const expanded = open === item.href;

              return (
                <div key={item.href}>
                  {item.children ? (
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : item.href)}
                      aria-expanded={expanded}
                      className={rowClass(!!active, icons)}
                    >
                      <Row item={item} icons={icons} active={!!active} />
                      {!icons && (
                        <svg
                          className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
                          viewBox="0 0 20 20" fill="currentColor" aria-hidden
                        >
                          <path d="M7.5 5l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  ) : (
                    <Link href={item.href} className={rowClass(!!active, icons)} title={icons ? item.label : undefined}>
                      <Row item={item} icons={icons} active={!!active} />
                    </Link>
                  )}

                  {!icons && item.children && expanded && (
                    <div className="mb-1 ml-[38px] mr-3 border-l border-white/10 pl-3">
                      {item.children.map((c) => (
                        <Link
                          key={c.href}
                          href={c.href}
                          className={`block rounded py-1.5 pl-2 text-[13px] transition
                            ${pathname === c.href
                              ? 'text-white'
                              : 'text-rail-text hover:text-white'}`}
                        >
                          {c.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function Row({ item, icons, active }: { item: NavItem; icons: boolean; active: boolean }) {
  return (
    <>
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition
          ${active ? 'bg-brand-500 text-white shadow-[0_4px_12px_rgba(0,0,0,0.25)]' : 'text-rail-text'}`}
      >
        {item.icon}
      </span>
      {!icons && <span className="truncate">{item.label}</span>}
    </>
  );
}

function rowClass(active: boolean, icons: boolean) {
  return [
    'relative flex w-full items-center gap-3 text-[13.5px] font-medium transition',
    icons ? 'justify-center px-0 py-2' : 'py-1.5 pl-4 pr-5',
    active
      // The page colour plus the curved joins. Text goes brand-coloured
      // because on a light canvas white would be invisible.
      ? 'rail-active bg-canvas text-brand-700 dark:text-brand-300'
      : 'text-rail-text hover:text-white',
  ].join(' ');
}

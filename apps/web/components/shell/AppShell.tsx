'use client';

import { useTheme } from '@/lib/theme';
import { Sidebar, type NavSection } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * Rail on the left, topbar across the top, content in the middle.
 *
 * One shell for the platform console, the customer console and the mail
 * client. They differ in navigation and in one badge — not in layout. Three
 * shells would drift, and the day they drift is the day someone confuses the
 * platform console with a customer's.
 */
export function AppShell({
  scope,
  brand,
  sections,
  title,
  breadcrumb,
  actions,
  children,
}: {
  scope: 'platform' | 'organisation' | 'mail';
  brand: string;
  sections: NavSection[];
  title?: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { railMode } = useTheme();

  // Margin, not padding on a wrapper: the rail is fixed so it stays put while
  // the content scrolls, and a fixed element takes up no layout space.
  const offset =
    railMode === 'hidden' ? 'ml-0'
      : railMode === 'icons' ? 'ml-rail-sm'
        : 'ml-rail';

  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar sections={sections} brand={brand} />

      <div className={`transition-rail duration-200 ${offset}`}>
        <Topbar scope={scope} />

        <main className="p-4 sm:p-6">
          {(title || breadcrumb || actions) && (
            <div className="mb-5 flex flex-wrap items-start gap-3">
              <div className="min-w-0">
                {title && (
                  <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-[26px]">
                    {title}
                  </h1>
                )}
                {breadcrumb && (
                  <nav aria-label="Breadcrumb" className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px]">
                    {breadcrumb.map((b, i) => (
                      <span key={b.label} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-ink-faint">/</span>}
                        {b.href
                          ? <a href={b.href} className="text-brand-600 hover:underline">{b.label}</a>
                          : <span className="text-ink-muted">{b.label}</span>}
                      </span>
                    ))}
                  </nav>
                )}
              </div>
              {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
            </div>
          )}

          {children}
        </main>
      </div>
    </div>
  );
}

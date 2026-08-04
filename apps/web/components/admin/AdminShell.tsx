'use client';

import { AppShell } from '@/components/shell/AppShell';
import type { NavSection } from '@/components/shell/Sidebar';

/**
 * Adapter kept so the existing admin pages did not all have to change at once.
 *
 * It takes the flat `nav` list those pages already pass and renders the real
 * AppShell — rail, topbar, page header. New screens should use AppShell
 * directly; this exists so the redesign did not require rewriting every page
 * in the same commit, which is how a redesign turns into a rewrite.
 *
 * The scope distinction is preserved and still matters: super admin acts
 * across every organisation, org admin acts within one. The badge lives in the
 * topbar now rather than a coloured band, but the reason is unchanged — the
 * cost of confusing them is suspending the wrong tenant.
 */
export function AdminShell({
  scope,
  title,
  subtitle,
  nav,
  children,
  actions,
}: {
  scope: 'platform' | 'organisation';
  title: string;
  subtitle?: string;
  nav: { href: string; label: string }[];
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const isPlatform = scope === 'platform';

  const sections: NavSection[] = [
    {
      heading: isPlatform ? 'Platform' : 'Organisation',
      items: nav.map((n) => ({
        href: n.href,
        label: n.label,
        icon: <NavGlyph label={n.label} />,
      })),
    },
    {
      heading: 'Products',
      items: [{ href: '/mail/f-inbox', label: 'Mail', icon: <NavGlyph label="Mail" /> }],
    },
  ];

  return (
    <AppShell
      scope={isPlatform ? 'platform' : 'organisation'}
      brand="TatvaOS"
      sections={sections}
      title={title}
      breadcrumb={[
        { label: isPlatform ? 'Platform' : 'Organisation' },
        ...(subtitle ? [{ label: subtitle }] : []),
      ]}
      actions={actions}
    >
      {children}
    </AppShell>
  );
}

/**
 * Chooses a glyph from the label.
 *
 * A stopgap, and worth replacing with an explicit icon per route. It is here
 * because the alternative was editing every page in this commit to pass one,
 * and a redesign that touches every file at once is a redesign nobody can
 * review.
 */
function NavGlyph({ label }: { label: string }) {
  const l = label.toLowerCase();

  const path =
    l.includes('organisation') || l.includes('client') ? 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5'
      : l.includes('user') || l.includes('people') ? 'M16 19v-2a4 4 0 00-8 0v2M12 11a3 3 0 100-6 3 3 0 000 6'
        : l.includes('categor') ? 'M4 6h16M4 12h16M4 18h10'
          : l.includes('mail') ? 'M3 7l9 6 9-6M3 7h18v10H3z'
            : l.includes('storage') || l.includes('plan') ? 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7'
              : l.includes('billing') ? 'M3 7h18v10H3zM3 11h18'
                : 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z';

  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

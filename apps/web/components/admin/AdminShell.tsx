'use client';

import { AppShell } from '@/components/shell/AppShell';
import { RailStorage } from '@/components/shell/RailStorage';
import { organisationNav, platformNav } from '@/lib/nav';

/**
 * Adapter kept so the existing admin pages did not all have to change at once.
 *
 * The `nav` prop those pages pass is now ignored — navigation comes from
 * lib/nav.tsx, so every screen shows the same tree rather than whichever
 * subset the page it happens to be on decided to list. New screens should use
 * AppShell directly; this exists so the redesign did not require rewriting
 * every page in the same commit, which is how a redesign turns into a rewrite.
 *
 * The scope distinction is preserved and still matters: super admin acts
 * across every organisation, org admin acts within one. The cost of confusing
 * them is suspending the wrong tenant, which is why the topbar carries a badge.
 */
export function AdminShell({
  scope,
  title,
  subtitle,
  children,
  actions,
}: {
  scope: 'platform' | 'organisation';
  title: string;
  subtitle?: string;
  /** Accepted and ignored — navigation is global now. Kept so call sites
   *  did not all need editing in the same commit. */
  nav?: { href: string; label: string }[];
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const isPlatform = scope === 'platform';

  return (
    <AppShell
      scope={isPlatform ? 'platform' : 'organisation'}
      brand="TatvaOS"
      sections={isPlatform ? platformNav() : organisationNav()}
      title={title}
      breadcrumb={[
        { label: isPlatform ? 'Platform' : 'Organisation' },
        ...(subtitle ? [{ label: subtitle }] : []),
      ]}
      actions={actions}
      // The organisation's pool, same meter as Space's rail. Platform admin
      // manages every tenant, so a single organisation's figure would lie.
      railFooter={isPlatform ? undefined : <RailStorage />}
    >
      {children}
    </AppShell>
  );
}

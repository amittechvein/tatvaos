import { BuildBadge } from '@/components/BuildBadge';
import { RequireAuth } from '@/components/RequireAuth';

/**
 * The platform console — Techvein onboarding customers.
 *
 * The role list here is a redirect, not a permission. The API refuses these
 * routes to anyone without the SuperAdmin policy regardless of what the
 * browser thinks.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // The build stamp lives on the consoles only — see app/layout.tsx.
  return (
    <RequireAuth roles={['super_admin']}>
      {children}
      <BuildBadge />
    </RequireAuth>
  );
}

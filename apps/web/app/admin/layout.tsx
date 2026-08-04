import { RequireAuth } from '@/components/RequireAuth';

/**
 * The platform console — Techvein onboarding customers.
 *
 * The role list here is a redirect, not a permission. The API refuses these
 * routes to anyone without the SuperAdmin policy regardless of what the
 * browser thinks.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth roles={['super_admin']}>{children}</RequireAuth>;
}

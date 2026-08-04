'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

/**
 * Client-side route guard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  THIS IS NOT A SECURITY CONTROL. It is a redirect.
 *
 *  Anyone can disable JavaScript, edit the bundle, or call the API directly.
 *  What actually protects data is the [Authorize] attribute on every endpoint
 *  and row-level security underneath it — this only stops a signed-out person
 *  seeing an empty console and concluding the product is broken.
 *
 *  If you ever find yourself relying on this to keep someone out of something,
 *  the check belongs on the server instead.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function RequireAuth({
  children,
  roles,
}: {
  children: React.ReactNode;
  /** When set, the signed-in user's role must be one of these. */
  roles?: string[];
}) {
  const { user, loading, mustChangePassword } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;

    if (!user) {
      // Carry the intended destination so the person lands where they meant
      // to go rather than on a dashboard they then have to navigate away from.
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    if (mustChangePassword && pathname !== '/change-password') {
      router.replace('/change-password');
      return;
    }

    if (roles && !roles.includes(user.role)) router.replace('/');
  }, [loading, user, mustChangePassword, roles, router, pathname]);

  // Render nothing rather than a spinner while the initial refresh settles.
  // The usual case resolves in well under a second, and a spinner that flashes
  // for 200ms reads as jank.
  if (loading || !user) return null;
  if (mustChangePassword && pathname !== '/change-password') return null;
  if (roles && !roles.includes(user.role)) return null;

  return <>{children}</>;
}

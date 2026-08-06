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
/**
 * The page a signed-in person belongs on, by role.
 *
 * This exists because "send them to /" is how the console once got stuck in a
 * loop: the landing page sent every signed-in user to /org, /org bounced
 * anyone who was not an admin back to /, and an ordinary employee's screen
 * blinked between the two forever. Every redirect-on-role must resolve to a
 * page the role can actually stay on.
 */
export function homeFor(role: string): string {
  switch (role) {
    case 'super_admin': return '/admin';
    case 'org_owner':
    case 'org_admin': return '/org';
    // INTERIM until the real Mail client ships: /mail/f-inbox is mock data,
    // and auto-landing anyone in a fake inbox reads as a broken product.
    // The account page is real — profile, sessions, password. When Mail is
    // live at mail.tatvaos.com, this becomes the inbox again.
    default: return '/account';
  }
}

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

    // Their own home, never '/'. The landing page forwards signed-in users
    // by role, so bouncing to '/' from a page their role cannot see would
    // ping-pong forever if their home were also denied — homeFor guarantees
    // it is not.
    if (roles && !roles.includes(user.role)) router.replace(homeFor(user.role));
  }, [loading, user, mustChangePassword, roles, router, pathname]);

  // Render nothing rather than a spinner while the initial refresh settles.
  // The usual case resolves in well under a second, and a spinner that flashes
  // for 200ms reads as jank.
  if (loading || !user) return null;
  if (mustChangePassword && pathname !== '/change-password') return null;
  if (roles && !roles.includes(user.role)) return null;

  return <>{children}</>;
}

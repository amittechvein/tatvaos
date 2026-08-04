'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

/**
 * Entry point. Sends people where they belong rather than to a fixed page.
 *
 * A client component, not a server redirect, because the signed-in state lives
 * in memory in the browser — the server genuinely does not know who this is
 * until a request carries a token, and guessing would send an administrator to
 * an inbox and a signed-out visitor to a screen that cannot load.
 */
export default function Home() {
  const { user, loading, mustChangePassword } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    if (!user) return router.replace('/login');
    if (mustChangePassword) return router.replace('/change-password');

    if (user.role === 'super_admin') return router.replace('/admin');
    if (user.role === 'org_owner' || user.role === 'org_admin') {
      return router.replace('/org/users');
    }
    router.replace('/mail/f-inbox');
  }, [loading, user, mustChangePassword, router]);

  return null;
}

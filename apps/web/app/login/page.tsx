'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

function SignInForm() {
  const { signIn, user, mustChangePassword, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in — usually a bookmarked /login or a back button.
  useEffect(() => {
    if (loading || !user) return;
    router.replace(mustChangePassword
      ? '/change-password'
      : params.get('next') ?? destinationFor(user.role));
  }, [loading, user, mustChangePassword, router, params]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      // The server returns one message for wrong password, unknown address and
      // suspended account, on purpose. Passing it straight through keeps that
      // property — inventing a friendlier client-side message would leak the
      // difference the server worked to hide.
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-ink">TatvaOS</h1>
          <p className="mt-1 text-sm text-ink-muted">Sign in to your account</p>
        </div>

        <form onSubmit={submit} className="rounded-lg border border-line bg-surface p-6 shadow-sm">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              {error}
            </div>
          )}

          <label className="block text-sm font-medium text-ink" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />

          <label className="mt-4 block text-sm font-medium text-ink" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />

          <button
            type="submit"
            disabled={busy || !email || !password}
            className="mt-6 w-full rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Forgotten your password? Your organisation&apos;s administrator can reset it.
        </p>
      </div>
    </div>
  );
}

/** Super admins run the platform; everyone else lands in their own product. */
function destinationFor(role: string): string {
  if (role === 'super_admin') return '/admin';
  if (role === 'org_owner' || role === 'org_admin') return '/org/users';
  return '/mail/f-inbox';
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and the build warns.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

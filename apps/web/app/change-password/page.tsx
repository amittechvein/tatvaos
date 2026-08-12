'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { MIN_PASSWORD, PASSWORD_HINT, PasswordStrength } from '@/components/ui/PasswordStrength';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-500';

/**
 * Forced on first sign-in, because the account still has a password an admin
 * generated, read off a screen and sent over chat. Until it is changed, the
 * person is not the only one who knows it.
 */
export default function ChangePasswordPage() {
  const { user, loading, changePassword } = useAuth();
  const router = useRouter();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user && !done) router.replace('/login');
  }, [loading, user, done, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (next !== confirm) return setError('The two new passwords do not match.');
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (next === current) return setError('The new password must be different from the current one.');

    setBusy(true);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
      setBusy(false);
    }
    return undefined;
  }

  if (done) {
    return (
      <Shell>
        <h1 className="mb-2 text-xl font-semibold text-ink">Password changed</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          Every other session has been signed out, including on your other devices.
          That is deliberate — if someone else knew the old password, leaving their
          session running would defeat the point of changing it.
        </p>
        <button
          type="button"
          onClick={() => router.replace('/login')}
          className="mt-7 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
        >
          Sign in again
        </button>
      </Shell>
    );
  }

  const mismatch = confirm.length > 0 && confirm !== next;

  return (
    <Shell>
      <h1 className="mb-1 text-xl font-semibold text-ink">Choose a new password</h1>
      <p className="mb-6 text-sm leading-relaxed text-ink-muted">
        Your current password was created by an administrator, so more than one
        person knows it.
      </p>

      <form onSubmit={submit} noValidate>
        {error && (
          <div className="mb-5 rounded-lg bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        <label className="mb-5 block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Current password</span>
          <input type="password" required autoComplete="current-password" className={INPUT}
                 value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">New password</span>
          <input type="password" required autoComplete="new-password" className={INPUT}
                 value={next} onChange={(e) => setNext(e.target.value)} />
        </label>

        <PasswordStrength value={next} />

        <label className="mt-5 block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Confirm new password</span>
          <input
            type="password" required autoComplete="new-password"
            className={`${INPUT} ${mismatch ? 'border-danger focus:border-danger' : ''}`}
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
          />
          <span className="mt-1 block h-4 text-xs text-danger">
            {mismatch ? 'These do not match.' : ''}
          </span>
        </label>

        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{PASSWORD_HINT}</p>

        <button
          type="submit"
          disabled={busy || !current || !next || !confirm}
          className="mt-6 w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-4">
      <div className="w-full max-w-[440px] rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
        {children}
      </div>
    </div>
  );
}

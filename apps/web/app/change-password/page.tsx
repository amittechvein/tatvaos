'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

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
    if (next.length < 12) return setError('Use at least 12 characters.');
    if (next === current) return setError('The new password must be different from the current one.');

    setBusy(true);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink">Password changed</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Every other session has been signed out, including on your other devices.
          That is deliberate — if someone else knew the old password, leaving their
          session running would defeat the point of changing it.
        </p>
        <button
          onClick={() => router.replace('/login')}
          className="mt-6 w-full rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Sign in again
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink">Choose a new password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Your current password was created by an administrator, so more than one person knows it.
      </p>

      <form onSubmit={submit} className="mt-6">
        {error && (
          <div role="alert" className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <Field label="Current password" id="current" value={current} onChange={setCurrent}
               autoComplete="current-password" />
        <Field label="New password" id="next" value={next} onChange={setNext}
               autoComplete="new-password" />
        <Field label="Confirm new password" id="confirm" value={confirm} onChange={setConfirm}
               autoComplete="new-password" />

        <p className="mt-3 text-xs text-ink-muted">
          At least 12 characters. Length matters far more than symbols — a short phrase you
          will actually remember beats something unmemorable with a punctuation mark in it.
        </p>

        <button
          type="submit"
          disabled={busy || !current || !next || !confirm}
          className="mt-6 w-full rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        {children}
      </div>
    </div>
  );
}

function Field({
  label, id, value, onChange, autoComplete,
}: {
  label: string; id: string; value: string;
  onChange: (v: string) => void; autoComplete: string;
}) {
  return (
    <div className="mt-4 first:mt-0">
      <label className="block text-sm font-medium text-ink" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        required
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    </div>
  );
}

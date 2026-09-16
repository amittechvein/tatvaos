'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { AuthCard, AUTH_INPUT, AUTH_BUTTON } from '@/components/ui/AuthCard';
import { MIN_PASSWORD, PASSWORD_HINT, PasswordStrength } from '@/components/ui/PasswordStrength';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

/**
 * The page the emailed reset link lands on.
 *
 * useSearchParams() opts a route into client-side rendering, and Next refuses
 * to prerender a page that calls it outside a Suspense boundary — without this
 * wrapper the production build fails outright. The fallback is never really
 * seen; the token is in the URL the browser already has.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCard><p className="text-sm text-ink-muted">Loading…</p></AuthCard>}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracked apart from `error` because a dead token is not something the person
  // can fix in this form — the only way forward is to request a fresh link.
  const [deadToken, setDeadToken] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (next !== confirm) return setError('The two passwords do not match.');
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);

    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 400) { setDeadToken(true); return undefined; }
      if (!res.ok || !body.reset) throw new Error(body.error ?? 'Could not reset the password.');

      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  // ---- a link that has expired or already been used --------------------
  if (deadToken || !token) {
    return (
      <AuthCard>
        <h1 className="mb-2 text-xl font-semibold text-ink">
          {token ? 'This link has expired' : 'This link is incomplete'}
        </h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          {token
            ? 'Reset links are single-use and short-lived, so this one no longer works — it was either already used or it timed out.'
            : 'The address is missing its reset token. It may have been cut short when the email was copied or forwarded.'}
        </p>
        <Link href="/forgot-password" className={`${AUTH_BUTTON} mt-7 block text-center no-underline`}>
          Request a new link
        </Link>
        <p className="mt-4 text-center text-sm text-ink-muted">
          <Link href="/login" className="inline-flex min-h-[2.75rem] items-center px-3 text-brand-600 hover:underline">Back to sign in</Link>
        </p>
      </AuthCard>
    );
  }

  // ---- done -------------------------------------------------------------
  if (done) {
    return (
      <AuthCard>
        <h1 className="mb-2 text-xl font-semibold text-ink">Password changed</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          Every session has been signed out, on this and any other device. That is
          deliberate — if someone else had the old password, leaving their session
          running would defeat the point of changing it.
        </p>
        <button type="button" className={`${AUTH_BUTTON} mt-7`} onClick={() => router.replace('/login')}>
          Go to sign in
        </button>
      </AuthCard>
    );
  }

  // ---- the form ---------------------------------------------------------
  return (
    <AuthCard>
      <h1 className="mb-1 text-xl font-semibold text-ink">Choose a new password</h1>
      <p className="mb-5 text-sm leading-relaxed text-ink-muted">
        Setting it signs out every device currently using this account.
      </p>

      <form onSubmit={submit} noValidate>
        {error && (
          <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">New password</span>
          <input type="password" required autoComplete="new-password" autoFocus
                 className={AUTH_INPUT} value={next}
                 onChange={(e) => setNext(e.target.value)} />
        </label>
        <PasswordStrength value={next} />

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Confirm new password</span>
          <input
            type="password" required autoComplete="new-password"
            className={`${AUTH_INPUT} ${confirm && confirm !== next ? 'border-danger focus:border-danger' : ''}`}
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
          />
          <span className="mt-1 block h-4 text-xs text-danger">
            {confirm && confirm !== next ? 'These do not match.' : ''}
          </span>
        </label>

        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{PASSWORD_HINT}</p>

        <button type="submit" className={`${AUTH_BUTTON} mt-6`} disabled={busy || !next || !confirm}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </AuthCard>
  );
}

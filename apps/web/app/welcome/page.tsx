'use client';

/**
 * The page an invitation link lands on — docs/decisions/0005.
 *
 *     https://core.tatvaos.com/welcome#t=<token>
 *
 * The token rides in the FRAGMENT, as the sign-in handoff's does (decision
 * 0003): a query string reaches the server, every proxy, and any access log;
 * a fragment never leaves the browser. What the browser DOES keep is history,
 * so the first thing this page does — before any render — is replace its own
 * URL with a bare /welcome. After that the token exists only in this page's
 * memory, and is POSTed once, with the password the person chose.
 *
 * There is no "is this link still good?" check before the form: asking would
 * spend nothing but would also tell nothing the submit does not, and the
 * reset page makes the same choice. A dead link is one sentence and a stop —
 * the person cannot use "forgot password" (their recovery email is not yet
 * verified), so the only way forward is the administrator.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AuthCard, AUTH_INPUT, AUTH_BUTTON } from '@/components/ui/AuthCard';
import { MIN_PASSWORD, PASSWORD_HINT, PasswordStrength } from '@/components/ui/PasswordStrength';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

// The server's sentence for expired, used, tampered and unknown alike.
const EXPIRED = 'This invitation has expired. Ask your administrator to send a new one.';

export default function WelcomePage() {
  // null until the effect has read the fragment; '' when there was none.
  const [token, setToken] = useState<string | null>(null);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const [done, setDone] = useState<{ email: string } | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const t = new URLSearchParams(hash).get('t') ?? '';
    // Scrub first, ask questions later. Nothing below may run before the
    // address bar and the history entry have stopped holding the token.
    window.history.replaceState(null, '', '/welcome');
    setToken(t);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (next !== confirm) return setError('The two passwords do not match.');
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);

    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/invite/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));

      // 401 is the server saying the token is no longer a credential; 429 is
      // the per-address limit. Neither is something this form can fix.
      if (res.status === 401) { setDead(true); return undefined; }
      if (!res.ok || !body.accepted) throw new Error(body.error ?? 'Could not set the password.');

      setDone({ email: String(body.email ?? '') });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password.');
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  // ---- still reading the fragment ---------------------------------------
  if (token === null) {
    return <AuthCard><p className="text-sm text-ink-muted">Loading…</p></AuthCard>;
  }

  // ---- a link that has expired, been used, or arrived incomplete ---------
  if (dead || token === '') {
    return (
      <AuthCard>
        <h1 className="mb-2 text-xl font-semibold text-ink">
          {token ? 'This invitation has expired' : 'This link is incomplete'}
        </h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          {token
            ? EXPIRED
            : 'The address is missing its invitation code. It may have been cut short when the email was copied or forwarded — try the link in the email again, or ask your administrator to send a new one.'}
        </p>
        <p className="mt-6 text-center text-sm text-ink-muted">
          <Link href="/login" className="inline-flex min-h-[2.75rem] items-center px-3 text-brand-600 hover:underline">
            Go to sign in
          </Link>
        </p>
      </AuthCard>
    );
  }

  // ---- done ---------------------------------------------------------------
  if (done) {
    return (
      <AuthCard>
        <h1 className="mb-2 text-xl font-semibold text-ink">Your password is set</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          Sign in as <strong className="text-ink">{done.email}</strong> with the password you just chose.
          Nobody else has it — not your administrator, not us.
        </p>
        <Link href="/login" className={`${AUTH_BUTTON} mt-7 block text-center no-underline`}>
          Sign in
        </Link>
      </AuthCard>
    );
  }

  // ---- the form -----------------------------------------------------------
  return (
    <AuthCard>
      <h1 className="mb-1 text-xl font-semibold text-ink">Choose your password</h1>
      <p className="mb-5 text-sm leading-relaxed text-ink-muted">
        Your organisation has created your TatvaOS account. Set the password you will sign in with.
      </p>

      <form onSubmit={submit} noValidate>
        {error && (
          <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Password</span>
          <input type="password" required autoComplete="new-password" autoFocus
                 className={AUTH_INPUT} value={next}
                 onChange={(e) => setNext(e.target.value)} />
        </label>
        <PasswordStrength value={next} />

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Confirm password</span>
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
          {busy ? 'Setting…' : 'Set password'}
        </button>
      </form>
    </AuthCard>
  );
}

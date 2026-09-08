'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { AuthCard, AUTH_BUTTON } from '@/components/ui/AuthCard';

type State = 'working' | 'ok' | 'fail';

/**
 * Lands the verification link from the recovery-email flow. Built on AuthCard
 * like the other anonymous auth screens, so it takes its colours from the
 * design tokens with them — no hex literals.
 */
export default function VerifyRecoveryEmailPage() {
  const [state, setState] = useState<State>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setState('fail'); setMessage('This link is missing its token.'); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/auth/recovery-email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await r.json().catch(() => ({} as { verified?: boolean; error?: string }));
        if (cancelled) return;
        if (r.ok && data.verified) { setState('ok'); }
        else { setState('fail'); setMessage(data.error ?? 'This link is invalid or has expired.'); }
      } catch {
        if (!cancelled) { setState('fail'); setMessage('Something went wrong. Please try again.'); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <AuthCard>
      <div className="text-center">
        {state === 'working' && (
          <p className="m-0 text-sm text-ink-muted">Confirming your recovery email...</p>
        )}
        {state === 'ok' && (
          <>
            <div className="mb-3 text-4xl text-ok">✓</div>
            <h1 className="mb-2 text-xl font-semibold text-ink">Recovery email confirmed</h1>
            <p className="mb-5 text-sm leading-relaxed text-ink-muted">
              You can now use this address to get back into your account if you are ever locked out.
            </p>
            <Link href="/org/users" className={`${AUTH_BUTTON} inline-block text-center no-underline`}>
              Continue
            </Link>
          </>
        )}
        {state === 'fail' && (
          <>
            <div className="mb-3 text-4xl text-warn">⚠</div>
            <h1 className="mb-2 text-xl font-semibold text-ink">Couldn&apos;t confirm this link</h1>
            <p className="mb-5 text-sm leading-relaxed text-ink-muted">{message}</p>
            <Link href="/"
              className="inline-block rounded-lg border border-line bg-surface px-5 py-2.5 text-sm font-semibold text-ink no-underline transition hover:bg-canvas">
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </AuthCard>
  );
}

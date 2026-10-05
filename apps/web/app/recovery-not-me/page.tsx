'use client';

import { useState } from 'react';
import Link from 'next/link';

import { AuthCard, AUTH_BUTTON } from '@/components/ui/AuthCard';

type State = 'ask' | 'working' | 'done' | 'fail';

/**
 * "This was not me" — decision 0009. The link in the notice a person gets when
 * an ADMINISTRATOR changed their recovery email. Pressing it puts the previous
 * address back, stops that administrator changing recovery emails until an
 * owner reviews it, and tells the owner. It never signs anyone in.
 *
 * It asks before acting rather than acting on load: mail scanners open links,
 * and a scanner must not be able to undo a change on its own.
 */
export default function RecoveryNotMePage() {
  const [state, setState] = useState<State>('ask');
  const [message, setMessage] = useState('');

  async function undo() {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setState('fail'); setMessage('This link is missing its token.'); return; }
    setState('working');
    try {
      const r = await fetch('/api/auth/recovery-email/not-me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await r.json().catch(() => ({} as { reverted?: boolean; message?: string; error?: string }));
      if (r.ok && data.reverted) { setMessage(data.message ?? 'Done.'); setState('done'); }
      else { setMessage(data.error ?? 'This link is invalid, has expired, or has already been used.'); setState('fail'); }
    } catch {
      setMessage('Something went wrong. Please try again.'); setState('fail');
    }
  }

  return (
    <AuthCard>
      <div className="text-center">
        {(state === 'ask' || state === 'working') && (
          <>
            <h1 className="mb-2 text-xl font-semibold text-ink">Undo the recovery email change?</h1>
            <p className="mb-5 text-sm leading-relaxed text-ink-muted">
              An administrator changed the recovery email on your account. If you did not ask for this, undo it:
              your previous recovery email comes back, and your organisation&apos;s owner is told.
            </p>
            <button type="button" className={AUTH_BUTTON} disabled={state === 'working'} onClick={() => void undo()}>
              {state === 'working' ? 'Undoing…' : 'This was not me — undo it'}
            </button>
          </>
        )}
        {state === 'done' && (
          <>
            <div className="mb-3 text-4xl text-ok">✓</div>
            <h1 className="mb-2 text-xl font-semibold text-ink">Change undone</h1>
            <p className="mb-5 text-sm leading-relaxed text-ink-muted">{message}</p>
            <Link href="/" className={`${AUTH_BUTTON} inline-block text-center no-underline`}>Go to sign in</Link>
          </>
        )}
        {state === 'fail' && (
          <>
            <div className="mb-3 text-4xl text-warn">⚠</div>
            <h1 className="mb-2 text-xl font-semibold text-ink">Couldn&apos;t undo this</h1>
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

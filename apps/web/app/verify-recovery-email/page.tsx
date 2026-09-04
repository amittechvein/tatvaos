'use client';

import { useEffect, useState } from 'react';

type State = 'working' | 'ok' | 'fail';

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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f2f4f9', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#fff', border: '1px solid #e6e9ee', borderRadius: 14, padding: 40, maxWidth: 440, width: '100%', textAlign: 'center' }}>
        {state === 'working' && <p style={{ margin: 0, color: '#4d5875' }}>Confirming your recovery email...</p>}
        {state === 'ok' && (
          <>
            <div style={{ fontSize: 40, marginBottom: 12, color: '#03b562' }}>&#10003;</div>
            <h1 style={{ fontSize: 22, margin: '0 0 8px', color: '#0a0a0a' }}>Recovery email confirmed</h1>
            <p style={{ margin: '0 0 20px', color: '#4d5875' }}>
              You can now use this address to get back into your account if you are ever locked out.
            </p>
            <a href="/org/users" style={{ display: 'inline-block', padding: '11px 22px', background: '#03b562', color: '#fff', textDecoration: 'none', borderRadius: 10, fontWeight: 600 }}>Continue</a>
          </>
        )}
        {state === 'fail' && (
          <>
            <div style={{ fontSize: 40, marginBottom: 12 }}>&#9888;</div>
            <h1 style={{ fontSize: 22, margin: '0 0 8px', color: '#0a0a0a' }}>Couldn&apos;t confirm this link</h1>
            <p style={{ margin: '0 0 20px', color: '#4d5875' }}>{message}</p>
            <a href="/" style={{ display: 'inline-block', padding: '11px 22px', background: '#eef1f5', color: '#0a0a0a', textDecoration: 'none', borderRadius: 10, fontWeight: 600 }}>Go to sign in</a>
          </>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useAuth } from '@/lib/auth';

interface RecoveryStatus {
  hasPhone: boolean;
  hasVerifiedRecoveryEmail: boolean;
  needsAttention: boolean;
}

/**
 * A non-blocking nudge to add a recovery email. Reads /api/auth/recovery-status
 * and, if the signed-in user has no VERIFIED recovery email, offers to add one.
 * Submitting stores it unverified and emails a confirmation link (the backend
 * does that); this only shows "check your inbox". Dismissible for the session,
 * and silent on any error — a reminder must never break the page it sits on.
 */
export function RecoveryReminder() {
  const { user, authedFetch } = useAuth();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let hide = false;
    try { hide = sessionStorage.getItem('recoveryReminderDismissed') === '1'; } catch { /* ignore */ }
    setDismissed(hide);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authedFetch('/auth/recovery-status');
        if (r.ok && !cancelled) setStatus(await r.json());
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [user, authedFetch]);

  if (!user || dismissed) return null;
  if (!status || status.hasVerifiedRecoveryEmail) return null;

  const close = () => {
    setDismissed(true);
    try { sessionStorage.setItem('recoveryReminderDismissed', '1'); } catch { /* ignore */ }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const r = await authedFetch('/auth/recovery-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const data = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) { setError(data.error ?? 'Could not save that address.'); return; }
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const card: CSSProperties = {
    position: 'fixed', right: 20, bottom: 20, zIndex: 1050, width: 340,
    maxWidth: 'calc(100vw - 32px)', background: '#ffffff', border: '1px solid #e6e9ee',
    borderRadius: 12, boxShadow: '0 10px 30px rgba(10,20,40,0.14)', padding: 18,
    fontSize: 14, color: '#0a0a0a',
  };

  return (
    <div style={card} role="dialog" aria-label="Add a recovery email">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>Add a recovery email</strong>
        <button onClick={close} aria-label="Dismiss"
          style={{ border: 'none', background: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: '#8d9eb5' }}>&times;</button>
      </div>
      {sent ? (
        <p style={{ margin: 0, color: '#4d5875' }}>
          Check that inbox &mdash; we&apos;ve sent a link to confirm it. You can close this.
        </p>
      ) : (
        <form onSubmit={submit}>
          <p style={{ margin: '0 0 10px', color: '#4d5875' }}>
            A recovery email helps you get back in if you&apos;re ever locked out of your account.
          </p>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@personal.com" disabled={busy}
            style={{ width: '100%', padding: '9px 11px', border: '1px solid #d5dae2', borderRadius: 8, fontSize: 14, marginBottom: 8, boxSizing: 'border-box' }} />
          {error && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={close} disabled={busy}
              style={{ padding: '8px 14px', border: 'none', background: '#eef1f5', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>Not now</button>
            <button type="submit" disabled={busy}
              style={{ padding: '8px 16px', border: 'none', background: '#03b562', color: '#fff', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {busy ? 'Sending...' : 'Send link'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

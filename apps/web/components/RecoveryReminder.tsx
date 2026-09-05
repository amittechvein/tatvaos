'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { AUTH_INPUT } from '@/components/ui/AuthCard';

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
 *
 * Colours come from the design tokens only (brand / ink / line / surface plus
 * the shadow and radius tokens) — no hex literals. This shipped on 4 Sept with
 * ten hardcoded values and was the one element left green when the palette
 * changed; it now recolours with the rest of the product.
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

  // Preflight is off in this app, so buttons declare their own border/cursor.
  const btnBase = 'cursor-pointer rounded-lg px-4 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div
      role="dialog"
      aria-label="Add a recovery email"
      className="fixed bottom-5 right-5 z-[1050] w-[340px] max-w-[calc(100vw-32px)] rounded-card border border-line bg-surface p-[18px] text-sm text-ink shadow-raised"
    >
      <div className="mb-2 flex items-start justify-between">
        <strong className="text-[15px] font-semibold text-ink">Add a recovery email</strong>
        <button type="button" onClick={close} aria-label="Dismiss"
          className="cursor-pointer border-0 bg-transparent p-0 text-xl leading-none text-ink-faint transition hover:text-ink">
          &times;
        </button>
      </div>
      {sent ? (
        <p className="m-0 leading-relaxed text-ink-muted">
          Check that inbox &mdash; we&apos;ve sent a link to confirm it. You can close this.
        </p>
      ) : (
        <form onSubmit={submit}>
          <p className="mb-2.5 mt-0 leading-relaxed text-ink-muted">
            A recovery email helps you get back in if you&apos;re ever locked out of your account.
          </p>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@personal.com" disabled={busy}
            className={`${AUTH_INPUT} mb-2`} />
          {error && <div className="mb-2 text-[13px] text-danger">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} disabled={busy}
              className={`${btnBase} border border-line bg-surface text-ink hover:bg-canvas`}>
              Not now
            </button>
            <button type="submit" disabled={busy}
              className={`${btnBase} border-0 bg-brand-600 font-semibold text-white hover:bg-brand-700`}>
              {busy ? 'Sending...' : 'Send link'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

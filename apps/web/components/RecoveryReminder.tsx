'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { AUTH_INPUT } from '@/components/ui/AuthCard';

// A snooze, not a per-tab flag. The first version used sessionStorage, which
// forgets the dismissal the moment a new tab opens - so the card came back on
// every visit. 48 hours, and also after a successful submit so it does not
// nag while the verification link is still sitting in the inbox.
const SNOOZE_KEY = 'recoveryReminderSnoozedUntil';
const SNOOZE_MS = 48 * 60 * 60 * 1000;

interface RecoveryStatus {
  hasPhone: boolean;
  hasVerifiedRecoveryEmail: boolean;
  needsAttention: boolean;
}

// A breath before it appears. Landing at the same instant as the page makes it
// read as part of the furniture and it gets clicked away without being read;
// arriving a moment later reads as a message.
const APPEAR_AFTER_MS = 1500;

/**
 * Asks for a recovery email as a CENTRED DIALOG, shortly after sign-in.
 *
 * ── WHY IT IS NOT A CORNER CARD ANY MORE (Amit, 23 September 2026) ────────
 *
 *  It was a floating card pinned bottom-right with both fields on show, and
 *  it did not look good there. Measured before changing it: on a 375px phone
 *  it covered 29% of the screen and four message rows, and the bottom-right
 *  corner is already occupied — Connect puts its chat button there (z-index
 *  1420, which drew OVER this card's 1050) and the build stamp sat under it.
 *  A corner is not free real estate in this product.
 *
 *  So it is centred, on a backdrop, and it is honest about interrupting
 *  rather than half-interrupting from a corner. It is still dismissible, it
 *  still snoozes for 48 hours, and it is still silent on every error.
 *
 *  NOT over a live meeting. A modal on top of a room somebody is presenting
 *  in is the one place this must never appear, and a corner card at least
 *  had the excuse of being out of the way. Same reasoning as the /oauth/
 *  exclusion below, which the CTO gave on 17 Sept.
 */
/**
 * Reads /api/auth/recovery-status
 * and, if the signed-in user has no VERIFIED recovery email, offers to add one.
 * Submitting stores it unverified and emails a confirmation link (the backend
 * does that); this only shows "check your inbox". Dismissible for 48 hours,
 * and silent on any error — a reminder must never break the page it sits on.
 *
 * Colours come from the design tokens only (brand / ink / line / surface plus
 * the shadow and radius tokens) — no hex literals. This shipped on 4 Sept with
 * ten hardcoded values and was the one element left green when the palette
 * changed; it now recolours with the rest of the product.
 */
export function RecoveryReminder() {
  const pathname = usePathname();
  const { user, authedFetch } = useAuth();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [email, setEmail] = useState('');
  // Adding a recovery email needs the current password (lib/recovery.ts says why).
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [ripe, setRipe] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setRipe(true), APPEAR_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let hide = false;
    try { hide = Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now(); } catch { /* ignore */ }
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

  const snooze = useCallback(() => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* ignore */ }
  }, []);
  const close = useCallback(() => {
    setDismissed(true);
    snooze();
  }, [snooze]);

  // Escape closes it, which anything calling itself a dialog has to do — and
  // this one now covers the page, so there must be a way out from the keyboard.
  // Declared above the early returns below: hooks cannot be conditional.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Never on the OpenID Connect pages: a consent screen is a security decision
  // about a third party, and everything on it that is not that decision
  // competes with it — cluttered consent screens teach people to click
  // through (CTO, 17 Sept 2026). Those pages are bare on purpose.
  if (pathname.startsWith('/oauth/')) return null;
  // Never over a live meeting — see the header.
  if (pathname.startsWith('/connect/room/')) return null;
  if (!user || dismissed || !ripe) return null;
  if (!status || status.hasVerifiedRecoveryEmail) return null;


  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('Enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Enter your current password.');
      return;
    }
    setBusy(true);
    try {
      const r = await authedFetch('/auth/recovery-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value, currentPassword: password }),
      });
      const data = await r.json().catch(() => ({} as { error?: string }));
      if (!r.ok) { setError(data.error ?? 'Could not save that address.'); return; }
      setSent(true);
      setPassword('');
      snooze();
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
      className="fixed inset-0 z-[1050] flex items-center justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-[2px]"
      // The backdrop dismisses, like every other dialog people use. It is the
      // same snooze as Skip, never a silent "no" that comes back tomorrow.
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a recovery email"
        // Without this, a click inside the card reaches the backdrop above and
        // closes the dialog the person is typing into.
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[400px] rounded-card border border-line bg-surface p-6 text-sm text-ink shadow-raised"
      >
      <div className="mb-2 flex items-start justify-between gap-4">
        <strong className="text-base font-semibold text-ink">Add a recovery email</strong>
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
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Current password" autoComplete="current-password" disabled={busy}
            aria-label="Current password"
            className={`${AUTH_INPUT} mb-2`} />
          {error && <div className="mb-2 text-[13px] text-danger">{error}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={close} disabled={busy}
              className={`${btnBase} border border-line bg-surface text-ink hover:bg-canvas`}>
              Skip
            </button>
            <button type="submit" disabled={busy}
              className={`${btnBase} border-0 bg-brand-600 font-semibold text-white hover:bg-brand-700`}>
              {busy ? 'Sending...' : 'Send link'}
            </button>
          </div>
        </form>
      )}
      </div>
    </div>
  );
}

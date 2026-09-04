'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AuthCard, AUTH_INPUT, AUTH_BUTTON } from '@/components/ui/AuthCard';
import { MIN_PASSWORD, PASSWORD_HINT, PasswordStrength } from '@/components/ui/PasswordStrength';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

/**
 * Password recovery, by email link or by phone OTP.
 *
 * Mirrors the login screen's email/phone split so the two ways in stay in the
 * same order and use the same words on both screens.
 *
 * The email side ALWAYS reports the same thing, whatever the server says. The
 * API deliberately does not reveal whether an address is registered, and a UI
 * that showed "no such account" would hand that back — turning the endpoint
 * into an account-enumeration oracle. Only a request that never completed is
 * reported as a failure, because that one is about the network, not the
 * address.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'email' | 'recovery' | 'phone'>('email');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- email ---
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);

  // --- recovery email ---
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoverySent, setRecoverySent] = useState(false);

  // --- phone ---
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  function switchTab(t: 'email' | 'recovery' | 'phone') {
    setTab(t);
    setError(null);
  }

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fetch(`${API}/auth/password/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      // Deliberately not checking res.ok — see the note above.
      setEmailSent(true);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function sendRecovery(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fetch(`${API}/auth/password/forgot-recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recoveryEmail.trim() }),
      });
      // Same anti-enumeration stance as the email flow — never reveal whether
      // the address matched. Only a request that never completed is a failure.
      setRecoverySent(true);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function sendOtp() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/auth/password/forgot-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not send the code.');
      setOtpSent(true);
      setDevCode(body.devCode ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function resetByOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (next !== confirm) return setError('The two passwords do not match.');
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);

    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/password/reset-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim(), newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'That code was not accepted.');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
      setBusy(false);
    }
    return undefined;
  }

  // ---- done: the reset endpoints revoke every session, so there is no
  //      auto-login to offer here. Signing in again is the only next step.
  if (done) {
    return (
      <AuthCard>
        <h1 className="mb-2 text-xl font-semibold text-ink">Password changed</h1>
        <p className="text-sm leading-relaxed text-ink-muted">
          Every session has been signed out, on this and any other device. Sign in
          with your new password to continue.
        </p>
        <button type="button" className={`${AUTH_BUTTON} mt-7`} onClick={() => router.replace('/login')}>
          Go to sign in
        </button>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1 className="mb-1 text-xl font-semibold text-ink">Reset your password</h1>
      <p className="mb-5 text-sm leading-relaxed text-ink-muted">
        Recover by email, a verified recovery email, or a code sent to your mobile.
      </p>

      <div className="mb-5 flex rounded-lg border border-line p-1">
        {(['email', 'recovery', 'phone'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => switchTab(t)}
            className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition ${
              tab === t ? 'bg-brand-600 text-white' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {t === 'email' ? 'Email' : t === 'recovery' ? 'Recovery' : 'Mobile OTP'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------- email */}
      {tab === 'email' && (
        emailSent ? (
          <>
            <div className="rounded-lg bg-ok/10 px-3 py-3 text-sm text-ink">
              If an account exists for that address, we&apos;ve sent a link to reset
              your password. The link expires shortly, and using it signs out every
              other session.
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              Nothing arrived? Check spam, then try again — or use a mobile code instead.
            </p>
            <button type="button" className={`${AUTH_BUTTON} mt-5`}
                    onClick={() => { setEmailSent(false); setEmail(''); }}>
              Try another address
            </button>
          </>
        ) : (
          <form onSubmit={sendEmail} noValidate>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">Email address</span>
              <input type="email" required autoComplete="email" className={AUTH_INPUT}
                     placeholder="you@yourdomain.com"
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button type="submit" className={`${AUTH_BUTTON} mt-5`}
                    disabled={busy || email.trim().length < 5}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )
      )}

      {/* ------------------------------------------------------- recovery */}
      {tab === 'recovery' && (
        recoverySent ? (
          <>
            <div className="rounded-lg bg-ok/10 px-3 py-3 text-sm text-ink">
              If that address is a verified recovery email on an account, we&apos;ve
              sent a link to reset the password. The link expires shortly, and using
              it signs out every other session.
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              Nothing arrived? Check spam, then try again — or use a mobile code instead.
            </p>
            <button type="button" className={`${AUTH_BUTTON} mt-5`}
                    onClick={() => { setRecoverySent(false); setRecoveryEmail(''); }}>
              Try another address
            </button>
          </>
        ) : (
          <form onSubmit={sendRecovery} noValidate>
            <p className="mb-4 text-sm leading-relaxed text-ink-muted">
              Locked out of your mailbox? Enter the recovery email you verified on
              your account and we&apos;ll send the reset link there instead.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">Recovery email address</span>
              <input type="email" required autoComplete="email" className={AUTH_INPUT}
                     placeholder="you@personal.com"
                     value={recoveryEmail} onChange={(e) => setRecoveryEmail(e.target.value)} />
            </label>
            <button type="submit" className={`${AUTH_BUTTON} mt-5`}
                    disabled={busy || recoveryEmail.trim().length < 5}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )
      )}

      {/* ---------------------------------------------------------- phone */}
      {tab === 'phone' && (
        <form onSubmit={resetByOtp} noValidate>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Mobile number</span>
            <input type="tel" required autoComplete="tel" className={AUTH_INPUT}
                   placeholder="+91 98765 43210" disabled={otpSent}
                   value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>

          {!otpSent ? (
            <button type="button" className={`${AUTH_BUTTON} mt-5`}
                    disabled={busy || phone.trim().length < 8}
                    onClick={() => void sendOtp()}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          ) : (
            <>
              {devCode && (
                <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-ink">
                  Testing mode — your code is <strong>{devCode}</strong>
                </p>
              )}

              <label className="mt-4 block">
                <span className="mb-1.5 block text-sm font-medium text-ink">Six-digit code</span>
                <input inputMode="numeric" required className={`${AUTH_INPUT} tracking-[0.3em]`}
                       placeholder="000000" value={code}
                       onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </label>

              <label className="mt-4 block">
                <span className="mb-1.5 block text-sm font-medium text-ink">New password</span>
                <input type="password" required autoComplete="new-password" className={AUTH_INPUT}
                       value={next} onChange={(e) => setNext(e.target.value)} />
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

              <button type="submit" className={`${AUTH_BUTTON} mt-5`}
                      disabled={busy || code.length !== 6 || !next || !confirm}>
                {busy ? 'Changing…' : 'Change password'}
              </button>
              <button type="button" className="mt-2 w-full text-xs text-ink-muted hover:text-ink"
                      disabled={busy} onClick={() => void sendOtp()}>
                Send a new code
              </button>
            </>
          )}
        </form>
      )}

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/login" className="text-brand-600 hover:underline">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}

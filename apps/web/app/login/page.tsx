'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { useAuth, type MfaChallenge } from '@/lib/auth';
import { homeFor } from '@/components/RequireAuth';

// ============================================================================
//  Sign-in
// ============================================================================
//
//  A split layout: what TatvaOS Core IS on the left, the form on the right.
//
//  The left panel is not decoration. Almost everyone who reaches this screen
//  is an administrator at a school, clinic or business who was sent a link and
//  a temporary password, and has no idea what they have been given access to.
//  Telling them — in four lines — is the difference between "another email
//  thing" and "the platform our organisation runs on".
//
//  It collapses on small screens. On a phone, someone signing in wants the
//  form, and a marketing panel above it means scrolling past your own product
//  to use it.
//
//  ---------------------------------------------------------------------------
//  CONVERTED OFF MUI. Layout is flex and Bootstrap utilities, never Tailwind's
//  grid — YZEN ships a colliding 12-column `.grid`, and arbitrary values are
//  silently flattened. Tailwind's preflight is off, so inputs and lists carry
//  explicit classes rather than relying on a reset that is not there.
// ============================================================================

/**
 * The brand ramp, fixed here now that MUI's palette has gone.
 *
 * These are LITERALS and that is a known debt, not a choice: the two gradients
 * below interpolate between three stops, and a CSS custom property cannot be
 * read into a template string at build time. They must be kept in step with
 * --brand-700 / --brand-500 / --brand-400 in styles/globals.css by hand.
 *
 * On 5 Sept 2026 they were the last green left in the product after the
 * palette moved to violet — on the login page, which is the first thing every
 * customer sees. If you are changing the palette again, grep for '#' in
 * app/login, app/signup and app/(marketing): those three pages carry their own
 * colours and no token change will reach them. Ending that is stage 3 of
 * docs/UI_LANE_BRIEF.md.
 */
const BRAND_DARK = '#4A29A8';   // --brand-700
const BRAND = '#6C3CE9';        // --brand-500
const BRAND_LIGHT = '#8F6BEC';  // --brand-400

const CAPABILITIES = [
  {
    title: 'One identity, every product',
    body: 'A person exists once. One sign-in reaches Mail today and Drive, People and Payroll as they arrive — and one suspend removes all of them at once.',
    d: 'M16 19v-2a4 4 0 00-8 0v2M12 11a3 3 0 100-6 3 3 0 000 6',
  },
  {
    title: 'Isolation enforced by the database',
    body: 'Every organisation’s data is separated by PostgreSQL row-level security, not by application code remembering to filter. It holds even when the code is wrong.',
    d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  },
  {
    title: 'Storage bought once, split by you',
    body: 'Buy one number and divide it across products yourself. Move space from Mail to Drive whenever you like, without a new purchase or a support ticket.',
    d: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7',
  },
  {
    title: 'Data kept in India',
    body: 'Hosted in-region for DPDP compliance, with a full audit trail of every administrative action taken on your organisation — including by us.',
    d: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18a15 15 0 010-18',
  },
];

const ROADMAP = [
  { label: 'Mail', live: true },
  { label: 'Drive', live: false },
  { label: 'People', live: false },
  { label: 'Payroll', live: false },
  { label: 'Sheet', live: false },
  { label: 'Word', live: false },
];

function SignInForm() {
  const { signIn, requestOtp, signInWithOtp, verifyMfa, user, mustChangePassword, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  // "Add account" arrives here with a live session on purpose, so the
  // already-signed-in redirect below has to stand down — otherwise the person
  // clicks Add account and gets bounced straight back to the dashboard.
  const adding = params.get('add') === '1';

  // The remembered EMAIL, never the password. An email is an identifier the
  // person types in front of colleagues; a password is a credential. Banks
  // offer exactly this split ("Remember User ID") for the same reason.
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [remember, setRemember] = useState(false);
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Tabs: password, mobile OTP, QR. QR needs the mobile app to scan with,
  // and there is no mobile app yet — shown disabled rather than hidden, so
  // the login screen states the roadmap the same way the launcher does.
  const [tab, setTab] = useState<'email' | 'otp' | 'qr'>('email');

  // Mobile OTP flow state.
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  // Where to land after sign-in. Persisted, because someone who lives in
  // their inbox should not pass through a dashboard every morning.
  const [startIn, setStartIn] = useState<'default' | 'mail'>('default');

  // Set when the password (or SMS code) was right and the account has
  // two-step verification on. Its presence replaces the whole form with the
  // code step — the credential is already spent and re-showing the password
  // field invites people to type it again into what looks like a failure.
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('tv_login_email');
      if (saved && !params.get('email')) { setEmail(saved); setRemember(true); }
      // "Start in" is deliberately NOT restored from storage while Mail is
      // still the mock. A remembered 'mail' made the site auto-open the fake
      // inbox on every visit — including a mere visit to /login while signed
      // in. When the real client ships, restore it here so people who live
      // in their inbox skip the dashboard: tv_start_in.
    } catch { /* private browsing */ }
    // Run once on mount, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((v) => v - 1), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  // Already signed in — usually a bookmarked /login or a back button.
  useEffect(() => {
    if (loading || !user || adding) return;
    router.replace(mustChangePassword
      ? '/change-password'
      : params.get('next')
        ?? (startIn === 'mail' ? '/mail/inbox' : homeFor(user.role)));
  }, [loading, user, mustChangePassword, router, params, adding, startIn]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      try {
        if (remember) localStorage.setItem('tv_login_email', email.trim());
        else localStorage.removeItem('tv_login_email');
        localStorage.setItem('tv_start_in', startIn);
      } catch { /* private browsing */ }
      const pending = await signIn(email.trim(), password);
      if (pending) { setChallenge(pending); setBusy(false); return; }
    } catch (err) {
      // The server returns one message for wrong password, unknown address and
      // suspended account, on purpose. Passing it straight through keeps that
      // property — inventing a friendlier client-side message would leak the
      // difference the server worked to hide.
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  async function sendOtp() {
    setError(null);
    setBusy(true);
    try {
      const { devCode: dc } = await requestOtp(phone.trim());
      setOtpSent(true);
      setDevCode(dc);
      setResendIn(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      try { localStorage.setItem('tv_start_in', startIn); } catch { /* private */ }
      const pending = await signInWithOtp(phone.trim(), otpCode.trim());
      if (pending) { setChallenge(pending); setBusy(false); return; }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  const TABS: { id: 'email' | 'otp' | 'qr'; label: string; disabled?: boolean }[] = [
    { id: 'email', label: 'Email' },
    { id: 'otp', label: 'Mobile OTP' },
    { id: 'qr', label: 'QR code', disabled: true },
  ];

  return (
    // minHeight AND height: the panel is a fixed-height column that manages
    // its own overflow, so the page itself should not scroll on a laptop.
    <div className="d-flex bg-white login-shell" style={{ minHeight: '100vh' }}>
      {/* ---------------------------------------------------------------- */}
      {/*  Left: what this is                                              */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="d-none d-lg-flex flex-column position-relative text-white"
        style={{
          width: '54%',
          // Tighter padding and a scroll container, because the panel has to
          // survive a 660px-tall laptop viewport. Without this the roadmap —
          // the one part that answers "what else is coming" — falls below the
          // fold, which is the only part of the panel that cannot be inferred
          // from the rest.
          padding: '36px 40px',
          overflow: 'hidden',
          maxHeight: '100vh',
          background: `linear-gradient(135deg, ${BRAND_DARK} 0%, ${BRAND} 55%, ${BRAND_LIGHT} 100%)`,
        }}
      >
        {/* Two soft discs, to stop a flat gradient reading as a placeholder.
            Cheaper than an illustration. */}
        <div aria-hidden className="position-absolute rounded-circle"
             style={{ width: 480, height: 480, top: -160, right: -140, background: 'rgba(255,255,255,0.07)' }} />
        <div aria-hidden className="position-absolute rounded-circle"
             style={{ width: 320, height: 320, bottom: -110, left: -80, background: 'rgba(255,255,255,0.05)' }} />

        <div className="position-relative d-flex flex-column h-100">
          <div className="d-flex align-items-center gap-3">
            <span
              className="d-grid"
              style={{
                width: 44, height: 44, borderRadius: 12, placeItems: 'center',
                fontWeight: 700, fontSize: 20,
                background: 'rgba(255,255,255,0.18)',
                border: '1px solid rgba(255,255,255,0.25)',
              }}
            >
              T
            </span>
            <span>
              <span className="d-block" style={{ fontWeight: 700, fontSize: 22, lineHeight: 1.15,
                                                 letterSpacing: '0.01em' }}>
                TatvaOS <span style={{ opacity: 0.7, fontWeight: 400 }}>Core</span>
              </span>
              <span className="d-block" style={{ fontSize: 12.5, opacity: 0.72, letterSpacing: '0.04em' }}>
                by Techvein
              </span>
            </span>
          </div>

          <p className="mb-0" style={{ marginTop: 32, fontSize: 30, fontWeight: 600,
                                       lineHeight: 1.2, maxWidth: 520, letterSpacing: '-0.02em' }}>
            One identity.<br />Every product.
          </p>

          <p className="mb-0" style={{ marginTop: 14, fontSize: 15, opacity: 0.82,
                                       maxWidth: 500, lineHeight: 1.6 }}>
            Core is the layer your organisation runs on — people, domains, storage
            and billing in one place. Products plug into it.
          </p>

          <div className="d-flex flex-column gap-3" style={{ marginTop: 28, maxWidth: 520 }}>
            {CAPABILITIES.map((c) => (
              <div key={c.title} className="d-flex gap-3">
                <span
                  className="d-grid flex-shrink-0"
                  style={{
                    width: 38, height: 38, borderRadius: 10, placeItems: 'center',
                    background: 'rgba(255,255,255,0.14)',
                  }}
                >
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d={c.d} />
                  </svg>
                </span>
                <span>
                  <span className="d-block" style={{ fontWeight: 600, fontSize: 15 }}>{c.title}</span>
                  <span className="d-block" style={{ fontSize: 13.5, opacity: 0.76,
                                                     lineHeight: 1.6, marginTop: 2 }}>
                    {c.body}
                  </span>
                </span>
              </div>
            ))}
          </div>

          {/* The roadmap, stated rather than implied. Shipped and not-yet are
              visibly different — promising six products and delivering one is
              how a platform loses the customer it just won. */}
          <div className="mt-auto" style={{ paddingTop: 28 }}>
            <p className="mb-2" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.09em',
                                         textTransform: 'uppercase', opacity: 0.62 }}>
              Products
            </p>
            <div className="d-flex flex-wrap gap-2">
              {ROADMAP.map((p) => (
                <span
                  key={p.label}
                  className="badge rounded-pill"
                  style={{
                    fontWeight: 500,
                    color: '#fff',
                    background: `rgba(255,255,255,${p.live ? 0.24 : 0.08})`,
                    border: `1px solid rgba(255,255,255,${p.live ? 0.35 : 0.16})`,
                    opacity: p.live ? 1 : 0.7,
                  }}
                >
                  {p.live ? p.label : `${p.label} · soon`}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/*  Right: the form                                                 */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex-fill d-grid p-4 p-sm-5" style={{ placeItems: 'center' }}>
        <div className="w-100" style={{ maxWidth: 400 }}>
          {/* Brand repeats on small screens, where the left panel is hidden
              and the page would otherwise be an unlabelled password prompt. */}
          <div className="d-flex d-lg-none align-items-center gap-2 mb-5">
            <span
              className="d-grid text-white"
              style={{
                width: 40, height: 40, borderRadius: 10, placeItems: 'center',
                fontWeight: 700, fontSize: 18,
                background: `linear-gradient(72deg, ${BRAND}, ${BRAND_LIGHT})`,
              }}
            >
              T
            </span>
            <span style={{ fontSize: 22, fontWeight: 700 }}>
              TatvaOS <span className="text-muted" style={{ fontWeight: 400 }}>Core</span>
            </span>
          </div>

          {/* ------------------------------------------------------------
              Two-step verification.

              This REPLACES the form rather than appearing beneath it. The
              password has already been accepted and spent; leaving the field
              on screen invites someone to read the code error as a password
              error and type it again, which is how people end up locked out
              by their own retry.

              There is no "back" — starting over means reloading the page and
              entering the password again, which is correct: the challenge
              expires in five minutes and a stale one is not worth a button.
          ------------------------------------------------------------ */}
          {challenge ? (
            <>
              <h1 className="mb-1" style={{ fontSize: 28, fontWeight: 600 }}>Two-step verification</h1>
              <p className="fs-14 text-muted mb-3">{challenge.note}</p>

              {error && <div className="alert alert-danger mb-3">{error}</div>}

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError(null);
                  setBusy(true);
                  try {
                    await verifyMfa(challenge.challenge, mfaCode.trim());
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'That code was not accepted.');
                    setBusy(false);
                  }
                }}
                noValidate
              >
                <div className="mb-3">
                  <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-mfa">
                    Code <span className="text-danger">*</span>
                  </label>
                  {/* Not restricted to digits, and not maxLength 6: a recovery
                      code is accepted in the same box, and stripping letters
                      would make it impossible to type the one thing that helps
                      when the phone is gone. */}
                  <input
                    id="tv-mfa"
                    className="form-control"
                    autoFocus
                    autoComplete="one-time-code"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                  />
                  <div className="form-text fs-12">
                    Six digits from your authenticator app, or one of your recovery codes.
                  </div>
                </div>

                <button type="submit" className="btn btn-primary btn-lg w-100"
                        disabled={busy || mfaCode.trim().length === 0}>
                  {busy ? 'Checking…' : 'Verify'}
                </button>
              </form>

              <p className="fs-12 text-muted mt-4 mb-0" style={{ lineHeight: 1.7 }}>
                Lost your phone and your recovery codes? Your organisation&apos;s administrator
                can reset two-step verification for you. Techvein staff cannot.
              </p>
            </>
          ) : (
          <>
          <h1 className="mb-1" style={{ fontSize: 28, fontWeight: 600 }}>Welcome back</h1>
          <p className="fs-14 text-muted mb-3">Sign in to administer your organisation.</p>

          {/* Three ways in, the way every Indian bank lays them out — the
              audience already knows this screen by heart. QR needs the mobile
              app to scan with; until that ships it is visibly coming rather
              than quietly missing. */}
          <ul className="nav nav-tabs mb-4" role="tablist">
            {TABS.map((t) => (
              <li key={t.id} className="nav-item" role="presentation">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  disabled={t.disabled}
                  className={`nav-link fs-14 fw-semibold ${tab === t.id ? 'active' : ''} ${t.disabled ? 'disabled' : ''}`}
                  onClick={() => { setTab(t.id); setError(null); }}
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>

          {error && <div className="alert alert-danger mb-3">{error}</div>}

          {tab === 'otp' && (
            <form onSubmit={submitOtp} noValidate>
              <div className="mb-3">
                <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-phone">
                  Mobile number <span className="text-danger">*</span>
                </label>
                <input
                  id="tv-phone"
                  className="form-control"
                  type="tel"
                  autoComplete="tel"
                  required
                  placeholder="+91 98765 43210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={otpSent}
                />
              </div>

              {!otpSent ? (
                <button type="button" className="btn btn-primary btn-lg w-100"
                        disabled={busy || phone.trim().length < 8}
                        onClick={() => void sendOtp()}>
                  {busy ? 'Sending…' : 'Send code'}
                </button>
              ) : (
                <>
                  <div className="alert alert-info mb-3">
                    If this number is registered, a 6-digit code is on its way.
                    It works for 5 minutes.
                  </div>
                  {devCode && (
                    <div className="alert alert-warning mb-3">
                      On-screen codes are switched on and the SMS did not go out,
                      so the code is shown here: <strong>{devCode}</strong>
                    </div>
                  )}
                  <div className="mb-3">
                    <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-otp">
                      6-digit code <span className="text-danger">*</span>
                    </label>
                    <input
                      id="tv-otp"
                      className="form-control"
                      required
                      autoFocus
                      inputMode="numeric"
                      maxLength={6}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                  </div>
                  <button type="submit" className="btn btn-primary btn-lg w-100"
                          disabled={busy || otpCode.length !== 6}>
                    {busy ? 'Signing in…' : 'Sign in'}
                  </button>
                  <button type="button" className="btn btn-link btn-sm w-100 mt-2"
                          disabled={busy || resendIn > 0}
                          onClick={() => void sendOtp()}>
                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                  </button>
                </>
              )}
            </form>
          )}

          {tab === 'email' && (
            <form onSubmit={submit} noValidate>
              <div className="mb-3">
                <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-email">
                  Email address <span className="text-danger">*</span>
                </label>
                <input
                  id="tv-email"
                  className="form-control"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="mb-2">
                <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-password">
                  Password <span className="text-danger">*</span>
                </label>
                <div className="input-group">
                  <input
                    id="tv-password"
                    className="form-control"
                    type={reveal ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {/* A reveal toggle reduces failed attempts on long
                      passwords, and this account locks after five. */}
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    onClick={() => setReveal((v) => !v)}
                    aria-label={reveal ? 'Hide password' : 'Show password'}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                      {!reveal && <path d="M4 20L20 4" />}
                    </svg>
                  </button>
                </div>
              </div>

              <div className="form-check mt-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="tv-remember"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <label className="form-check-label fs-14" htmlFor="tv-remember">
                  Remember my email on this device
                </label>
              </div>

              <button type="submit" className="btn btn-primary btn-lg w-100 mt-3"
                      disabled={busy || !email || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>

              {/* Anonymous recovery. The mobile-code route works today; the
                  emailed link depends on outbound SMTP being unblocked. */}
              <p className="text-center fs-14 mt-4 mb-0">
                <Link href="/forgot-password" className="text-decoration-none" style={{ color: BRAND }}>
                  Forgot password?
                </Link>
              </p>
            </form>
          )}

          {/* Outside the tabs: applies to whichever way you sign in. */}
          <div className="mt-4">
            <label className="form-label fs-13 fw-medium mb-1" htmlFor="tv-startin">Start in</label>
            <select
              id="tv-startin"
              className="form-select form-select-sm"
              value={startIn}
              onChange={(e) => setStartIn(e.target.value as 'default' | 'mail')}
            >
              <option value="default">Dashboard</option>
              <option value="mail">Mail inbox</option>
            </select>
            <div className="form-text fs-12">Where you land after signing in</div>
          </div>

          <p className="fs-12 text-muted mt-4 mb-0" style={{ lineHeight: 1.7 }}>
            Forgotten your password? Your organisation&apos;s administrator can reset
            it. Techvein staff cannot read your mail — administrative access never
            implies access to contents.
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and the build warns.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

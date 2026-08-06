'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { useAuth } from '@/lib/auth';

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
// ============================================================================

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
  const { signIn, requestOtp, signInWithOtp, user, mustChangePassword, loading } = useAuth();
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

  useEffect(() => {
    try {
      const saved = localStorage.getItem('tv_login_email');
      if (saved && !params.get('email')) { setEmail(saved); setRemember(true); }
      const s = localStorage.getItem('tv_start_in');
      if (s === 'mail') setStartIn('mail');
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
        ?? (startIn === 'mail' ? '/mail/f-inbox' : destinationFor(user.role)));
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
      await signIn(email.trim(), password);
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
      await signInWithOtp(phone.trim(), otpCode.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    // minHeight AND height: the panel is a fixed-height column that manages
    // its own overflow, so the page itself should not scroll on a laptop.
    <Box sx={{ display: 'flex', minHeight: '100vh', height: { lg: '100vh' },
               overflow: { lg: 'hidden' }, bgcolor: 'background.paper' }}>
      {/* ---------------------------------------------------------------- */}
      {/*  Left: what this is                                              */}
      {/* ---------------------------------------------------------------- */}
      <Box
        sx={{
          display: { xs: 'none', lg: 'flex' },
          flexDirection: 'column',
          width: '54%',
          // Tighter padding and a scroll container, because the panel has to
          // survive a 660px-tall laptop viewport. Without this the roadmap —
          // the one part that answers "what else is coming" — falls below the
          // fold, which is the only part of the panel that cannot be inferred
          // from the rest.
          px: { lg: 5, xl: 7 },
          py: { lg: 4.5, xl: 6 },
          position: 'relative',
          overflow: 'hidden',
          maxHeight: '100vh',
          color: '#fff',
          background: (t) =>
            `linear-gradient(135deg, ${t.palette.primary.dark} 0%, ${t.palette.primary.main} 55%, ${t.palette.primary.light} 100%)`,
        }}
      >
        {/* Two soft discs, to stop a flat gradient reading as a placeholder.
            Cheaper than an illustration and it recolours with the theme. */}
        <Box aria-hidden sx={{ position: 'absolute', width: 480, height: 480, borderRadius: '50%',
          top: -160, right: -140, bgcolor: alpha('#fff', 0.07) }} />
        <Box aria-hidden sx={{ position: 'absolute', width: 320, height: 320, borderRadius: '50%',
          bottom: -110, left: -80, bgcolor: alpha('#fff', 0.05) }} />

        <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.75 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2.5, display: 'grid',
                       placeItems: 'center', fontWeight: 700, fontSize: 20,
                       bgcolor: alpha('#fff', 0.18),
                       border: `1px solid ${alpha('#fff', 0.25)}` }}>
              T
            </Box>
            <Box>
              <Typography sx={{ fontWeight: 700, fontSize: 22, lineHeight: 1.15,
                                letterSpacing: '0.01em' }}>
                TatvaOS <Box component="span" sx={{ opacity: 0.7, fontWeight: 400 }}>Core</Box>
              </Typography>
              <Typography sx={{ fontSize: 12.5, opacity: 0.72, letterSpacing: '0.04em' }}>
                by Techvein
              </Typography>
            </Box>
          </Box>

          <Typography sx={{ mt: { lg: 4, xl: 6 }, fontSize: { lg: 30, xl: 34 }, fontWeight: 600,
                            lineHeight: 1.2, maxWidth: 520, letterSpacing: '-0.02em' }}>
            One identity.<br />Every product.
          </Typography>

          <Typography sx={{ mt: 1.75, fontSize: 15, opacity: 0.82, maxWidth: 500, lineHeight: 1.6 }}>
            Core is the layer your organisation runs on — people, domains, storage
            and billing in one place. Products plug into it.
          </Typography>

          <Stack spacing={{ lg: 2.25, xl: 3 }} sx={{ mt: { lg: 3.5, xl: 5 }, maxWidth: 520 }}>
            {CAPABILITIES.map((c) => (
              <Box key={c.title} sx={{ display: 'flex', gap: 2 }}>
                <Box sx={{ width: 38, height: 38, borderRadius: 2, flexShrink: 0,
                           display: 'grid', placeItems: 'center',
                           bgcolor: alpha('#fff', 0.14) }}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d={c.d} />
                  </svg>
                </Box>
                <Box>
                  <Typography sx={{ fontWeight: 600, fontSize: 15 }}>{c.title}</Typography>
                  <Typography sx={{ fontSize: 13.5, opacity: 0.76, lineHeight: 1.6, mt: 0.25 }}>
                    {c.body}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Stack>

          {/* The roadmap, stated rather than implied. Shipped and not-yet are
              visibly different — promising six products and delivering one is
              how a platform loses the customer it just won. */}
          <Box sx={{ mt: 'auto', pt: { lg: 3.5, xl: 6 } }}>
            <Typography sx={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.09em',
                              textTransform: 'uppercase', opacity: 0.62, mb: 1.5 }}>
              Products
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {ROADMAP.map((p) => (
                <Chip
                  key={p.label}
                  size="small"
                  label={p.live ? p.label : `${p.label} · soon`}
                  sx={{
                    fontWeight: 500,
                    color: '#fff',
                    bgcolor: alpha('#fff', p.live ? 0.24 : 0.08),
                    border: `1px solid ${alpha('#fff', p.live ? 0.35 : 0.16)}`,
                    opacity: p.live ? 1 : 0.7,
                  }}
                />
              ))}
            </Box>
          </Box>
        </Box>
      </Box>

      {/* ---------------------------------------------------------------- */}
      {/*  Right: the form                                                 */}
      {/* ---------------------------------------------------------------- */}
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: { xs: 3, sm: 6 } }}>
        <Box sx={{ width: '100%', maxWidth: 400 }}>
          {/* Brand repeats on small screens, where the left panel is hidden
              and the page would otherwise be an unlabelled password prompt. */}
          <Box sx={{ display: { xs: 'flex', lg: 'none' }, alignItems: 'center',
                     gap: 1.5, mb: 5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: 2, display: 'grid',
                       placeItems: 'center', color: '#fff', fontWeight: 700, fontSize: 18,
                       background: (t) => `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})` }}>
              T
            </Box>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              TatvaOS <Box component="span" sx={{ color: 'text.disabled', fontWeight: 400 }}>Core</Box>
            </Typography>
          </Box>

          <Typography variant="h4" sx={{ mb: 0.75 }}>Welcome back</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Sign in to administer your organisation.
          </Typography>

          {/* Three ways in, the way every Indian bank lays them out — the
              audience already knows this screen by heart. QR needs the mobile
              app to scan with; until that ships it is visibly coming rather
              than quietly missing. */}
          <Tabs value={tab} onChange={(_, v) => { setTab(v); setError(null); }}
                sx={{ mb: 3, minHeight: 40,
                      '& .MuiTab-root': { minHeight: 40, textTransform: 'none',
                                          fontWeight: 600, fontSize: 14 } }}>
            <Tab value="email" label="Email" />
            <Tab value="otp" label="Mobile OTP" />
            <Tab value="qr" label="QR code" disabled />
          </Tabs>

          {error && <Alert severity="error" sx={{ mb: 2.5 }}>{error}</Alert>}

          {tab === 'otp' && (
          <Box component="form" onSubmit={submitOtp} noValidate>
            <TextField
              fullWidth
              label="Mobile number"
              type="tel"
              autoComplete="tel"
              required
              placeholder="+91 98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={otpSent}
              sx={{ mb: 2.5 }}
            />

            {!otpSent ? (
              <Button fullWidth variant="contained" size="large"
                      disabled={busy || phone.trim().length < 8}
                      onClick={() => void sendOtp()}>
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            ) : (
              <>
                <Alert severity="info" sx={{ mb: 2.5 }}>
                  If this number is registered, a 6-digit code is on its way.
                  It works for 5 minutes.
                </Alert>
                {devCode && (
                  <Alert severity="warning" sx={{ mb: 2.5 }}>
                    Testing mode — SMS is not configured, so the code is shown
                    here: <strong>{devCode}</strong>
                  </Alert>
                )}
                <TextField
                  fullWidth
                  label="6-digit code"
                  required
                  autoFocus
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }}
                  sx={{ mb: 2.5 }}
                />
                <Button type="submit" fullWidth variant="contained" size="large"
                        disabled={busy || otpCode.length !== 6}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
                <Button fullWidth variant="text" size="small" sx={{ mt: 1.5 }}
                        disabled={busy || resendIn > 0}
                        onClick={() => void sendOtp()}>
                  {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                </Button>
              </>
            )}
          </Box>
          )}

          {tab === 'email' && (
          <Box component="form" onSubmit={submit} noValidate>
            <TextField
              fullWidth
              label="Email address"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              sx={{ mb: 2.5 }}
            />

            <TextField
              fullWidth
              label="Password"
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      {/* A reveal toggle reduces failed attempts on long
                          passwords, and this account locks after five. */}
                      <IconButton
                        onClick={() => setReveal((v) => !v)}
                        edge="end"
                        size="small"
                        aria-label={reveal ? 'Hide password' : 'Show password'}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
                          <circle cx="12" cy="12" r="3" />
                          {!reveal && <path d="M4 20L20 4" />}
                        </svg>
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />

            <FormControlLabel
              sx={{ mt: 1 }}
              control={<Checkbox size="small" checked={remember}
                                onChange={(e) => setRemember(e.target.checked)} />}
              label={<Typography variant="body2">Remember my email on this device</Typography>}
            />

            <Button
              type="submit"
              fullWidth
              variant="contained"
              size="large"
              disabled={busy || !email || !password}
              sx={{ mt: 2.5 }}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </Box>
          )}

          {/* Outside the tabs: applies to whichever way you sign in. */}
          <TextField
            select fullWidth size="small" label="Start in" value={startIn}
            onChange={(e) => setStartIn(e.target.value as 'default' | 'mail')}
            sx={{ mt: 3 }}
            helperText="Where you land after signing in"
          >
            <MenuItem value="default">Dashboard</MenuItem>
            <MenuItem value="mail">Mail inbox</MenuItem>
          </TextField>

          <Typography variant="caption" color="text.disabled"
                      sx={{ display: 'block', mt: 4, lineHeight: 1.7 }}>
            Forgotten your password? Your organisation&apos;s administrator can reset
            it. Techvein staff cannot read your mail — administrative access never
            implies access to contents.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

/** Super admins run the platform; everyone else lands in their own product. */
function destinationFor(role: string): string {
  if (role === 'super_admin') return '/admin';
  if (role === 'org_owner' || role === 'org_admin') return '/org/users';
  return '/mail/f-inbox';
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

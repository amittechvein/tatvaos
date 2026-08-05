'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

const STEPS = ['Organisation', 'You', 'Verify'];

const ORG_TYPES = [
  { value: 'business', label: 'Business' },
  { value: 'school', label: 'School or institute' },
  { value: 'hospital', label: 'Hospital or clinic' },
  { value: 'nonprofit', label: 'Non-profit' },
  { value: 'government', label: 'Government' },
  { value: 'other', label: 'Other' },
];

// ============================================================================
//  Signup: organisation → you → prove email and phone → account.
//
//  The domain is deliberately NOT here. It is added from inside the console,
//  because the person signing up is often not the person who can edit DNS —
//  and losing them over a step they cannot complete was the problem with the
//  previous flow. Ownership still gates what it always gated: outbound mail.
// ============================================================================

function Wizard() {
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState(0);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [orgName, setOrgName] = useState('');
  const [orgType, setOrgType] = useState('business');
  const [country, setCountry] = useState('India');
  const [gstin, setGstin] = useState('');

  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPhone, setAdminPhone] = useState('');
  const [password, setPassword] = useState('');

  const [emailCode, setEmailCode] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [emailOk, setEmailOk] = useState(false);
  const [phoneOk, setPhoneOk] = useState(false);
  const [phoneMasked, setPhoneMasked] = useState('');
  const [devCodes, setDevCodes] = useState<{ email?: string; phone?: string }>({});
  const [codeErrors, setCodeErrors] = useState<string[]>([]);

  const [done, setDone] = useState<{ email: string } | null>(null);

  // Resume from the emailed link — a signup abandoned on Friday must be
  // resumable on Monday, or saving the draft was pointless.
  const resume = params.get('draft');
  const loadDraft = useCallback(async (id: string) => {
    const res = await fetch(`${API}/signup/${id}`);
    if (!res.ok) return;
    const d = await res.json();
    if (d.completed) return;
    setDraftId(d.draftId);
    setOrgName(d.orgName ?? '');
    setOrgType(d.orgType ?? 'business');
    setCountry(d.country ?? 'India');
    setGstin(d.gstin ?? '');
    setAdminName(d.adminName ?? '');
    setAdminEmail(d.adminEmail ?? '');
    setPhoneMasked(d.phoneMasked ?? '');
    setEmailOk(!!d.emailVerified);
    setPhoneOk(!!d.phoneVerified);
    setStep(2);
  }, []);
  useEffect(() => { if (resume) void loadDraft(resume); }, [resume, loadDraft]);

  async function start() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgName, orgType, country, gstin, adminName, adminEmail, adminPhone }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not continue.');
      setDraftId(body.draftId);
      setPhoneMasked(body.sentTo?.phone ?? '');
      setDevCodes({ email: body.devEmailCode, phone: body.devPhoneCode });
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not continue.');
    } finally { setBusy(false); }
  }

  async function verifyCodes() {
    if (!draftId) return;
    setBusy(true); setError(null); setCodeErrors([]);
    try {
      const res = await fetch(`${API}/signup/${draftId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailCode: emailOk ? null : emailCode.trim(),
          phoneCode: phoneOk ? null : phoneCode.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not check the codes.');
      setEmailOk(body.emailVerified);
      setPhoneOk(body.phoneVerified);
      setCodeErrors(body.errors ?? []);

      if (body.emailVerified && body.phoneVerified) {
        const fin = await fetch(`${API}/signup/${draftId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const finBody = await fin.json();
        if (!fin.ok) throw new Error(finBody.error ?? 'Could not create the account.');
        setDone({ email: finBody.email });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the codes.');
    } finally { setBusy(false); }
  }

  async function resend() {
    if (!draftId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/signup/${draftId}/resend`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not resend.');
      setDevCodes({ email: body.devEmailCode, phone: body.devPhoneCode });
      setCodeErrors([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resend.');
    } finally { setBusy(false); }
  }

  // ---------------------------------------------------------------- done
  if (done) {
    return (
      <Split>
        <Box sx={{ width: '100%', maxWidth: 460, textAlign: 'center' }}>
          <Box sx={{ width: 64, height: 64, borderRadius: '50%', mx: 'auto', mb: 3,
                     display: 'grid', placeItems: 'center', color: 'success.main',
                     bgcolor: (t) => alpha(t.palette.success.main, 0.12) }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </Box>
          <Typography variant="h4" sx={{ mb: 1 }}>Account created</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
            Sign in and add your organisation&apos;s domain under <strong>Domains</strong> —
            you will get clear instructions and a choice of ways to verify it.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
            Until then your email keeps arriving exactly where it does today.
          </Typography>
          <Button variant="contained" size="large" fullWidth onClick={() => router.push('/login')}>
            Sign in as {done.email}
          </Button>
        </Box>
      </Split>
    );
  }

  // ---------------------------------------------------------------- wizard
  return (
    <Split>
      <Box sx={{ width: '100%', maxWidth: 560 }}>
        <Stepper activeStep={step} sx={{ mb: 5 }} alternativeLabel>
          {STEPS.map((s) => <Step key={s}><StepLabel>{s}</StepLabel></Step>)}
        </Stepper>

        {error && <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>{error}</Alert>}

        {step === 0 && (
          <Pane title="Your organisation"
                hint="This is what your people will see, and what appears on invoices.">
            <TextField fullWidth label="Organisation name" required value={orgName}
                       onChange={(e) => setOrgName(e.target.value)}
                       placeholder="ABC School" sx={{ mb: 2.5 }} />
            <TextField fullWidth select label="Type" value={orgType} sx={{ mb: 2.5 }}
                       onChange={(e) => setOrgType(e.target.value)}
                       helperText="Sets up sensible starting categories — teachers and students for a school, doctors and nursing for a clinic.">
              {ORG_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
            </TextField>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <TextField label="Country" value={country} sx={{ flex: 1, minWidth: 160 }}
                         onChange={(e) => setCountry(e.target.value)} />
              {country === 'India' && (
                <TextField label="GSTIN" value={gstin} sx={{ flex: 1, minWidth: 200 }}
                           onChange={(e) => setGstin(e.target.value.toUpperCase())}
                           helperText="Optional — needed for a GST invoice" />
              )}
            </Box>
            <Nav onNext={() => setStep(1)} nextDisabled={orgName.trim().length < 2} />
          </Pane>
        )}

        {step === 1 && (
          <Pane title="About you"
                hint="You will be the owner of this organisation, and can add others afterwards.">
            <TextField fullWidth label="Your name" required value={adminName}
                       onChange={(e) => setAdminName(e.target.value)} sx={{ mb: 2.5 }} />
            <TextField fullWidth label="Email address" type="email" required value={adminEmail}
                       onChange={(e) => setAdminEmail(e.target.value)} sx={{ mb: 2.5 }}
                       helperText="A code is sent here now, and invoices later. Use an address you can read today." />
            <TextField fullWidth label="Mobile number" required value={adminPhone}
                       onChange={(e) => setAdminPhone(e.target.value)}
                       placeholder="+91 98765 43210" sx={{ mb: 2.5 }}
                       helperText="A code is sent here too. Include the country code." />
            <TextField fullWidth type="password" label="Choose a password" required
                       value={password} onChange={(e) => setPassword(e.target.value)}
                       helperText="At least 12 characters. A short phrase you will remember beats a short password you will not." />
            <Nav onBack={() => setStep(0)} onNext={start} busy={busy}
                 nextLabel="Send codes"
                 nextDisabled={adminName.trim().length < 2
                   || !/\S+@\S+\.\S+/.test(adminEmail)
                   || adminPhone.replace(/\D/g, '').length < 8
                   || password.length < 12} />
          </Pane>
        )}

        {step === 2 && (
          <Pane title="Two codes"
                hint={`One emailed to ${adminEmail || 'your address'}, one sent by SMS to ${phoneMasked || 'your mobile'}.`}>
            {(devCodes.email || devCodes.phone) && (
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle sx={{ fontSize: 14 }}>Test environment</AlertTitle>
                Codes are shown here because this is staging — in production they
                arrive only by email and SMS.
                {devCodes.email && <Box component="span" sx={{ display: 'block', fontFamily: 'monospace', mt: 1 }}>Email: {devCodes.email}</Box>}
                {devCodes.phone && <Box component="span" sx={{ display: 'block', fontFamily: 'monospace' }}>SMS: {devCodes.phone}</Box>}
              </Alert>
            )}

            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1 }}>
              <TextField label="Email code" value={emailCode} disabled={emailOk}
                         onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                         sx={{ flex: 1, minWidth: 180 }}
                         slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }}
                         helperText={emailOk ? 'Verified' : ' '}
                         color={emailOk ? 'success' : undefined} focused={emailOk || undefined} />
              <TextField label="SMS code" value={phoneCode} disabled={phoneOk}
                         onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ''))}
                         sx={{ flex: 1, minWidth: 180 }}
                         slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }}
                         helperText={phoneOk ? 'Verified' : ' '}
                         color={phoneOk ? 'success' : undefined} focused={phoneOk || undefined} />
            </Box>

            {codeErrors.map((e) => (
              <Alert key={e} severity="warning" sx={{ mb: 1 }}>{e}</Alert>
            ))}

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Nothing arrived?{' '}
              <Link component="button" type="button" onClick={resend} disabled={busy}>
                Send fresh codes
              </Link>
              {' '}— they expire after 10 minutes.
            </Typography>

            <Nav onBack={() => setStep(1)} onNext={verifyCodes} busy={busy}
                 nextLabel="Verify and create account"
                 nextDisabled={(!emailOk && emailCode.length !== 6) || (!phoneOk && phoneCode.length !== 6)} />
          </Pane>
        )}

        <Typography variant="caption" color="text.disabled"
                    sx={{ display: 'block', mt: 4, textAlign: 'center' }}>
          Already have an account?{' '}
          <Box component="a" href="/login" sx={{ color: 'primary.main', textDecoration: 'none' }}>
            Sign in
          </Box>
        </Typography>
      </Box>
    </Split>
  );
}

// ---------------------------------------------------------------------------
function Pane({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 0.75 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>{hint}</Typography>
      {children}
    </Box>
  );
}

function Nav({ onBack, onNext, busy, nextDisabled, nextLabel = 'Continue' }: {
  onBack?: () => void; onNext: () => void; busy?: boolean;
  nextDisabled?: boolean; nextLabel?: string;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1.5, mt: 4 }}>
      {onBack && <Button onClick={onBack} disabled={busy}>Back</Button>}
      <Button variant="contained" size="large" onClick={onNext}
              disabled={busy || nextDisabled} sx={{ ml: 'auto', minWidth: 200 }}>
        {busy ? <CircularProgress size={20} color="inherit" /> : nextLabel}
      </Button>
    </Box>
  );
}

/** Branded panel, same language as sign-in so the two feel like one product. */
function Split({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.paper' }}>
      <Box sx={{ display: { xs: 'none', lg: 'flex' }, flexDirection: 'column',
                 width: '42%', px: { lg: 5, xl: 7 }, py: { lg: 5, xl: 7 },
                 position: 'relative', overflow: 'hidden', color: '#fff',
                 background: (t) => `linear-gradient(135deg, ${t.palette.primary.dark} 0%, ${t.palette.primary.main} 55%, ${t.palette.primary.light} 100%)` }}>
        <Box aria-hidden sx={{ position: 'absolute', width: 420, height: 420, borderRadius: '50%',
          top: -150, right: -130, bgcolor: alpha('#fff', 0.07) }} />
        <Box aria-hidden sx={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%',
          bottom: -100, left: -70, bgcolor: alpha('#fff', 0.05) }} />

        <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.75 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2.5, display: 'grid',
                       placeItems: 'center', fontWeight: 700, fontSize: 20,
                       bgcolor: alpha('#fff', 0.18),
                       border: `1px solid ${alpha('#fff', 0.25)}` }}>T</Box>
            <Typography sx={{ fontWeight: 700, fontSize: 22 }}>
              TatvaOS <Box component="span" sx={{ opacity: 0.7, fontWeight: 400 }}>Core</Box>
            </Typography>
          </Box>

          <Typography sx={{ mt: { lg: 5, xl: 7 }, fontSize: { lg: 28, xl: 32 }, fontWeight: 600,
                            lineHeight: 1.25, letterSpacing: '-0.02em' }}>
            Two minutes to an account.<br />Your mail stays put.
          </Typography>

          <Typography sx={{ mt: 2, fontSize: 15, opacity: 0.82, lineHeight: 1.65, maxWidth: 380 }}>
            Prove your email and mobile are real and you are in. Your domain is
            added later, from your console — with your existing email untouched
            until you decide to move it.
          </Typography>

          <Box sx={{ mt: 'auto', pt: 5, display: 'grid', gap: 2 }}>
            {[
              ['One identity', 'One sign-in across Mail, Drive and Payroll as they arrive.'],
              ['Isolated by the database', 'Row-level security, not code that remembers to filter.'],
              ['Hosted in India', 'DPDP residency, with a full audit trail.'],
            ].map(([t, d]) => (
              <Box key={t} sx={{ display: 'flex', gap: 1.5 }}>
                <Box sx={{ mt: '3px', opacity: 0.8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </Box>
                <Box>
                  <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t}</Typography>
                  <Typography sx={{ fontSize: 13, opacity: 0.75, lineHeight: 1.55 }}>{d}</Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: { xs: 3, sm: 6 } }}>
        {children}
      </Box>
    </Box>
  );
}

export default function SignupPage() {
  return <Suspense fallback={null}><Wizard /></Suspense>;
}

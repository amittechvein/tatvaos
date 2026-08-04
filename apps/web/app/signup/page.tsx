'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

const STEPS = ['Organisation', 'You', 'Domain', 'Verify'];

const ORG_TYPES = [
  { value: 'business', label: 'Business' },
  { value: 'school', label: 'School or institute' },
  { value: 'hospital', label: 'Hospital or clinic' },
  { value: 'nonprofit', label: 'Non-profit' },
  { value: 'government', label: 'Government' },
  { value: 'other', label: 'Other' },
];

interface MethodOption {
  method: string; label: string; where: string; what: string;
  note: string; recommended: boolean;
}

// ============================================================================
//  Signup
// ============================================================================
//
//  Four steps, and the fourth can fail without losing anything — that is the
//  point of the design, so the screen has to say so loudly rather than
//  presenting a dead end.
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

  const [fqdn, setFqdn] = useState('');
  const [options, setOptions] = useState<MethodOption[]>([]);
  const [method, setMethod] = useState('txt');

  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<{ signInAt: string; email: string } | null>(null);

  // Resume from a link. A signup abandoned on Friday has to be resumable on
  // Monday, or the draft it saved was pointless.
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
    setAdminPhone(d.adminPhone ?? '');
    setFqdn(d.fqdn ?? '');
    if (d.verificationMethod) setMethod(d.verificationMethod);
    if (d.lastError) setFailure(d.lastError);
    setStep(Math.max(0, (d.step ?? 1) - 1));
  }, []);

  useEffect(() => { if (resume) void loadDraft(resume); }, [resume, loadDraft]);

  async function saveIdentity() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgName, orgType, country, gstin,
          adminName, adminEmail, adminPhone,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not continue.');
      setDraftId(body.draftId);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not continue.');
    } finally { setBusy(false); }
  }

  async function saveDomain() {
    if (!draftId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/signup/${draftId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fqdn: fqdn.trim().toLowerCase(), method }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save that domain.');

      const m = await fetch(`${API}/signup/${draftId}/methods`);
      if (m.ok) setOptions((await m.json()).options ?? []);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that domain.');
    } finally { setBusy(false); }
  }

  async function verify() {
    if (!draftId) return;
    setBusy(true); setError(null); setFailure(null);
    try {
      const res = await fetch(`${API}/signup/${draftId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not check.');

      if (body.verified) setDone({ signInAt: body.signInAt, email: body.email });
      else setFailure(body.detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check.');
    } finally { setBusy(false); }
  }

  const chosen = options.find((o) => o.method.toLowerCase() === method);

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
          <Typography variant="h4" sx={{ mb: 1 }}>You&apos;re in</Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
            {fqdn} is verified and your organisation is ready.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
            Your email still goes wherever it does today. Moving it across is a
            separate step, inside your console, whenever you are ready.
          </Typography>
          <Button variant="contained" size="large" fullWidth
                  onClick={() => router.push('/login')}>
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

        {/* -------------------------------------------------------- 1 */}
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

        {/* -------------------------------------------------------- 2 */}
        {step === 1 && (
          <Pane title="About you"
                hint="You will be the owner of this organisation, and can add others afterwards.">
            <TextField fullWidth label="Your name" required value={adminName}
                       onChange={(e) => setAdminName(e.target.value)} sx={{ mb: 2.5 }} />
            <TextField fullWidth label="Email address" type="email" required value={adminEmail}
                       onChange={(e) => setAdminEmail(e.target.value)} sx={{ mb: 2.5 }}
                       helperText="Where invoices and password resets go. Use an address you can read today — not one on the domain you are about to add." />
            <TextField fullWidth label="Phone" value={adminPhone}
                       onChange={(e) => setAdminPhone(e.target.value)}
                       placeholder="+91 98765 43210"
                       helperText="So we can help if the next step gives you trouble." />
            <Nav onBack={() => setStep(0)} onNext={saveIdentity} busy={busy}
                 nextDisabled={adminName.trim().length < 2 || !/\S+@\S+\.\S+/.test(adminEmail)} />
          </Pane>
        )}

        {/* -------------------------------------------------------- 3 */}
        {step === 2 && (
          <Pane title="Your domain"
                hint="The domain your email addresses use, or will use.">
            <TextField fullWidth label="Domain" required value={fqdn}
                       onChange={(e) => setFqdn(e.target.value)}
                       placeholder="abcschool.edu.in"
                       slotProps={{ htmlInput: { autoCapitalize: 'none', spellCheck: false } }} />

            <Alert severity="info" sx={{ mt: 3 }}>
              <AlertTitle sx={{ fontSize: 14 }}>Your email will not change</AlertTitle>
              Next you prove you own this domain. That is all it does — your mail
              keeps arriving exactly where it does now. Moving it to TatvaOS is a
              separate step you choose later.
            </Alert>

            <Nav onBack={() => setStep(1)} onNext={saveDomain} busy={busy}
                 nextDisabled={!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(fqdn.trim())} />
          </Pane>
        )}

        {/* -------------------------------------------------------- 4 */}
        {step === 3 && (
          <Pane title={`Prove you own ${fqdn}`}
                hint="Pick whichever you can actually do. They all prove the same thing.">
            <Box sx={{ display: 'grid', gap: 1.5, mb: 3 }}>
              {options.map((o) => {
                const active = o.method.toLowerCase() === method;
                return (
                  <Card key={o.method}
                        onClick={() => setMethod(o.method.toLowerCase())}
                        sx={{ cursor: 'pointer', border: '1px solid',
                              borderColor: active ? 'primary.main' : 'transparent',
                              bgcolor: (t) => active ? alpha(t.palette.primary.main, 0.05) : undefined,
                              transition: '0.15s' }}>
                    <CardContent sx={{ py: 1.75 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{o.label}</Typography>
                        {o.recommended && <Chip label="recommended" size="small" color="primary" />}
                      </Box>
                      <Typography variant="caption" color="text.secondary"
                                  sx={{ display: 'block', mt: 0.25 }}>
                        {o.note}
                      </Typography>
                    </CardContent>
                  </Card>
                );
              })}
            </Box>

            {chosen && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                  {chosen.where}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Box sx={{ flex: 1, p: 1.5, borderRadius: 1.5, fontFamily: 'monospace',
                             fontSize: 12.5, wordBreak: 'break-all',
                             bgcolor: 'background.default' }}>
                    {chosen.what}
                  </Box>
                  <Tooltip title="Copy">
                    <IconButton size="small"
                                onClick={() => void navigator.clipboard.writeText(chosen.what)}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <rect x="9" y="9" width="12" height="12" rx="2" />
                        <path d="M5 15V5a2 2 0 012-2h10" />
                      </svg>
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
            )}

            <TextField fullWidth type="password" label="Choose a password" required
                       value={password} onChange={(e) => setPassword(e.target.value)}
                       helperText="At least 12 characters. A short phrase you will remember beats a short password you will not."
                       sx={{ mb: 1 }} />

            {/* The failure state is the important one. It has to read as
                "saved, come back" — not as a dead end. */}
            {failure && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                <AlertTitle sx={{ fontSize: 14 }}>Not found yet — nothing is lost</AlertTitle>
                {failure}
                <Typography variant="body2" sx={{ mt: 1.5 }}>
                  Your details are saved. DNS changes can take up to an hour, so
                  it is often just a matter of waiting. We have your number and
                  will help if it does not come through.
                </Typography>
              </Alert>
            )}

            <Nav onBack={() => setStep(2)} onNext={verify} busy={busy}
                 nextLabel={failure ? 'Check again' : 'Verify and create account'}
                 nextDisabled={password.length < 12} />
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
function Pane({ title, hint, children }: {
  title: string; hint: string; children: React.ReactNode;
}) {
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
              disabled={busy || nextDisabled} sx={{ ml: 'auto', minWidth: 180 }}>
        {busy ? <CircularProgress size={20} color="inherit" /> : nextLabel}
      </Button>
    </Box>
  );
}

/** The branded panel, same language as sign-in so the two feel like one product. */
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
            Set up in minutes.<br />Move your mail later.
          </Typography>

          <Typography sx={{ mt: 2, fontSize: 15, opacity: 0.82, lineHeight: 1.65, maxWidth: 380 }}>
            You will prove you own your domain — nothing more. Your existing email
            keeps working untouched until you decide to move it.
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

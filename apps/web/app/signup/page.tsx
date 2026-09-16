'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Kit';
import { Field, Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

// ============================================================================
//  Converted off MUI. Notes for the next editor.
//
//  Columns are Bootstrap row/col or flex, never Tailwind's grid — YZEN ships
//  its own 12-column `.grid` that collides with Tailwind's, and arbitrary
//  values like grid-cols-[1fr_1fr] silently flatten to a single column.
//
//  Tailwind's preflight is off (YZEN's reboot owns the reset), so every input
//  and list carries an explicit class rather than relying on a normalised
//  default.
//
//  useSearchParams() is why the page is wrapped in <Suspense> at the bottom —
//  without it the production build fails, and it passes in dev, so the failure
//  only appears at build time.
// ============================================================================

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

/** The brand ramp, fixed here now that MUI's palette has gone. */
const BRAND_DARK = '#4A29A8';
const BRAND = '#6C3CE9';
const BRAND_LIGHT = '#8F6BEC';

/**
 * A 500 from ASP.NET has an empty body, and res.json() on an empty body
 * throws "Unexpected end of JSON input" — which then replaces the real error
 * with a JavaScript one. Parse defensively, always.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<Record<string, any>> {
  try { return await res.json(); } catch { return {}; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errOf(body: Record<string, any>, fallback: string): string {
  return typeof body.error === 'string' ? body.error : fallback;
}

const STEPS = ['Organisation', 'You', 'Verify'];

const ORG_TYPES = [
  { value: 'business', label: 'Business' },
  { value: 'school', label: 'School or institute' },
  { value: 'hospital', label: 'Hospital or clinic' },
  { value: 'nonprofit', label: 'Non-profit' },
  { value: 'government', label: 'Government' },
  { value: 'other', label: 'Other' },
];

/** Replaces MUI's CircularProgress. */
function Spinner({ size = 20, light }: { size?: number; light?: boolean }) {
  return (
    <span
      className="inline-block animate-spin rounded-full align-middle"
      style={{
        width: size, height: size,
        border: `2px solid ${light ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.12)'}`,
        borderTopColor: light ? '#fff' : BRAND,
      }}
      role="status"
      aria-label="Working"
    />
  );
}

/*  The local Field was deleted on 7 Sept 2026 — components/ui/Form.tsx now
 *  owns it, and a second copy is how two forms end up disagreeing about where
 *  the hint sits. The shared one accepts these same plain children.
 */

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
  // Set when arriving via a resume link: the original tab's state — including
  // the chosen password — is gone, so the verify step must collect it again.
  const [resumed, setResumed] = useState(false);

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
    setResumed(true);
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
      const body = await readJson(res);
      if (!res.ok) throw new Error(errOf(body, 'Could not continue.'));
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
      const body = await readJson(res);
      if (!res.ok) throw new Error(errOf(body, 'Could not check the codes.'));
      setEmailOk(body.emailVerified);
      setPhoneOk(body.phoneVerified);
      setCodeErrors(body.errors ?? []);

      if (body.emailVerified && body.phoneVerified) {
        const fin = await fetch(`${API}/signup/${draftId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const finBody = await readJson(fin);
        if (!fin.ok) throw new Error(errOf(finBody, 'Could not create the account.'));
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
      const body = await readJson(res);
      if (!res.ok) throw new Error(errOf(body, 'Could not resend.'));
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
        <div className="w-full text-center" style={{ maxWidth: 460 }}>
          <div
            className="grid rounded-full mx-auto mb-6"
            style={{
              width: 64, height: 64, placeItems: 'center',
              color: BRAND_DARK, background: 'rgba(3,181,98,0.12)',
            }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h1 className="mb-2" style={{ fontSize: 30, fontWeight: 600 }}>Account created</h1>
          <p className="text-ink-muted mb-2">
            Sign in and add your organisation&apos;s domain under <strong>Domains</strong> —
            you will get clear instructions and a choice of ways to verify it.
          </p>
          <p className="text-[0.875rem] text-ink-muted mb-6">
            Until then your email keeps arriving exactly where it does today.
          </p>
          <Button variant="primary" className="w-full py-2.5"
                  onClick={() => router.push('/login')}>
            Sign in as {done.email}
          </Button>
        </div>
      </Split>
    );
  }

  // ---------------------------------------------------------------- wizard
  return (
    <Split>
      <div className="w-full" style={{ maxWidth: 560 }}>
        {/* Stepper. Three fixed steps, so a flex row of numbered dots says the
            same thing MUI's Stepper did with none of the weight. */}
        <ol className="list-none pl-0 flex items-start justify-between mb-12">
          {STEPS.map((s, i) => {
            const state = i < step ? 'done' : i === step ? 'current' : 'todo';
            return (
              <li key={s} className="text-center flex-auto">
                <span
                  className="grid rounded-full mx-auto mb-1"
                  style={{
                    width: 30, height: 30, placeItems: 'center',
                    fontSize: 13, fontWeight: 600,
                    background: state === 'todo' ? '#e9ecef' : BRAND,
                    color: state === 'todo' ? '#6c757d' : '#fff',
                  }}
                >
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className={`text-[0.75rem] ${state === 'current' ? 'font-semibold' : 'text-ink-muted'}`}>
                  {s}
                </span>
              </li>
            );
          })}
        </ol>

        {error && (
          <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>
        )}

        {step === 0 && (
          <Pane title="Your organisation"
                hint="This is what your people will see, and what appears on invoices.">
            <Field label="Organisation name" required>
              <Input value={orgName} placeholder="ABC School"
                     onChange={(e) => setOrgName(e.target.value)} />
            </Field>
            <Field
              label="Type"
              hint="Sets up sensible starting categories — teachers and students for a school, doctors and nursing for a clinic."
            >
              <Select value={orgType}
                      onChange={(e) => setOrgType(e.target.value)}>
                {ORG_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <div className="flex gap-4 flex-wrap">
              <div className="flex-auto" style={{ minWidth: 160 }}>
                <Field label="Country">
                  <Input value={country}
                         onChange={(e) => setCountry(e.target.value)} />
                </Field>
              </div>
              {country === 'India' && (
                <div className="flex-auto" style={{ minWidth: 200 }}>
                  <Field label="GSTIN" hint="Optional — needed for a GST invoice">
                    <Input value={gstin}
                           onChange={(e) => setGstin(e.target.value.toUpperCase())} />
                  </Field>
                </div>
              )}
            </div>
            <Nav onNext={() => setStep(1)} nextDisabled={orgName.trim().length < 2} />
          </Pane>
        )}

        {step === 1 && (
          <Pane title="About you"
                hint="You will be the owner of this organisation, and can add others afterwards.">
            <Field label="Your name" required>
              <Input value={adminName}
                     onChange={(e) => setAdminName(e.target.value)} />
            </Field>
            <Field label="Email address" required
                   hint="A code is sent here now, and invoices later. Use an address you can read today.">
              <Input type="email" value={adminEmail}
                     onChange={(e) => setAdminEmail(e.target.value)} />
            </Field>
            <Field label="Mobile number" required
                   hint="A code is sent here too. Include the country code.">
              <Input value={adminPhone} placeholder="+91 98765 43210"
                     onChange={(e) => setAdminPhone(e.target.value)} />
            </Field>
            <Field label="Choose a password" required
                   hint="At least 12 characters. A short phrase you will remember beats a short password you will not.">
              <Input type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)} />
            </Field>
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
            {/* Wording no longer says "staging" — that environment was removed.
                Codes appear here only when the show-OTP-on-screen setting is on
                AND the real send failed. */}
            {(devCodes.email || devCodes.phone) && (
              <Alert tone="info" title="Codes shown on screen">
                On-screen codes are switched on for this platform, and the real
                send did not go out — in normal operation they arrive only by
                email and SMS.
                {devCodes.email && (
                  <span className="mt-2 block font-mono">Email: {devCodes.email}</span>
                )}
                {devCodes.phone && (
                  <span className="block font-mono">SMS: {devCodes.phone}</span>
                )}
              </Alert>
            )}

            <div className="flex gap-4 flex-wrap mb-1">
              <div className="flex-auto" style={{ minWidth: 180 }}>
                <Field label="Email code" hint={emailOk ? 'Verified' : undefined}>
                  <Input
                    value={emailCode} disabled={emailOk}
                    inputMode="numeric" maxLength={6}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
              </div>
              <div className="flex-auto" style={{ minWidth: 180 }}>
                <Field label="SMS code" hint={phoneOk ? 'Verified' : undefined}>
                  <Input
                    value={phoneCode} disabled={phoneOk}
                    inputMode="numeric" maxLength={6}
                    onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
              </div>
            </div>

            {/* A resumed session arrives here with no password in memory —
                state died with the old tab. Without this field, completing
                would fail asking for a password there is no box for. Keyed on
                `resumed`, not on the password being empty, or the field would
                unmount under the cursor at the first keystroke. */}
            {resumed && (
              <Field label="Choose a password" required
                     hint="At least 12 characters — you are back on a fresh session, so set it here.">
                <Input type="password" value={password}
                       onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}

            {codeErrors.map((e) => (
              <Alert key={e} tone="warn">{e}</Alert>
            ))}

            <p className="text-[0.75rem] text-ink-muted mt-2 mb-0">
              Nothing arrived?{' '}
              <Button variant="ghost" className="p-0 align-baseline text-sm"
                      onClick={resend} disabled={busy}>
                Send fresh codes
              </Button>
              {' '}— they expire after 10 minutes.
            </p>

            <Nav onBack={() => setStep(1)} onNext={verifyCodes} busy={busy}
                 nextLabel="Verify and create account"
                 nextDisabled={password.length < 12
                   || (!emailOk && emailCode.length !== 6)
                   || (!phoneOk && phoneCode.length !== 6)} />
          </Pane>
        )}

        <p className="text-[0.75rem] text-ink-muted text-center mt-12 mb-0">
          Already have an account?{' '}
          <a href="/login" className="no-underline" style={{ color: BRAND }}>Sign in</a>
        </p>
      </div>
    </Split>
  );
}

// ---------------------------------------------------------------------------
function Pane({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-1" style={{ fontSize: 28, fontWeight: 600 }}>{title}</h1>
      <p className="text-[0.875rem] text-ink-muted mb-6">{hint}</p>
      {children}
    </div>
  );
}

function Nav({ onBack, onNext, busy, nextDisabled, nextLabel = 'Continue' }: {
  onBack?: () => void; onNext: () => void; busy?: boolean;
  nextDisabled?: boolean; nextLabel?: string;
}) {
  return (
    <div className="flex gap-2 mt-6">
      {onBack && (
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
      )}
      <Button
        variant="primary"
        className="ms-auto py-2.5"
        style={{ minWidth: 200 }}
        onClick={onNext}
        disabled={busy || nextDisabled}
      >
        {busy ? <Spinner light /> : nextLabel}
      </Button>
    </div>
  );
}

/** Branded panel, same language as sign-in so the two feel like one product. */
function Split({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex bg-white" style={{ minHeight: '100vh' }}>
      <div
        className="hidden min-[992px]:flex flex-col relative text-white p-12"
        style={{
          width: '42%', overflow: 'hidden',
          background: `linear-gradient(135deg, ${BRAND_DARK} 0%, ${BRAND} 55%, ${BRAND_LIGHT} 100%)`,
        }}
      >
        <div aria-hidden className="absolute rounded-full"
             style={{ width: 420, height: 420, top: -150, right: -130, background: 'rgba(255,255,255,0.07)' }} />
        <div aria-hidden className="absolute rounded-full"
             style={{ width: 300, height: 300, bottom: -100, left: -70, background: 'rgba(255,255,255,0.05)' }} />

        <div className="relative flex flex-col h-full">
          <div className="flex items-center gap-4">
            <span
              className="grid"
              style={{
                width: 44, height: 44, borderRadius: 12, placeItems: 'center',
                fontWeight: 700, fontSize: 20,
                background: 'rgba(255,255,255,0.18)',
                border: '1px solid rgba(255,255,255,0.25)',
              }}
            >
              T
            </span>
            <span style={{ fontWeight: 700, fontSize: 22 }}>
              TatvaOS <span style={{ opacity: 0.7, fontWeight: 400 }}>Core</span>
            </span>
          </div>

          <p className="mb-0" style={{ marginTop: 48, fontSize: 28, fontWeight: 600,
                                       lineHeight: 1.25, letterSpacing: '-0.02em' }}>
            Two minutes to an account.<br />Your mail stays put.
          </p>

          <p className="mt-4 mb-0" style={{ fontSize: 15, opacity: 0.82, lineHeight: 1.65, maxWidth: 380 }}>
            Prove your email and mobile are real and you are in. Your domain is
            added later, from your console — with your existing email untouched
            until you decide to move it.
          </p>

          <div className="mt-auto flex flex-col gap-4" style={{ paddingTop: 40 }}>
            {[
              ['One identity', 'One sign-in across Mail, Drive and Payroll as they arrive.'],
              ['Isolated by the database', 'Row-level security, not code that remembers to filter.'],
              ['Hosted in India', 'DPDP residency, with a full audit trail.'],
            ].map(([t, d]) => (
              <div key={t} className="flex gap-2">
                <span style={{ marginTop: 3, opacity: 0.8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                <span>
                  <span className="block" style={{ fontWeight: 600, fontSize: 14 }}>{t}</span>
                  <span className="block" style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.55 }}>{d}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-auto grid p-6 min-[576px]:p-12" style={{ placeItems: 'center' }}>
        {children}
      </div>
    </div>
  );
}

export default function SignupPage() {
  return <Suspense fallback={null}><Wizard /></Suspense>;
}

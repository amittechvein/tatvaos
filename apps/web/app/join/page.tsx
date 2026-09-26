'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Spinner } from '@/components/ui/Kit';
import { Checkbox, Field, Input, InputSuffix } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { PasswordStrength } from '@/components/ui/PasswordStrength';

// ============================================================================
//  /join — a free personal address (build plan personal-plans-build-plan.md,
//  part B, §3). NOT /signup, which creates organisations and is unchanged.
//
//  Address → you → phone code → password and terms → done.
//
//  Everything is decided by the API (JoinEndpoints): the rules, the reserved
//  names, the age, the limits. This page only asks and shows the answer, so
//  a request that skips the page meets exactly the same refusals.
//
//  Closed until launch. /api/join/status says so and the page says so; the
//  website's buttons point here only at launch (§3).
// ============================================================================

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** An empty 500 body must not replace the real error with a JSON one. */
async function readJson(res: Response): Promise<Json> {
  try { return await res.json(); } catch { return {}; }
}
function errOf(body: Json, fallback: string): string {
  return typeof body.error === 'string' ? body.error : fallback;
}

type Status =
  | { state: 'loading' }
  | { state: 'closed' }
  | { state: 'open'; domain: string; formToken: string; minLength: number; maxLength: number; passwordMin: number };

const STEPS = ['Address', 'You', 'Phone', 'Password'];

export default function JoinPage() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal the person cannot fix by trying again (under 18).
  const [refused, setRefused] = useState<string | null>(null);

  // Step 1 — address
  const [name, setName] = useState('');
  const [check, setCheck] = useState<{ name: string; available: boolean; problem?: string; suggestions: string[] } | null>(null);

  // Step 2 — you
  const [displayName, setDisplayName] = useState('');
  const [dob, setDob] = useState('');
  const [adult, setAdult] = useState(false);
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');   // honeypot: people never see it

  // Step 3 — code
  const [signupId, setSignupId] = useState<string | null>(null);
  const [phoneMasked, setPhoneMasked] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);

  // Step 4 — password and terms
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState('');
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);

  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/join/status`);
        const b = await readJson(res);
        if (!res.ok || !b.open) { setStatus({ state: 'closed' }); return; }
        setStatus({
          state: 'open', domain: b.domain, formToken: b.formToken,
          minLength: b.minLength, maxLength: b.maxLength, passwordMin: b.passwordMinLength,
        });
      } catch {
        setStatus({ state: 'closed' });
      }
    })();
  }, []);

  const domain = status.state === 'open' ? status.domain : '';
  const local = name.trim().toLowerCase();

  // Availability, asked after a pause in typing — the check is rate-limited
  // on the server, and a request per keystroke would meet that limit.
  const seq = useRef(0);
  const checkAddress = useCallback(async (wanted: string) => {
    const mine = ++seq.current;
    const res = await fetch(`${API}/join/address?name=${encodeURIComponent(wanted)}`);
    const b = await readJson(res);
    if (mine !== seq.current) return;           // a later keystroke won
    if (!res.ok) {
      setCheck({ name: wanted, available: false,
        problem: res.status === 429 ? 'Slow down a little — try again in a minute.' : errOf(b, 'Could not check that address.'),
        suggestions: [] });
      return;
    }
    setCheck({ name: wanted, available: !!b.available, problem: b.problem ?? undefined, suggestions: b.suggestions ?? [] });
  }, []);
  useEffect(() => {
    if (status.state !== 'open' || !local) { setCheck(null); return; }
    const t = setTimeout(() => { void checkAddress(local); }, 450);
    return () => clearTimeout(t);
  }, [local, status.state, checkAddress]);

  const addressOk = !!check && check.name === local && check.available;

  // ---------------------------------------------------------------------------
  async function start() {
    if (status.state !== 'open') return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/join/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localPart: local, displayName, phone, dateOfBirth: dob, declaredAdult: adult,
          website, formToken: status.formToken,
        }),
      });
      const b = await readJson(res);
      if (!res.ok) {
        if (b.minor) { setRefused(errOf(b, '')); return; }
        if (b.field === 'address') { setStep(0); setCheck(null); void checkAddress(local); }
        throw new Error(errOf(b, 'Could not continue.'));
      }
      setSignupId(b.signupId);
      setPhoneMasked(b.phoneMasked ?? '');
      setDevCode(b.devCode ?? null);
      setCode('');
      setStep(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!signupId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/join/${signupId}/resend`, { method: 'POST' });
      const b = await readJson(res);
      if (!res.ok) throw new Error(errOf(b, 'Could not send a new code.'));
      setDevCode(b.devCode ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!signupId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/join/${signupId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const b = await readJson(res);
      if (!res.ok || !b.verified) {
        const left = typeof b.attemptsLeft === 'number' ? ` ${b.attemptsLeft} tries left.` : '';
        throw new Error(errOf(b, 'That code did not work.') + left);
      }
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!signupId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/join/${signupId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, recoveryEmail: recovery || null, acceptTerms: terms, acceptPrivacy: privacy }),
      });
      const b = await readJson(res);
      if (!res.ok) {
        if (b.field === 'address') { setStep(0); setCheck(null); void checkAddress(local); }
        if (b.field === 'phone') setStep(1);
        throw new Error(errOf(b, 'Could not create your account.'));
      }
      setDone(b.address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  if (status.state === 'loading') {
    return <Shell><div className="grid place-items-center py-16"><Spinner label="Loading" /></div></Shell>;
  }
  if (status.state === 'closed') {
    return (
      <Shell>
        <Pane title="Personal accounts aren't open yet"
              hint="Free personal addresses are coming soon. If your organisation uses TatvaOS, sign in with the account it gave you.">
          <Button variant="primary" href="/login">Sign in</Button>
        </Pane>
      </Shell>
    );
  }
  if (refused) {
    return <Shell><Pane title="We can't create this account" hint={refused}><Button href="/">Back to the home page</Button></Pane></Shell>;
  }
  if (done) {
    return (
      <Shell>
        <Pane title="You're in" hint="Your new address is ready, and a welcome email is waiting in its inbox.">
          <p className="mb-6 text-lg">Your address is <strong className="break-all">{done}</strong>.</p>
          <Button variant="primary" className="w-full min-[480px]:w-auto"
                  href={`/login?email=${encodeURIComponent(done)}&next=${encodeURIComponent('/mail')}`}>
            Open Mail
          </Button>
        </Pane>
      </Shell>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Shell>
      <Stepper step={step} />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {step === 0 && (
        <Pane title="Pick your address" hint="This is your new email address, and how you sign in.">
          <Field label="Address" required
                 hint={`${status.minLength} to ${status.maxLength} characters: lowercase letters, numbers, dots and hyphens, starting with a letter.`}
                 error={check && check.name === local && !check.available ? check.problem : undefined}>
            {({ id, invalid, describedBy }) => (
              <InputSuffix id={id} invalid={invalid} aria-describedby={describedBy} suffix={`@${domain}`}
                           value={name} autoComplete="off" autoCapitalize="none" spellCheck={false}
                           maxLength={status.maxLength} placeholder="yourname"
                           onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          {addressOk && (
            <p className="-mt-2 mb-4 text-sm font-medium text-ok">✓ {local}@{domain} is available</p>
          )}
          {check && check.name === local && !check.available && check.suggestions.length > 0 && (
            <div className="-mt-2 mb-4">
              <p className="mb-2 text-sm text-ink-muted">These are free:</p>
              <div className="flex flex-wrap gap-2">
                {check.suggestions.map((s) => (
                  <Button key={s} size="sm" onClick={() => setName(s)}>{s}@{domain}</Button>
                ))}
              </div>
            </div>
          )}
          <Nav onNext={() => setStep(1)} nextDisabled={!addressOk} />
        </Pane>
      )}

      {step === 1 && (
        <Pane title="About you" hint={`Setting up ${local}@${domain}.`}>
          <Field label="Full name" required hint="Shown on the mail you send.">
            {({ id, invalid, describedBy }) => (
              <Input id={id} invalid={invalid} describedBy={describedBy} value={displayName}
                     autoComplete="name" maxLength={100} onChange={(e) => setDisplayName(e.target.value)} />
            )}
          </Field>
          <Field label="Date of birth" required hint="Used only to check your age. We don't keep it.">
            {({ id, invalid, describedBy }) => (
              <Input id={id} invalid={invalid} describedBy={describedBy} type="date" max={today}
                     value={dob} autoComplete="bday" onChange={(e) => setDob(e.target.value)} />
            )}
          </Field>
          <Checkbox label="I am 18 or older" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          <Field label="Mobile number" required
                 hint="We'll text you a code. One personal account per number. Include the country code if it's outside India.">
            {({ id, invalid, describedBy }) => (
              <Input id={id} invalid={invalid} describedBy={describedBy} type="tel" inputMode="tel"
                     autoComplete="tel" placeholder="98765 43210" value={phone}
                     onChange={(e) => setPhone(e.target.value)} />
            )}
          </Field>
          {/* Honeypot. Off-screen rather than display:none, which some bots
              skip; hidden from screen readers and the tab order, so no person
              ever fills it. A filled one is refused by the API. */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
            <label htmlFor="join-website">Website</label>
            <input id="join-website" name="website" tabIndex={-1} autoComplete="off"
                   value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <Nav onBack={() => setStep(0)} onNext={start} busy={busy} nextLabel="Text me a code"
               nextDisabled={displayName.trim().length < 2 || !dob || !adult || phone.replace(/\D/g, '').length < 10} />
        </Pane>
      )}

      {step === 2 && (
        <Pane title="Enter the code" hint={`We texted a 6-digit code to ${phoneMasked || 'your mobile'}. It lasts 10 minutes.`}>
          {devCode && (
            <Alert tone="info" title="Code shown on screen">
              On-screen codes are switched on for this server and the text did not go out.
              <span className="mt-2 block font-mono">{devCode}</span>
            </Alert>
          )}
          <Field label="Code" required>
            {({ id, invalid, describedBy }) => (
              <Input id={id} invalid={invalid} describedBy={describedBy} value={code}
                     inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                     onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            )}
          </Field>
          <p className="mb-0 text-sm text-ink-muted">
            Nothing arrived?{' '}
            <button type="button" className="inline-flex min-h-[2.75rem] items-center font-medium text-brand-600 underline-offset-2 hover:underline disabled:opacity-50"
                    onClick={resend} disabled={busy}>
              Send a new code
            </button>
          </p>
          <Nav onBack={() => setStep(1)} onNext={verify} busy={busy} nextLabel="Verify" nextDisabled={code.length !== 6} />
        </Pane>
      )}

      {step === 3 && (
        <Pane title="Password and terms" hint={`Last step for ${local}@${domain}.`}>
          <Field label="Choose a password" required
                 hint={`At least ${status.passwordMin} characters. A short phrase you'll remember beats a short password you won't.`}>
            {({ id, invalid, describedBy }) => (
              <Input id={id} invalid={invalid} describedBy={describedBy} type="password"
                     autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
          <PasswordStrength value={password} />
          <Field label="Recovery email" className="mt-4"
                 hint="Optional, recommended: another address you can read, for when you're locked out. We'll send it a link to confirm.">
            {({ id, invalid, describedBy }) => (
              <Input id={id} invalid={invalid} describedBy={describedBy} type="email"
                     autoComplete="email" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
            )}
          </Field>
          <Checkbox checked={terms} onChange={(e) => setTerms(e.target.checked)}
                    label={<>I accept the <a href="/terms" target="_blank" rel="noreferrer" className="font-medium text-brand-600 underline">Terms of Service</a></>} />
          <Checkbox checked={privacy} onChange={(e) => setPrivacy(e.target.checked)}
                    label={<>I have read the <a href="/privacy" target="_blank" rel="noreferrer" className="font-medium text-brand-600 underline">Privacy policy</a></>} />
          <Nav onBack={() => setStep(2)} onNext={complete} busy={busy} nextLabel="Create my account"
               nextDisabled={password.length < status.passwordMin || !terms || !privacy} />
        </Pane>
      )}

      <p className="mb-0 mt-10 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <a href="/login" className="inline-flex min-h-[2.75rem] items-center font-medium text-brand-600">Sign in</a>
      </p>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10 min-[576px]:py-16">
      <div className="mx-auto w-full max-w-[480px]">
        <div className="mb-8 flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500 font-bold text-white">T</span>
          <span className="text-lg font-semibold text-ink">TatvaOS</span>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm min-[576px]:p-8">
          {children}
        </div>
      </div>
    </main>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-8 flex list-none gap-2 pl-0" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex-1" aria-current={i === step ? 'step' : undefined}>
          <span className={`block h-1 rounded-full ${i <= step ? 'bg-brand-500' : 'bg-line'}`} />
          <span className={`mt-1.5 block text-xs ${i === step ? 'font-semibold text-ink' : 'text-ink-muted'}`}>{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Pane({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-ink">{title}</h1>
      <p className="mb-6 text-sm text-ink-muted">{hint}</p>
      {children}
    </div>
  );
}

function Nav({ onBack, onNext, busy, nextDisabled, nextLabel = 'Continue' }: {
  onBack?: () => void; onNext: () => void; busy?: boolean; nextDisabled?: boolean; nextLabel?: string;
}) {
  return (
    <div className="mt-6 flex flex-col-reverse gap-2 min-[480px]:flex-row">
      {onBack && <Button onClick={onBack} disabled={busy}>Back</Button>}
      <Button variant="primary" className="min-[480px]:ml-auto min-[480px]:min-w-[180px]"
              onClick={onNext} disabled={busy || nextDisabled}>
        {busy ? <Spinner inline label="Working" /> : nextLabel}
      </Button>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Badge, Button, Card } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import { Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import {
  fetchRecoveryStatus, removePhone, removeRecoveryEmail, requestPhoneChange,
  setRecoveryEmail, verifyPhoneChange, type RecoveryStatus,
} from '@/lib/recovery';

// ---------------------------------------------------------------------------
//  Recovery — the account page's view of "how do I get back in"
// ---------------------------------------------------------------------------
//
//  Two rows, each a small state machine:
//
//    email   view → edit → (link sent) → view. Verification happens when the
//            link is clicked, in another tab; the badge catches up on reload.
//    number  view → edit → code → view. The old number stays until the new
//            one has answered a code, so a typo cannot lock anyone out.
//
//  Removing either asks twice, inline. No browser confirm(): it is modal,
//  unstyled, and nothing else on this page uses it.
//
//  Tailwind and components/ui throughout, like the rest of the account page.
//  No colour literals — badges and text-* carry the theme.
// ---------------------------------------------------------------------------

type EmailMode = 'view' | 'edit';
type PhoneMode = 'view' | 'edit' | 'code';
type Removing = 'email' | 'phone' | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Row({ label, children, last = false }: {
  label: string; children: ReactNode; last?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-2 py-3 md:flex-row${last ? '' : ' border-b border-line'}`}>
      <div className="shrink-0 font-medium" style={{ width: 170 }}>{label}</div>
      <div className="min-w-0 grow">{children}</div>
    </div>
  );
}

export function RecoveryCard() {
  const { authedFetch } = useAuth();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailMode>('view');
  const [email, setEmail] = useState('');
  const [phoneMode, setPhoneMode] = useState<PhoneMode>('view');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const s = await fetchRecoveryStatus(authedFetch);
      setStatus(s);
      // A code is already on its way to a new number (from another tab, say):
      // open on the code step rather than making them ask for it again.
      if (firstLoad.current && s.pendingPhone) setPhoneMode('code');
      firstLoad.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your recovery settings.');
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  // ---- email ------------------------------------------------------------
  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) { setError('Enter a valid email address.'); return; }
    void run(async () => {
      const r = await setRecoveryEmail(authedFetch, value);
      setNotice(r.message);
      setEmailMode('view');
      setEmail('');
      await load();
    });
  };
  const resendEmail = () => {
    const current = status?.recoveryEmail;
    if (!current) return;
    void run(async () => {
      const r = await setRecoveryEmail(authedFetch, current);
      setNotice(r.message);
      await load();
    });
  };
  const doRemoveEmail = () => {
    void run(async () => {
      await removeRecoveryEmail(authedFetch);
      setRemoving(null);
      setNotice('Recovery email removed.');
      await load();
    });
  };

  // ---- number -----------------------------------------------------------
  const cancelPhone = () => {
    setPhoneMode('view');
    setPhone('');
    setCode('');
    setDevCode(null);
    setError(null);
  };
  const submitPhone = (e: FormEvent) => {
    e.preventDefault();
    const value = phone.trim();
    if (value.replace(/\D/g, '').length < 8) {
      setError('Enter the mobile number with its country code, like +91 98765 43210.');
      return;
    }
    void run(async () => {
      const r = await requestPhoneChange(authedFetch, value);
      setNotice(r.message);
      setDevCode(r.devCode);
      setCode('');
      setPhoneMode('code');
      await load();
    });
  };
  const resendCode = () => {
    const target = phone.trim() || status?.pendingPhone;
    if (!target) { setPhoneMode('edit'); return; }
    void run(async () => {
      const r = await requestPhoneChange(authedFetch, target);
      setNotice(r.message);
      setDevCode(r.devCode);
    });
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) { setError('Enter the 6-digit code.'); return; }
    void run(async () => {
      const r = await verifyPhoneChange(authedFetch, value);
      setNotice(`Your recovery number is now ${r.phone}.`);
      setPhoneMode('view');
      setPhone('');
      setCode('');
      setDevCode(null);
      await load();
    });
  };
  const doRemovePhone = () => {
    void run(async () => {
      await removePhone(authedFetch);
      setRemoving(null);
      setPhoneMode('view');
      setNotice('Recovery number removed.');
      await load();
    });
  };

  const title = 'Recovery';
  const subtitle = 'How you get back in if you forget your password';

  if (!status) {
    return (
      <Card title={title} subtitle={subtitle}>
        {error
          ? <Alert tone="danger" className="mb-0">{error}</Alert>
          : <p className="mb-0 text-sm text-ink-muted">Loading&hellip;</p>}
      </Card>
    );
  }

  const emailVerified = status.recoveryEmailVerified;
  const waysIn = [status.recoveryEmail && emailVerified, status.phone].filter(Boolean).length;

  return (
    <Card title={title} subtitle={subtitle}>
      <p className="mb-2 text-sm text-ink-muted">
        A reset link goes to your recovery email, or a code to your recovery number.
        Keep at least one of them current.
      </p>
      {error && <Alert tone="danger" className="py-2">{error}</Alert>}
      {notice && !error && <Alert tone="info" className="py-2">{notice}</Alert>}

      <Row label="Recovery email">
        {emailMode === 'edit' ? (
          <form onSubmit={submitEmail} className="flex flex-col gap-2 sm:flex-row">
            <Input  type="email" autoComplete="email"
                   placeholder="you@example.com" value={email}
                   onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            <div className="flex gap-2">
              <Button variant="primary" type="submit" disabled={busy}>Send link</Button>
              <Button variant="ghost" type="button" disabled={busy}
                      onClick={() => { setEmailMode('view'); setEmail(''); setError(null); }}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="mb-2">
              {status.recoveryEmail ? (
                <>
                  <span>{status.recoveryEmail}</span>
                  <span className="ml-2">
                    {emailVerified
                      ? <Badge tone="ok">Verified</Badge>
                      : <Badge tone="warn">Not verified</Badge>}
                  </span>
                </>
              ) : <span className="text-ink-muted">Not set</span>}
            </div>
            {status.recoveryEmail && !emailVerified && (
              <p className="mb-2 text-sm text-ink-muted">
                We sent a link to this address
                {status.recoveryEmailSentAt ? ` on ${new Date(status.recoveryEmailSentAt).toLocaleString()}` : ''}.
                Open it to finish &mdash; check the spam folder if it is not in the inbox.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" type="button" disabled={busy}
                      onClick={() => { setEmailMode('edit'); setEmail(status.recoveryEmail ?? ''); setRemoving(null); }}>
                {status.recoveryEmail ? 'Change' : 'Add'}
              </Button>
              {status.recoveryEmail && !emailVerified && (
                <Button variant="ghost" type="button" disabled={busy} onClick={resendEmail}>Resend link</Button>
              )}
              {status.recoveryEmail && (removing === 'email' ? (
                <>
                  <Button variant="ghost" type="button" className="text-danger" disabled={busy} onClick={doRemoveEmail}>
                    Confirm remove
                  </Button>
                  <Button variant="ghost" type="button" disabled={busy} onClick={() => setRemoving(null)}>Keep</Button>
                </>
              ) : (
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setRemoving('email')}>Remove</Button>
              ))}
            </div>
          </>
        )}
      </Row>

      <Row label="Recovery number" last>
        {phoneMode === 'edit' && (
          <form onSubmit={submitPhone} className="flex flex-col gap-2 sm:flex-row">
            <Input  type="tel" autoComplete="tel"
                   placeholder="+91 98765 43210" value={phone}
                   onChange={(e) => setPhone(e.target.value)} disabled={busy} />
            <div className="flex gap-2">
              <Button variant="primary" type="submit" disabled={busy}>Send code</Button>
              <Button variant="ghost" type="button" disabled={busy} onClick={cancelPhone}>Cancel</Button>
            </div>
          </form>
        )}
        {phoneMode === 'code' && (
          <form onSubmit={submitCode}>
            <p className="mb-2 text-sm text-ink-muted">
              Enter the 6-digit code sent to {phone.trim() || status.pendingPhone}. It is valid for 5 minutes.
              {devCode && <> (Testing mode &mdash; code: <strong>{devCode}</strong>)</>}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input  inputMode="numeric" pattern="[0-9]*" maxLength={6}
                     placeholder="123456" value={code} style={{ maxWidth: 160 }}
                     onChange={(e) => setCode(e.target.value)} disabled={busy} />
              <div className="flex gap-2">
                <Button variant="primary" type="submit" disabled={busy}>Verify</Button>
                <Button variant="ghost" type="button" disabled={busy} onClick={resendCode}>Resend</Button>
                <Button variant="ghost" type="button" disabled={busy} onClick={cancelPhone}>Cancel</Button>
              </div>
            </div>
          </form>
        )}
        {phoneMode === 'view' && (
          <>
            <div className="mb-2">
              {status.phone
                ? <><span>{status.phone}</span><span className="ml-2"><Badge tone="ok">Verified</Badge></span></>
                : <span className="text-ink-muted">Not set</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" type="button" disabled={busy}
                      onClick={() => { setPhoneMode('edit'); setPhone(''); setRemoving(null); }}>
                {status.phone ? 'Change' : 'Add'}
              </Button>
              {status.phone && (removing === 'phone' ? (
                <>
                  <Button variant="ghost" type="button" className="text-danger" disabled={busy} onClick={doRemovePhone}>
                    Confirm remove
                  </Button>
                  <Button variant="ghost" type="button" disabled={busy} onClick={() => setRemoving(null)}>Keep</Button>
                </>
              ) : (
                <Button variant="ghost" type="button" disabled={busy} onClick={() => setRemoving('phone')}>Remove</Button>
              ))}
            </div>
            {status.phone && (
              <p className="mb-0 mt-2 text-sm text-ink-muted">
                Also used for the sign-in-by-code option on the login screen.
              </p>
            )}
          </>
        )}
      </Row>

      {waysIn === 1 && (
        <p className="mb-0 mt-3 text-sm text-ink-muted">
          You have one way back in. Adding the other means a lost phone or a closed
          mailbox does not lock you out.
        </p>
      )}
    </Card>
  );
}

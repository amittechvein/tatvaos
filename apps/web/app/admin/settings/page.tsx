'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import { Input, Select } from '@/components/ui/Form';

// ============================================================================
//  Platform settings — YZEN Bootstrap, no MUI
// ============================================================================
//
//  Secrets are write-only: the API says whether one is set and never returns
//  it, so this form shows a "set" badge and an empty box. Leaving the box empty
//  keeps the stored value — typing replaces it.
// ============================================================================

interface Setting {
  key: string;
  section: string;
  label: string;
  help: string;
  isSecret: boolean;
  hasValue: boolean;
  value: string | null;
}

const SECTIONS: { id: string; title: string; blurb: string }[] = [
  {
    id: 'sms',
    title: 'SMS (OTP)',
    blurb: 'Signup and sign-in codes send through the primary provider below — Infobip '
      + 'and MSG91 are both supported. The OTP template must exactly match your '
      + 'DLT-registered template — a mismatch is silently dropped by the carrier, not bounced.',
  },
  {
    id: 'sso',
    title: 'Sign-in options (Google)',
    blurb: 'Credentials are stored and ready. The Google sign-in flow itself is the next '
      + 'piece of work — saving keys here does not yet enable the button.',
  },
  {
    id: 'billing',
    title: 'Billing (Razorpay)',
    blurb: 'Stored and ready. Checkout wiring ships with the billing section.',
  },
  {
    id: 'mail',
    title: 'System email',
    blurb: 'OTP codes and invoices send as this address through our own mail server. '
      + 'On testing, everything is captured by Mailpit and reaches nobody.',
  },
];

export default function SettingsPage() {
  const { authedFetch } = useAuth();

  const [items, setItems] = useState<Setting[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);

  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch('/admin/settings');
      if (!res.ok) throw new Error();
      setItems(await res.json());
      setEdits({});
    } catch {
      setNotice({ kind: 'danger', text: 'Could not load settings.' });
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setNotice(null);
    try {
      const res = await authedFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(edits) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setNotice({
        kind: 'success',
        text: body.saved === 0 ? 'Nothing changed.' : `Saved ${body.saved} setting(s). Takes effect immediately.`,
      });
      await load();
    } catch (e) {
      setNotice({ kind: 'danger', text: e instanceof Error ? e.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  async function testSms() {
    setTesting(true); setTestResult(null);
    try {
      const res = await authedFetch('/admin/settings/test-sms', {
        method: 'POST', body: JSON.stringify({ phone: testPhone }),
      });
      const body = await res.json();
      setTestResult(body.sent
        ? `Sent via ${body.provider}. ${body.detail ?? ''}`
        : `Not sent — ${body.detail ?? body.error ?? 'unknown reason'}`);
    } catch {
      setTestResult('Not sent — the request itself failed.');
    } finally {
      setTesting(false);
    }
  }

  const val = (s: Setting) => edits[s.key] ?? s.value ?? '';
  const dirty = Object.keys(edits).length > 0;

  const showOtp = items.find((i) => i.key === 'sms.show_otp_on_screen');
  const showOtpOn = (edits['sms.show_otp_on_screen'] ?? showOtp?.value) === 'true';

  return (
    <AdminShell
      scope="platform"
      title="Settings"
      subtitle="Providers and platform-wide switches"
      actions={
        <Button variant="primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </Button>
      }
    >
      {notice && (
        <div className={`alert alert-${notice.kind} d-flex justify-content-between align-items-center`} role="alert">
          <span>{notice.text}</span>
          <button type="button" className="btn-close" aria-label="Close" onClick={() => setNotice(null)} />
        </div>
      )}

      {showOtpOn && (
        <div className="alert alert-warning" role="alert">
          <strong>Testing mode is on.</strong> When an SMS fails to send, the code is shown in the
          signup screen instead. Turn this off before going live — with it on, the phone check
          proves nothing.
        </div>
      )}

      {loading ? (
        <div className="card custom-card"><div className="card-body text-center py-5">
          <div className="spinner-border text-primary" role="status"><span className="visually-hidden">Loading…</span></div>
        </div></div>
      ) : (
        SECTIONS.map((section) => {
          const fields = items.filter((i) => i.section === section.id);
          if (fields.length === 0) return null;

          return (
            <div className="card custom-card" key={section.id}>
              <div className="card-header">
                <div className="card-title">
                  {section.title}
                  <span className="d-block fs-12 fw-normal text-muted mt-1">{section.blurb}</span>
                </div>
              </div>
              <div className="card-body">
                <div className="row">
                  {fields.map((s) => (
                    <div className="col-md-6 mb-3" key={s.key}>
                      <label className="form-label d-flex align-items-center gap-2">
                        {s.label}
                        {s.isSecret && s.hasValue && <span className="badge bg-success-transparent">set</span>}
                      </label>

                      {s.key === 'sms.provider' ? (
                        <Select value={val(s) || 'auto'}
                                onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}>
                          <option value="auto">Auto — Infobip if configured, else MSG91</option>
                          <option value="infobip">Infobip</option>
                          <option value="msg91">MSG91</option>
                        </Select>
                      ) : s.key === 'sms.show_otp_on_screen' ? (
                        <Select value={val(s) || 'false'}
                                onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}>
                          <option value="false">OFF — send by SMS only (production)</option>
                          <option value="true">ON — show code on screen when SMS fails</option>
                        </Select>
                      ) : (
                        <Input
                          
                          type={s.isSecret ? 'password' : 'text'}
                          value={s.isSecret ? (edits[s.key] ?? '') : val(s)}
                          placeholder={s.isSecret && s.hasValue ? '••••••••  (unchanged)' : undefined}
                          autoComplete="off" spellCheck={false}
                          onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
                        />
                      )}

                      {s.help && <div className="form-text">{s.help}</div>}
                    </div>
                  ))}
                </div>

                {section.id === 'sms' && (
                  <div className="mt-2 pt-3 border-top">
                    <div className="fw-semibold mb-2">Send a test SMS</div>
                    <div className="d-flex gap-2 flex-wrap align-items-start">
                      <Input  style={{ maxWidth: 240 }}
                             placeholder="+91 98765 43210" value={testPhone}
                             onChange={(e) => setTestPhone(e.target.value)} />
                      <button className="btn btn-outline-light" onClick={testSms}
                              disabled={testing || testPhone.replace(/\D/g, '').length < 8}>
                        {testing ? 'Sending…' : 'Send test SMS'}
                      </button>
                    </div>
                    {dirty && (
                      <div className="text-warning fs-12 mt-2">
                        You have unsaved changes — the test uses the saved values. Save first.
                      </div>
                    )}
                    {testResult && (
                      <div className={`alert ${testResult.startsWith('Sent') ? 'alert-success' : 'alert-warning'} mt-2 mb-0`}>
                        {testResult}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </AdminShell>
  );
}

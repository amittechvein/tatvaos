'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import { Input, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

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
        <Alert tone={notice.kind === 'success' ? 'ok' : 'danger'} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {showOtpOn && (
        <Alert tone="warn">
          <strong>Testing mode is on.</strong> When an SMS fails to send, the code is shown in the
          signup screen instead. Turn this off before going live — with it on, the phone check
          proves nothing.
        </Alert>
      )}

      {loading ? (
        <Card>
          <div className="grid place-items-center py-12">
            <span role="status" aria-label="Loading"
                  className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
          </div>
        </Card>
      ) : (
        SECTIONS.map((section) => {
          const fields = items.filter((i) => i.section === section.id);
          if (fields.length === 0) return null;

          return (
            <Card key={section.id} title={section.title} subtitle={section.blurb}
                  className="mb-6">
              <div>
                <div className="grid gap-4 md:grid-cols-2">
                  {fields.map((s) => (
                    <div className="mb-4" key={s.key}>
                      <label className="mb-1 flex items-center gap-2 text-[13px] font-medium text-ink">
                        {s.label}
                        {s.isSecret && s.hasValue && <Badge tone="ok">set</Badge>}
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

                      {s.help && <div className="mt-1 text-xs text-ink-muted">{s.help}</div>}
                    </div>
                  ))}
                </div>

                {section.id === 'sms' && (
                  <div className="mt-2 border-t border-line pt-4">
                    <div className="font-semibold mb-2">Send a test SMS</div>
                    <div className="flex gap-2 flex-wrap items-start">
                      <Input  style={{ maxWidth: 240 }}
                             placeholder="+91 98765 43210" value={testPhone}
                             onChange={(e) => setTestPhone(e.target.value)} />
                      <Button variant="secondary" onClick={testSms}
                              disabled={testing || testPhone.replace(/\D/g, '').length < 8}>
                        {testing ? 'Sending…' : 'Send test SMS'}
                      </Button>
                    </div>
                    {dirty && (
                      <div className="text-warn text-[0.75rem] mt-2">
                        You have unsaved changes — the test uses the saved values. Save first.
                      </div>
                    )}
                    {testResult && (
                      <Alert tone={testResult.startsWith('Sent') ? 'ok' : 'warn'} className="mt-2 mb-0">
                        {testResult}
                      </Alert>
                    )}
                  </div>
                )}
              </div>
            </Card>
          );
        })
      )}
    </AdminShell>
  );
}

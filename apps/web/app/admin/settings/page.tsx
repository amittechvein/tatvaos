'use client';

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Platform settings
// ============================================================================
//
//  Provider credentials, managed from the console because the person rotating
//  an Infobip password is an administrator with a browser, not an operator
//  with SSH.
//
//  Secrets are write-only: the API says whether one is set and never returns
//  it, so this form shows a "set" chip and an empty box. Leaving the box empty
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
    blurb: 'Signup codes send through Infobip once username and password are set. '
      + 'The OTP template must exactly match your DLT-registered template — a mismatch '
      + 'is silently dropped by the carrier, not bounced.',
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
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

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
      setNotice({ kind: 'error', text: 'Could not load settings.' });
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setNotice(null);
    try {
      const res = await authedFetch('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(edits),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setNotice({
        kind: 'success',
        text: body.saved === 0 ? 'Nothing changed.' : `Saved ${body.saved} setting(s). Takes effect immediately.`,
      });
      await load();
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  }

  async function testSms() {
    setTesting(true); setTestResult(null);
    try {
      const res = await authedFetch('/admin/settings/test-sms', {
        method: 'POST',
        body: JSON.stringify({ phone: testPhone }),
      });
      const body = await res.json();
      setTestResult(body.sent
        ? `Sent via ${body.provider}. ${body.detail ?? ''}`
        // The provider's own words. Wrong sender ID, template mismatch and
        // out-of-credit look identical from outside — naming which is the
        // entire value of this button.
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
        <Alert severity={notice.kind} sx={{ mb: 3 }} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {showOtpOn && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>Testing mode is on.</strong> When an SMS fails to send, the code is
          shown in the signup screen instead. Turn this off before going live —
          with it on, the phone check proves nothing.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
      ) : (
        SECTIONS.map((section) => {
          const fields = items.filter((i) => i.section === section.id);
          if (fields.length === 0) return null;

          return (
            <Box key={section.id} sx={{ mb: 3 }}>
            <Card title={section.title} subtitle={section.blurb}>
              <Box sx={{ display: 'grid', gap: 2.5, mb: 1,
                         gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
                {fields.map((s) => (
                  <Box key={s.key}>
                    {s.key === 'sms.show_otp_on_screen' ? (
                      <TextField
                        select fullWidth label={s.label} value={val(s) || 'false'}
                        onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
                        helperText={s.help}
                      >
                        <MenuItem value="false">OFF — send by SMS only (production)</MenuItem>
                        <MenuItem value="true">ON — show code on screen when SMS fails</MenuItem>
                      </TextField>
                    ) : (
                      <TextField
                        fullWidth
                        label={s.label}
                        type={s.isSecret ? 'password' : 'text'}
                        value={s.isSecret ? (edits[s.key] ?? '') : val(s)}
                        placeholder={s.isSecret && s.hasValue ? '••••••••  (unchanged)' : undefined}
                        onChange={(e) => setEdits((p) => ({ ...p, [s.key]: e.target.value }))}
                        helperText={s.help || ' '}
                        slotProps={{
                          input: {
                            endAdornment: s.isSecret && s.hasValue ? (
                              <Chip label="set" size="small" color="success"
                                    variant="outlined" sx={{ mr: 0.5 }} />
                            ) : undefined,
                          },
                          htmlInput: { autoComplete: 'off', spellCheck: false },
                        }}
                      />
                    )}
                  </Box>
                ))}
              </Box>

              {section.id === 'sms' && (
                <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 1.5 }}>
                    Send a test SMS
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <TextField
                      label="Mobile number" size="small" value={testPhone}
                      onChange={(e) => setTestPhone(e.target.value)}
                      placeholder="+91 98765 43210" sx={{ minWidth: 240 }}
                    />
                    <Button variant="secondary" onClick={testSms}
                            disabled={testing || testPhone.replace(/\D/g, '').length < 8}>
                      {testing ? 'Sending…' : 'Send test SMS'}
                    </Button>
                  </Box>
                  {/* Tests use whatever is SAVED, not what is typed above —
                      otherwise a test can pass with credentials that were
                      never stored, which is a lie that surfaces at 2am. */}
                  {dirty && (
                    <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1 }}>
                      You have unsaved changes — the test uses the saved values. Save first.
                    </Typography>
                  )}
                  {testResult && (
                    <Alert severity={testResult.startsWith('Sent') ? 'success' : 'warning'} sx={{ mt: 2 }}>
                      {testResult}
                    </Alert>
                  )}
                </Box>
              )}
            </Card>
            </Box>
          );
        })
      )}
    </AdminShell>
  );
}

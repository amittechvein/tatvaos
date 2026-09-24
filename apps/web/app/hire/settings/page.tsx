'use client';

import { useEffect, useState } from 'react';

import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Field, FormActions, Input } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { useHireAccess } from '../HireAccess';

// ============================================================================
//  Hire settings — today, only how long rejected candidates are kept.
//
//  Amit, 24 September 2026: six months after the decision by default; an
//  organisation may shorten it (never below 30 days, so a slip cannot erase
//  last week's candidates tonight); longer only with each candidate's own
//  consent. Deletion is automatic. The page says all of that in plain words,
//  because an administrator changing it is deciding when people's data goes.
// ============================================================================

interface Settings { retentionDays: number; minDays: number; maxDays: number }

export default function HireSettingsPage() {
  const { authedFetch } = useAuth();
  const me = useHireAccess();
  const [s, setS] = useState<Settings | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (me.access !== 'admin') return;
    void (async () => {
      const res = await authedFetch('/hire/settings');
      if (!res.ok) { setError('Could not load the settings.'); return; }
      const body: Settings = await res.json();
      setS(body);
      setDays(String(body.retentionDays));
    })();
  }, [authedFetch, me.access]);

  if (me.access !== 'admin') {
    return (
      <>
        <PageHeader title="Hire settings" />
        <Alert tone="info">Only an administrator can see and change Hire settings.</Alert>
      </>
    );
  }
  if (!s) return error ? <Alert tone="danger">{error}</Alert> : <Spinner />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authedFetch('/hire/settings', { method: 'PUT', body: JSON.stringify({ retentionDays: Number(days) }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setS({ ...s!, retentionDays: body.retentionDays });
      setNotice('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const n = Number(days);
  const months = Number.isFinite(n) && n > 0 ? Math.round(n / 30) : null;

  return (
    <>
      <PageHeader title="Hire settings" subtitle="How long candidates' data is kept" />
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card title="Keeping candidates' data" className="mb-5">
        <p className="mb-3 text-[0.8125rem] text-ink-muted">
          When every application of a candidate has been rejected or withdrawn, TatvaOS deletes the
          candidate — their details, applications and history — automatically once this period has
          passed since the last decision. Someone added but never put forward for a job is deleted
          once their profile has been untouched for the same period. Deleted candidates cannot be
          recovered; the audit trail records only how many were deleted.
        </p>
        <p className="mb-4 text-[0.8125rem] text-ink-muted">
          The longest period is {s.maxDays} days (six months). You can shorten it, down to {s.minDays} days.
          Keeping someone longer needs that candidate&apos;s own consent, which will be asked for on the
          careers page.
        </p>
        <form onSubmit={save} noValidate>
          <Field label="Keep for (days after the decision)"
                 hint={months ? `About ${months} month${months === 1 ? '' : 's'}.` : undefined}>
            {(p) => <Input {...p} type="number" min={s.minDays} max={s.maxDays} value={days}
                           onChange={(e) => setDays(e.target.value)} className="max-w-[10rem]" />}
          </Field>
          <FormActions>
            <Button type="submit" variant="primary" disabled={busy || String(s.retentionDays) === days}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </FormActions>
        </form>
      </Card>

      <Card title="Requests to delete data">
        <p className="mb-0 text-[0.8125rem] text-ink-muted">
          If a candidate asks for their data to be deleted, your organisation&apos;s owner answers
          within 30 days, unless you name someone else. Erase them from their page under Candidates.
        </p>
      </Card>
    </>
  );
}

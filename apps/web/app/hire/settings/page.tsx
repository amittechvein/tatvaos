'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Field, FormActions, Input } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { useHireAccess } from '../HireAccess';

// ============================================================================
//  Hire settings — how long candidates' data is kept.
//
//  Amit, 24 September 2026: six months after the decision by default; an
//  organisation may shorten it (never below 30 days); longer only with each
//  candidate's own consent. Deletion is automatic.
//
//  Mr. Singh, 24 September 2026: shortening destroys data, so
//    * the page states HOW MANY candidates it will delete, and the API will
//      not schedule it until that exact number is confirmed;
//    * a shorter period waits SEVEN DAYS, shown here with its date and a
//      Cancel button the whole time — "a delay nobody can see or stop is just
//      a slower accident".
//  Lengthening is the safe direction and applies at once.
// ============================================================================

interface Pending { days: number; effectiveAt: string; requestedBy: string | null; requestedAt: string }
// sweepOn: whether the sweep deletes anyone at all (platform setting
// hire.retention_sweep_enabled; Mr. Singh, 2 Oct 2026: off until a lawyer has
// confirmed the periods). While it is off, nothing on this page may say
// TatvaOS deletes anyone, or name a date on which it will.
interface Settings { retentionDays: number; minDays: number; maxDays: number; sweepOn: boolean; pending: Pending | null }
interface Confirm { days: number; deletes: number; effectiveAt: string }

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

export default function HireSettingsPage() {
  const { authedFetch } = useAuth();
  const me = useHireAccess();
  const [s, setS] = useState<Settings | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const load = useCallback(async () => {
    const res = await authedFetch('/hire/settings');
    if (!res.ok) { setError('Could not load the settings.'); return; }
    const body: Settings = await res.json();
    setS(body);
    setDays(String(body.retentionDays));
  }, [authedFetch]);

  useEffect(() => {
    if (me.access === 'admin') void load();
  }, [load, me.access]);

  if (me.access !== 'admin') {
    return (
      <>
        <PageHeader title="Hire settings" />
        <Alert tone="info">Only an administrator can see and change Hire settings.</Alert>
      </>
    );
  }
  if (!s) return error ? <Alert tone="danger">{error}</Alert> : <Spinner />;

  async function put(n: number, confirmDeletes?: number) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authedFetch('/hire/settings', {
        method: 'PUT', body: JSON.stringify({ retentionDays: n, confirmDeletes }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.needsConfirmation) {
        setConfirm({ days: n, deletes: body.deletes, effectiveAt: body.effectiveAt });
        return;
      }
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setConfirm(null);
      setNotice(body.pending
        ? `Scheduled: ${body.pending.days} days from ${fmt(body.pending.effectiveAt)}. You can cancel until then.`
        : 'Saved.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelPending() {
    setBusy(true);
    setError(null);
    const res = await authedFetch('/hire/settings/pending', { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) { setError('Could not cancel.'); return; }
    setNotice('Cancelled. The period stays as it is.');
    await load();
  }

  const n = Number(days);
  const months = Number.isFinite(n) && n > 0 ? Math.round(n / 30) : null;

  return (
    <>
      <PageHeader title="Hire settings" subtitle="How long candidates' data is kept" />
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {s.pending && (
        <Alert tone="warn" title={`Shortening to ${s.pending.days} days on ${fmt(s.pending.effectiveAt)}`}
               action={<Button size="sm" onClick={() => void cancelPending()} disabled={busy}>Cancel</Button>}>
          Requested{s.pending.requestedBy ? ` by ${s.pending.requestedBy}` : ''} on {fmt(s.pending.requestedAt)}.
          Until that date, candidates are kept for {s.retentionDays} days.
        </Alert>
      )}

      {!s.sweepOn && (
        <Alert tone="warn" title="Automatic deletion is not switched on yet">
          Until it is, TatvaOS deletes nobody automatically: candidates are kept until you erase them
          from their page under Candidates. The period you set here is kept, and applies from the day
          automatic deletion is switched on.
        </Alert>
      )}

      <Card title="Keeping candidates' data" className="mb-5">
        <p className="mb-3 text-[0.8125rem] text-ink-muted">
          {s.sweepOn ? '' : 'Once automatic deletion is switched on: '}When every application of a candidate has been rejected or withdrawn, TatvaOS deletes the
          candidate — their details, applications and history — automatically once this period has
          passed since the last decision. Someone added but never put forward for a job is deleted
          once nobody has edited their profile for the same period; looking at it does not count.
          Deleted candidates cannot be recovered; the audit trail records how many were deleted, when
          and under which period — never who.
        </p>
        <p className="mb-4 text-[0.8125rem] text-ink-muted">
          The longest period is {s.maxDays} days (six months). You can shorten it, down to {s.minDays} days;
          a shorter period starts seven days after you save it, and you can cancel it until then.
          Keeping someone longer needs that candidate&apos;s own consent.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); void put(n); }} noValidate>
          <Field label="Keep for (days after the decision)"
                 hint={months ? `About ${months} month${months === 1 ? '' : 's'}.` : undefined}>
            {(p) => <Input {...p} type="number" min={s.minDays} max={s.maxDays} value={days}
                           onChange={(e) => setDays(e.target.value)} className="max-w-[10rem]" />}
          </Field>
          <FormActions>
            <Button type="submit" variant="primary" disabled={busy || String(s.retentionDays) === days}>
              {busy ? 'Checking…' : 'Save'}
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

      {confirm && (
        <Modal
          title={confirm.deletes === 0 ? `Shorten to ${confirm.days} days?` : `This will delete ${confirm.deletes} candidate${confirm.deletes === 1 ? '' : 's'}`}
          busy={busy}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>Keep {s.retentionDays} days</Button>
              <Button variant={confirm.deletes > 0 ? 'danger' : 'primary'} disabled={busy}
                      onClick={() => void put(confirm.days, confirm.deletes)}>
                {confirm.deletes > 0 && s.sweepOn ? `Delete ${confirm.deletes} on ${fmt(confirm.effectiveAt)}` : 'Shorten'}
              </Button>
            </>
          }
        >
          <p className="text-[0.8125rem] text-ink-muted">
            {confirm.deletes > 0 && !s.sweepOn
              ? `Shortening to ${confirm.days} days means ${confirm.deletes} candidate${confirm.deletes === 1 ? '' : 's'} who would otherwise be kept longer will be deleted for good, with their applications and history, once automatic deletion is switched on — and not before ${fmt(confirm.effectiveAt)}.`
              : confirm.deletes > 0
              ? `Shortening to ${confirm.days} days means ${confirm.deletes} candidate${confirm.deletes === 1 ? '' : 's'} who would otherwise be kept longer will be deleted for good on ${fmt(confirm.effectiveAt)}, with their applications and history.`
              : `Nobody who would otherwise be kept will be deleted when this starts on ${fmt(confirm.effectiveAt)}.`}
          </p>
          <p className="mb-0 text-[0.8125rem] text-ink-muted">
            It starts in seven days. Until then it is shown on this page and you can cancel it.
          </p>
        </Modal>
      )}
    </>
  );
}

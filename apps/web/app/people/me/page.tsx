'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Spinner, Table, Td } from '@/components/ui/Kit';
import { Field, Modal } from '@/components/ui/Modal';
import { Select, Textarea } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { FIELD_LABEL } from '../_components/fields';
import { STATUS_LABEL, TYPE_LABEL, usePeopleAccess, type Employee } from '../PeopleAccess';

interface MyRecord {
  id: string;
  employeeCode: string;
  fullName: string;
  workEmail: string | null;
  employmentType: Employee['employmentType'];
  status: Employee['status'];
  joinedOn: string;
  exitOn: string | null;
  department: string | null;
  designation: string | null;
  location: string | null;
  manager: string | null;
}

interface Correction {
  id: string;
  field: string;
  requested: string;
  status: 'open' | 'done' | 'declined';
  response: string | null;
  createdAt: string;
  handledAt: string | null;
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

// ============================================================================
//  My record — your own employee record, and asking People HR to correct it.
//
//  WHAT IT PROMISES, CHECKED AGAINST THE CODE:
//    * "Only People HR can change your record" — the employee endpoints refuse
//      every write from anyone not in people.hr_members;
//    * "HR will tell you if they decline, and why" — a decline without a reason
//      is refused by the API and by the database (ck_correction_decline_reason);
//    * a request is always about YOUR record — the API takes the employee from
//      your sign-in, not from anything this page sends.
// ============================================================================
export default function MyRecordPage() {
  const { authedFetch } = useAuth();
  const { reload } = usePeopleAccess();
  const [rec, setRec] = useState<MyRecord | null | 'none'>(null);
  const [mine, setMine] = useState<Correction[]>([]);
  const [asking, setAsking] = useState(false);
  const [field, setField] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await authedFetch('/people/me/record');
    setRec(r.ok ? await r.json() : 'none');
    const c = await authedFetch('/people/me/corrections');
    if (c.ok) setMine(await c.json());
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch('/people/me/corrections', { method: 'POST', body: JSON.stringify({ field, requested: text }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not send your request.');
      setAsking(false);
      setField('');
      setText('');
      await load();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your request.');
    } finally {
      setBusy(false);
    }
  }

  if (rec === null) return <Spinner />;
  if (rec === 'none')
    return (
      <>
        <PageHeader title="My record" />
        <Alert tone="info">You have no employee record here yet. People HR adds it.</Alert>
      </>
    );

  const left = rec.status === 'exited';
  const row = (label: string, value: React.ReactNode) => (
    <div><dt className="text-ink-muted">{label}</dt><dd>{value ?? '—'}</dd></div>
  );

  return (
    <>
      <PageHeader
        title="My record"
        subtitle={`${rec.employeeCode} · ${TYPE_LABEL[rec.employmentType]}`}
        actions={left ? undefined : <Button variant="primary" onClick={() => setAsking(true)}>Ask HR to correct something</Button>}
      />
      {error && !asking && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <Alert tone="info">
        Only People HR can change your record. If something here is wrong, ask them — they will tell you when it is
        done, or why not.
      </Alert>

      <Card title={rec.fullName} className="mb-5">
        <dl className="grid gap-x-6 gap-y-3 text-[0.8125rem] sm:grid-cols-2">
          {row('Status', <Badge tone={rec.status === 'active' ? 'ok' : rec.status === 'on_notice' ? 'warn' : 'neutral'}>{STATUS_LABEL[rec.status]}</Badge>)}
          {row('Work email', rec.workEmail)}
          {row('Designation', rec.designation)}
          {row('Department', rec.department)}
          {row('Location', rec.location)}
          {row('Reports to', rec.manager ?? 'Nobody')}
          {row('Joined on', fmt(rec.joinedOn))}
          {rec.exitOn && row('Last day', fmt(rec.exitOn))}
        </dl>
      </Card>

      <Card title="My requests to HR" padded={false}>
        {mine.length === 0 ? (
          <p className="p-4 text-[0.8125rem] text-ink-muted">You have not asked for any corrections.</p>
        ) : (
          <Table head={['Sent', 'About', 'What I asked', 'Answer']}>
            {mine.map((c) => (
              <tr key={c.id}>
                <Td>{fmt(c.createdAt)}</Td>
                <Td>{FIELD_LABEL[c.field] ?? c.field}</Td>
                <Td className="whitespace-pre-wrap">{c.requested}</Td>
                <Td>
                  <Badge tone={c.status === 'open' ? 'info' : c.status === 'done' ? 'ok' : 'neutral'}>
                    {c.status === 'open' ? 'Waiting for HR' : c.status === 'done' ? 'Done' : 'Declined'}
                  </Badge>
                  {c.response && <div className="mt-1 text-xs text-ink-muted whitespace-pre-wrap">{c.response}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {asking && (
        <Modal title="Ask HR to correct your record" onClose={() => setAsking(false)} busy={busy}
               footer={<>
                 <Button variant="ghost" onClick={() => setAsking(false)} disabled={busy}>Cancel</Button>
                 <Button variant="primary" onClick={() => void ask()} disabled={busy || !field || !text.trim()}>Send to HR</Button>
               </>}>
          {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
          <Field label="What is wrong" required>
            <Select aria-label="What is wrong" value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">Choose…</option>
              {Object.entries(FIELD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="What it should be" required hint="Up to 500 characters. HR sees this.">
            <Textarea aria-label="What it should be" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={3} />
          </Field>
        </Modal>
      )}
    </>
  );
}
